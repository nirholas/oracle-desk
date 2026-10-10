// Wires the desk together: one bus, one ledger, six desks and a head, the
// Oracle client, the venue, and a broker. State is written to disk so a restart
// picks up the same book, seats, and history.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bus } from './bus.js';
import { Ledger, lamports, sol } from './ledger.js';
import { OracleClient } from './oracle.js';
import { PumpVenue } from './chain/pump.js';
import { Firewall } from './chain/firewall.js';
import { loadKeypair } from './chain/wallet.js';
import { LiveBroker, PaperBroker } from './brokers.js';
import { Radar } from './desks/radar.js';
import { Research } from './desks/research.js';
import { Risk } from './desks/risk.js';
import { Execution } from './desks/execution.js';
import { Audit } from './desks/audit.js';
import { Treasury } from './desks/treasury.js';
import { Head } from './desks/head.js';
import { Memo } from './memo.js';
import { gradeSeat } from './seats.js';
import { LIVE_ACK } from './config.js';

const TICK_MS = 15_000;
const LIVE_BALANCE_SYNC_MS = 30_000;

export function statePath(config) {
	return join(config.dataDir, `desk-${config.mode}.json`);
}

export function readState(config) {
	const path = statePath(config);
	if (!existsSync(path)) return {};
	return JSON.parse(readFileSync(path, 'utf8'));
}

export class Desk {
	constructor(config, { reset = false } = {}) {
		this.config = config;
		const state = reset ? {} : readState(config);
		this.startedAt = Date.now();
		this.bus = new Bus();
		if (state.log) this.bus.log = state.log;
		this.bus.seq = this.bus.log.at(-1)?.id ?? 0;

		this.counters = { launches: 0, graduations: 0, verdicts: 0, cleared: 0, blocked: 0, firewalled: 0, entries: 0, closed: 0, ...(state.counters || {}) };
		this.ledger = new Ledger(state.ledger);
		this.oracle = new OracleClient({ base: config.oracleBase });
		this.venue = new PumpVenue({ rpcUrl: config.rpcUrl });
		this.firewall = new Firewall({ venue: this.venue, connection: this.venue.connection });

		const slippagePct = config.desk.risk.slippage_pct;
		if (config.mode === 'live') {
			if (!config.liveAck) throw new Error(`live mode needs DESK_LIVE_ACK=${LIVE_ACK}`);
			const keypair = loadKeypair(config);
			if (!keypair) throw new Error('live mode needs SOLANA_PRIVATE_KEY or DESK_KEYPAIR');
			this.broker = new LiveBroker({ venue: this.venue, keypair, slippagePct, coldWallet: config.coldWallet });
		} else {
			this.broker = new PaperBroker({ venue: this.venue, ledger: this.ledger, slippagePct });
		}

		const desk = config.desk;
		this.research = new Research({ bus: this.bus, config: desk, counters: this.counters, state: state.research || {} });
		this.risk = new Risk({ bus: this.bus, config: desk, ledger: this.ledger, state: state.risk || {} });
		this.execution = new Execution({ bus: this.bus, config: desk, ledger: this.ledger, risk: this.risk, broker: this.broker, firewall: this.firewall, venue: this.venue, counters: this.counters });
		this.audit = new Audit({ bus: this.bus, research: this.research, state: state.audit || {} });
		this.treasury = new Treasury({ bus: this.bus, config: desk, ledger: this.ledger, risk: this.risk, broker: this.broker, state: state.treasury || {} });
		this.memo = new Memo({ apiKey: config.anthropicKey });
		this.head = new Head({ bus: this.bus, config: desk, research: this.research, audit: this.audit, ledger: this.ledger, memo: this.memo, state: state.head || {} });
		this.radar = new Radar({ bus: this.bus, oracle: this.oracle, config: desk, counters: this.counters });

		this.bus.on('verdict', (coin) => this.research.onVerdict(coin));
		this.bus.on('candidate', (c) => this.execution.onCandidate(c));
		this.bus.on('closed', (trade) => this.audit.onClosed(trade));
		this.bus.on('graduated', (mint) => this.venue.markGraduated(mint));

		this.model = null;
		this.timers = [];
	}

	async start() {
		if (this.broker.mode === 'live') {
			const balance = await this.broker.balance();
			this.ledger.walletLamports = balance;
			if (!this.ledger.startLamports) this.ledger.startLamports = balance;
			this.bus.note('SYSTEM', 'DESK', `LIVE on ${this.broker.payer.toBase58()} with ${sol(balance).toFixed(4)} SOL`, { kind: 'boot' });
		} else {
			if (!this.ledger.startLamports) {
				this.ledger.startLamports = lamports(this.config.paperSol);
				this.ledger.walletLamports = this.ledger.startLamports;
			}
			this.bus.note('SYSTEM', 'DESK', `PAPER with ${sol(this.ledger.walletLamports).toFixed(4)} SOL: real launches, real quotes, nothing signed`, { kind: 'boot' });
		}

		try {
			this.model = await this.oracle.loadModel();
			const perf = this.model.performance();
			this.bus.note('SYSTEM', 'ORACLE', `conviction model v${this.model.version} loaded: ${this.model.trainingRows.toLocaleString()} labeled launches, held-out AUC ${perf?.auc ?? 'n/a'}`);
		} catch (err) {
			this.bus.note('SYSTEM', 'ORACLE', `model card unavailable (${err.message}); verdicts still stream`, { level: 'warn' });
		}

		this.radar.start();
		this.execution.start();
		this.timers.push(setInterval(() => this.tick(), TICK_MS));
		if (this.broker.mode === 'live') this.timers.push(setInterval(() => this.syncBalance(), LIVE_BALANCE_SYNC_MS));
	}

