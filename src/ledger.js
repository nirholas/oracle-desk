// The book. Every lamport the desk commits or recovers passes through here, in
// both modes, so paper and live P&L are computed by the same code.
//
// Lifecycle of a position:
//   open  -> the stake is at risk; counts against the risk desk's slots
//   bag   -> the stake-bearing part closed (graded by audit); what is left is
//            house money riding, marked to market, outside the slots
//   closed-> nothing left
//
// Amounts: SOL in lamports (Number; safe well past any wallet this desk runs),
// token amounts as decimal strings of base units.

export const LAMPORTS_PER_SOL = 1_000_000_000;
export const sol = (lamports) => Number(lamports || 0) / LAMPORTS_PER_SOL;
export const lamports = (s) => Math.round(Number(s || 0) * LAMPORTS_PER_SOL);

const DAY_MS = 86_400_000;

export function dayKey(t) {
	return new Date(t).toISOString().slice(0, 10);
}

export class Ledger {
	constructor(state = {}) {
		this.startLamports = state.startLamports ?? 0;
		this.walletLamports = state.walletLamports ?? 0;
		this.vaultLamports = state.vaultLamports ?? 0;
		this.positions = state.positions ?? {};
		this.trades = state.trades ?? [];
		this.realizedByDay = state.realizedByDay ?? {};
		this.entryTimes = state.entryTimes ?? [];
		this.seq = state.seq ?? 0;
	}

	toJSON() {
		return {
			startLamports: this.startLamports,
			walletLamports: this.walletLamports,
			vaultLamports: this.vaultLamports,
			positions: this.positions,
			trades: this.trades.slice(-500),
			realizedByDay: this.realizedByDay,
			entryTimes: this.entryTimes,
			seq: this.seq,
		};
	}

	open() {
		return Object.values(this.positions).filter((p) => p.status === 'open');
	}

	bags() {
		return Object.values(this.positions).filter((p) => p.status === 'bag');
	}

	holding(mint) {
		const p = this.positions[mint];
		return Boolean(p && p.status !== 'closed');
	}

	entriesSince(t) {
		return this.entryTimes.filter((x) => x >= t).length;
	}

	realizedToday(now) {
		return this.realizedByDay[dayKey(now)] ?? 0;
	}

	/** Mark-to-market value of everything still held (open + bags). */
	markLamports() {
		let total = 0;
		for (const p of Object.values(this.positions)) {
			if (p.status !== 'closed') total += Number(p.value_lamports || 0);
		}
		return total;
	}

	/** Hot equity: what the trading wallet plus its holdings are worth now. */
	hotEquity() {
		return this.walletLamports + this.markLamports();
	}

	/** Net P&L since the desk started, vault included. */
	netLamports() {
		return this.hotEquity() + this.vaultLamports - this.startLamports;
	}

	recordEntry({ mint, symbol, seat, agent, costLamports, tokens, coin, exits, sig, now, venue }) {
		const id = `t${++this.seq}`;
		this.walletLamports -= costLamports;
		this.entryTimes.push(now);
		this.entryTimes = this.entryTimes.filter((x) => x >= now - DAY_MS);
		this.positions[mint] = {
			id,
			mint,
			symbol,
			seat,
			agent,
			venue,
			status: 'open',
			opened_at: now,
			entry_lamports: costLamports,
			cost_lamports: costLamports,
			tokens: String(tokens),
			value_lamports: costLamports,
			peak_lamports: costLamports,
			proceeds_lamports: 0,
			initials_recovered: false,
			stale_since: null,
			prev_value: null,
			coin,
			fills: [{ side: 'buy', t: now, lamports: costLamports, tokens: String(tokens), sig: sig || null }],
			...exits,
		};
		return this.positions[mint];
	}

	/**
	 * Book a sell of `soldTokens` for `proceedsLamports`. Returns the graded
	 * trade when the stake-bearing part of the position just closed.
	 */
	recordExit(mint, { soldTokens, proceedsLamports, reason, sig, now, keepsMoonbag, recoversInitials }) {
		const p = this.positions[mint];
		if (!p) return null;
		const before = BigInt(p.tokens);
		const sold = BigInt(soldTokens) > before ? before : BigInt(soldTokens);
		const remaining = before - sold;
		const fraction = before > 0n ? Number(sold) / Number(before) : 1;

		this.walletLamports += proceedsLamports;
		p.proceeds_lamports += proceedsLamports;
		p.tokens = remaining.toString();
		p.value_lamports = Math.round(Number(p.value_lamports) * (1 - fraction));
		p.peak_lamports = Math.max(p.value_lamports, Math.round(Number(p.peak_lamports) * (1 - fraction)));
		p.fills.push({ side: 'sell', t: now, lamports: proceedsLamports, tokens: sold.toString(), reason, sig: sig || null });
		const day = dayKey(now);

		if (p.status === 'bag') {
			// A bag is house money: whatever it returns is pure realized gain on a
			// trade audit already graded.
			this.realizedByDay[day] = (this.realizedByDay[day] ?? 0) + proceedsLamports;
			const trade = this.trades.find((t) => t.id === p.id);
			if (trade) {
				trade.bag_proceeds_lamports = (trade.bag_proceeds_lamports ?? 0) + proceedsLamports;
				trade.pnl_lamports += proceedsLamports;
			}
			if (remaining === 0n) p.status = 'closed';
			return null;
		}

		const stakeClosed = remaining === 0n || keepsMoonbag;
		if (!stakeClosed) {
			// The remaining tokens carry their proportional share of the cost
			// basis, so the trailing stop and timeout keep judging the rest of the
			// position against what it actually cost.
			p.entry_lamports = Math.round(p.entry_lamports * (1 - fraction));
			if (recoversInitials) p.initials_recovered = true;
			return null;
		}

		const pnl = p.proceeds_lamports - p.cost_lamports;
		this.realizedByDay[day] = (this.realizedByDay[day] ?? 0) + pnl;
		p.status = remaining === 0n ? 'closed' : 'bag';
		p.closed_at = now;
		const trade = {
			id: p.id,
			mint,
			symbol: p.symbol,
			seat: p.seat,
			agent: p.agent,
			venue: p.venue,
			opened_at: p.opened_at,
			closed_at: now,
			cost_lamports: p.cost_lamports,
			proceeds_lamports: p.proceeds_lamports,
			pnl_lamports: pnl,
			multiple: p.cost_lamports > 0 ? p.proceeds_lamports / p.cost_lamports : 0,
			reason,
			kept_bag: remaining > 0n,
			coin: p.coin,
			fills: p.fills,
		};
		this.trades.push(trade);
		return trade;
	}

	/** Move surplus above `keepLamports` from the hot wallet into the vault. */
	sweep(keepLamports) {
		const surplus = Math.max(0, this.walletLamports - keepLamports);
		this.walletLamports -= surplus;
		this.vaultLamports += surplus;
		return surplus;
	}
}
