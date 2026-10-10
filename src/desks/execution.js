// Desk 3: EXECUTION. Only ever sees coins research already cleared, and only
// acts when risk allows it.
//
//   SNIPER  sizes, quotes, runs the firewall, and takes the fill
//   ROUTER  picks the venue (bonding curve or PumpSwap pool) for every trade
//   LADDER  marks every holding on a timer and works the exits
//
// Paper and live run this same code; the broker decides whether a transaction
// is signed.

import { decideLadderedExit, decideLiquidityDecay, updateStaleClock } from '../exit-logic.js';
import { lamports, sol } from '../ledger.js';

const DUST_LAMPORTS = 100_000;

function agent(name) {
	return { name, desk: 'EXECUTION', status: 'idle', fills: 0, failures: 0, last_ms: null, last_at: null };
}

export class Execution {
	constructor({ bus, config, ledger, risk, broker, firewall, venue, counters }) {
		this.bus = bus;
		this.cfg = config;
		this.ledger = ledger;
		this.risk = risk;
		this.broker = broker;
		this.firewall = firewall;
		this.venue = venue;
		this.counters = counters;
		this.pending = new Set();
		this.selling = new Set();
		this.sweeping = false;
		this.timer = null;
		this.agents = { SNIPER: agent('SNIPER'), ROUTER: agent('ROUTER'), LADDER: agent('LADDER') };
	}

	start() {
		const every = (this.cfg.exits.sweep_every_seconds ?? 5) * 1000;
		this.timer = setInterval(() => this.sweep(), every);
		this.agents.LADDER.status = 'live';
		this.agents.SNIPER.status = 'live';
		this.agents.ROUTER.status = 'live';
	}

	stop() {
		clearInterval(this.timer);
	}

	exitPlan() {
		const x = this.cfg.exits;
		return {
			stop_loss_pct: x.stop_loss_pct,
			trailing_stop_pct: x.trailing_stop_pct,
			take_profit_pct: x.take_profit_pct,
			initials_out_multiple: x.initials_out_multiple,
			moonbag_min_pct: x.moonbag_min_pct,
			max_hold_seconds: x.max_hold_minutes != null ? x.max_hold_minutes * 60 : null,
		};
	}

	async onCandidate({ coin, seat }) {
		const label = coin.symbol || coin.mint.slice(0, 6);
		if (this.pending.has(coin.mint)) return;
		const openCount = this.ledger.open().length + this.pending.size;
		const refusal = this.risk.refusal(coin.mint) || (openCount >= this.risk.cfg.max_open_positions ? 'open-position cap' : null);
		if (refusal) {
			this.counters.blocked += 1;
			this.risk.block(refusal, coin);
			return;
		}
		const size = this.risk.sizeFor(seat);
		if (!size) {
			this.counters.blocked += 1;
			this.risk.block('wallet below reserve', coin);
			return;
		}

		this.pending.add(coin.mint);
		const sniper = this.agents.SNIPER;
		const started = Date.now();
		try {
			const quote = await this.broker.quoteEntry(coin.mint, size);
			this.agents.ROUTER.last_at = Date.now();
			// Price impact on a PumpSwap pool counts virtual boost depth. A pool can
			// quote 2% impact while holding a fraction of a SOL a seller can be
			// paid from, so graduated entries also need real SOL in the vault.
			const minPool = lamports(this.cfg.risk.min_pool_real_sol ?? 0);
			if (quote.venue === 'amm' && quote.realQuoteLamports != null && quote.realQuoteLamports < BigInt(minPool)) {
				this.counters.blocked += 1;
				this.risk.block('thin pool', coin, `pool holds only ${sol(Number(quote.realQuoteLamports)).toFixed(2)} real SOL`);
				return;
			}
			if (quote.priceImpactPct > this.cfg.risk.max_price_impact_pct) {
				this.counters.blocked += 1;
				this.risk.block('price impact', coin, `price impact ${quote.priceImpactPct.toFixed(1)}%`);
				return;
			}
			const balance = this.broker.payer ? await this.broker.balance() : null;
			const wall = await this.firewall.assess({
				mint: coin.mint,
				payer: this.broker.payer,
				entryLamports: size,
				balanceLamports: balance,
				mayhem: quote.mayhem,
			});
			if (!wall.ok) {
				const failed = wall.results.find((r) => r.status === 'fail');
				this.counters.firewalled += 1;
				this.bus.note('EXECUTION', 'SNIPER', `firewall refused ${label}: ${failed.reason}`, { mint: coin.mint, level: 'warn' });
				return;
			}

			const fill = await this.broker.buy(coin.mint, size, quote);
			const position = this.ledger.recordEntry({
				mint: coin.mint,
				symbol: coin.symbol,
				seat: seat.id,
				agent: 'SNIPER',
				costLamports: fill.costLamports,
				tokens: fill.tokens,
				coin,
				exits: this.exitPlan(),
				sig: fill.sig,
				venue: fill.venue,
				now: Date.now(),
			});
			position.firewall = wall.results;
			sniper.fills += 1;
			sniper.last_ms = Date.now() - started;
			sniper.last_at = Date.now();
			this.counters.entries += 1;
			this.bus.note(
				'EXECUTION',
				'SNIPER',
				`bought ${label} for ${sol(fill.costLamports).toFixed(4)} SOL on the ${fill.venue === 'amm' ? 'PumpSwap pool' : 'curve'} (${seat.id}, score ${coin.score})`,
				{ mint: coin.mint, sig: fill.sig, kind: 'entry' },
			);
			await this.bus.publish('entry', { position, seat });
		} catch (err) {
			sniper.failures += 1;
			this.bus.note('EXECUTION', 'SNIPER', `entry on ${label} failed: ${err.message}`, { mint: coin.mint, level: 'error', sig: err.signature });
		} finally {
			this.pending.delete(coin.mint);
		}
	}