	async tick(now = Date.now()) {
		this.treasury.guard();
		await this.treasury.maybeSweep(now);
		if (this.head.due(now)) await this.head.review(now);
		this.save();
	}

	async syncBalance() {
		try {
			this.ledger.walletLamports = await this.broker.balance();
		} catch (err) {
			this.bus.note('SYSTEM', 'DESK', `balance read failed: ${err.message}`, { level: 'warn' });
		}
	}

	async stop() {
		for (const t of this.timers) clearInterval(t);
		this.radar.stop();
		this.execution.stop();
		this.save();
	}

	save() {
		mkdirSync(this.config.dataDir, { recursive: true });
		const path = statePath(this.config);
		const body = JSON.stringify({
			version: 1,
			saved_at: Date.now(),
			mode: this.config.mode,
			counters: this.counters,
			ledger: this.ledger,
			research: this.research,
			risk: this.risk,
			audit: this.audit,
			treasury: this.treasury,
			head: this.head,
			log: this.bus.log.slice(-200),
		});
		writeFileSync(`${path}.tmp`, body);
		renameSync(`${path}.tmp`, path);
	}

	/** Probability the Oracle's model assigns to "runs and holds" for a score. */
	pWin(score) {
		if (!this.model || score == null) return null;
		return Number(this.model.probabilityFromScore(score).toFixed(4));
	}

	snapshot() {
		const l = this.ledger;
		const held = Object.values(l.positions).filter((p) => p.status !== 'closed');
		const perf = this.model?.performance?.() || null;
		return {
			mode: this.broker.mode,
			address: this.broker.payer?.toBase58?.() || null,
			started_at: this.startedAt,
			now: Date.now(),
			memo_enabled: this.memo.enabled,
			wallet: {
				start_sol: sol(l.startLamports),
				wallet_sol: sol(l.walletLamports),
				mark_sol: sol(l.markLamports()),
				vault_sol: sol(l.vaultLamports),
				equity_sol: sol(l.hotEquity() + l.vaultLamports),
				net_sol: sol(l.netLamports()),
				realized_today_sol: sol(l.realizedToday(Date.now())),
			},
			record: {
				trades: l.trades.length,
				wins: l.trades.filter((t) => t.pnl_lamports > 0).length,
				losses: l.trades.filter((t) => t.pnl_lamports <= 0).length,
			},
			counters: this.counters,
			killed_by: this.research.killedBy,
			radar: Object.values(this.radar.agents),
			seats: this.research.seats.map((seat) => ({ ...seat, grade: gradeSeat(this.head.seatTrades(seat)) })),
			risk: this.risk.describe(),
			execution: Object.values(this.execution.agents),
			audit: { agents: Object.values(this.audit.agents), revisions: this.audit.revisions.slice(-40).reverse() },
			treasury: { agent: this.treasury.agent, sweeps: this.treasury.sweeps.slice(-10).reverse(), frozen: this.risk.frozen, next_sweep_at: this.treasury.lastSweep + this.config.desk.treasury.sweep_every_minutes * 60_000 },
			head: {
				decisions: this.head.decisions.slice(-30).reverse(),
				memos: this.head.memos.slice(-5).reverse(),
				firings: this.head.firings,
				next_review_at: this.head.lastReview + this.config.desk.head.review_every_minutes * 60_000,
			},
			positions: held.map((p) => ({
				id: p.id,
				mint: p.mint,
				symbol: p.symbol,
				image: p.coin?.image_uri || null,
				seat: p.seat,
				status: p.status,
				venue: p.venue,
				opened_at: p.opened_at,
				cost_sol: sol(p.cost_lamports),
				value_sol: sol(p.value_lamports),
				proceeds_sol: sol(p.proceeds_lamports),
				multiple: p.cost_lamports ? (p.value_lamports + p.proceeds_lamports) / p.cost_lamports : 0,
				peak_multiple: p.entry_lamports ? p.peak_lamports / p.entry_lamports : 0,
				initials_recovered: p.initials_recovered,
				score: p.coin?.score ?? null,
				tier: p.coin?.tier ?? null,
				p_win: this.pWin(p.coin?.score),
				mark_error: p.mark_error || null,
				sig: p.fills?.[0]?.sig || null,
			})),
			trades: l.trades.slice(-60).reverse().map((t) => ({
				id: t.id,
				mint: t.mint,
				symbol: t.symbol,
				seat: t.seat,
				opened_at: t.opened_at,
				closed_at: t.closed_at,
				cost_sol: sol(t.cost_lamports),
				pnl_sol: sol(t.pnl_lamports),
				multiple: t.multiple,
				reason: t.reason,
				kept_bag: t.kept_bag,
				score: t.coin?.score ?? null,
				tier: t.coin?.tier ?? null,
			})),
			recent_clears: this.research.lastPass,
			model: this.model
				? {
						version: this.model.version,
						fitted_at: this.model.fittedAt,
						training_rows: this.model.trainingRows,
						auc: perf?.auc ?? null,
						base_rate: perf?.base_rate ?? null,
					}
				: null,
			log: this.bus.log.slice(-150),
		};
	}
}