	/** Mark every holding and work the exits. One sweep at a time. */
	async sweep(now = Date.now()) {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			const held = [...this.ledger.open(), ...this.ledger.bags()];
			await Promise.all(held.map((p) => this.work(p, now)));
			this.agents.LADDER.last_at = Date.now();
		} finally {
			this.sweeping = false;
		}
	}

	async work(p, now) {
		if (this.selling.has(p.mint)) return;
		let value;
		try {
			value = await this.broker.mark(p.mint, p.tokens);
		} catch (err) {
			p.mark_error = err.message.slice(0, 120);
			return;
		}
		p.mark_error = null;
		p.marked_at = now;
		p.stale_since = updateStaleClock(p.prev_value, value, p.entry_lamports, p.stale_since, now);
		p.prev_value = value;
		p.value_lamports = value;
		p.peak_lamports = Math.max(p.peak_lamports, value);

		if (p.status === 'bag') {
			if (value < DUST_LAMPORTS) {
				p.status = 'closed';
				p.value_lamports = 0;
				this.bus.note('EXECUTION', 'LADDER', `${p.symbol || p.mint.slice(0, 6)} bag faded to dust and was written off`, { mint: p.mint });
			}
			return;
		}

		if (decideLiquidityDecay(p.stale_since, this.cfg.exits.liquidity_decay_seconds, now)) {
			return this.exit(p, { reason: 'dead_liquidity', sellFraction: 1 }, now);
		}
		const decision = decideLadderedExit(p, value, p.peak_lamports, now);
		if (decision) await this.exit(p, decision, now);
	}

	async exit(p, decision, now = Date.now()) {
		const ladder = this.agents.LADDER;
		const label = p.symbol || p.mint.slice(0, 6);
		const total = BigInt(p.tokens);
		const amount = decision.sellFraction >= 1 ? total : (total * BigInt(Math.floor(decision.sellFraction * 1e6))) / 1_000_000n;
		if (amount <= 0n) return;
		this.selling.add(p.mint);
		try {
			const fill = await this.broker.sell(p.mint, amount, { closeAccount: amount === total });
			const trade = this.ledger.recordExit(p.mint, {
				soldTokens: fill.soldTokens,
				proceedsLamports: fill.proceedsLamports,
				reason: decision.reason,
				sig: fill.sig,
				now,
				keepsMoonbag: decision.keepsMoonbag,
				recoversInitials: decision.recoversInitials,
			});
			ladder.fills += 1;
			ladder.last_at = Date.now();
			const pctSold = Math.round(Number(amount * 100n) / Number(total || 1n));
			this.bus.note(
				'EXECUTION',
				'LADDER',
				`${decision.reason.replace(/_/g, ' ')} on ${label}: sold ${pctSold}% for ${sol(fill.proceedsLamports).toFixed(4)} SOL`,
				{ mint: p.mint, sig: fill.sig, kind: 'exit' },
			);
			if (trade) {
				this.counters.closed += 1;
				await this.bus.publish('closed', trade);
			}
		} catch (err) {
			ladder.failures += 1;
			this.bus.note('EXECUTION', 'LADDER', `exit on ${label} failed, retrying next sweep: ${err.message}`, { mint: p.mint, level: 'error', sig: err.signature });
		} finally {
			this.selling.delete(p.mint);
		}
	}

	/** Operator action: sell everything left in one position, bag included. */
	async close(mint) {
		const p = this.ledger.positions[mint];
		if (!p || p.status === 'closed') throw new Error('no such position');
		await this.exit(p, { reason: 'manual', sellFraction: 1 });
	}
}
