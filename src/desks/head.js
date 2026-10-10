// HEAD OF DESK. Never trades.
//
// On its review interval it reads every seat's realized record and makes two
// calls: who gets more budget, and who gets fired. Fired means audit rewrites
// that seat's bars from its own window of trades, and the seat starts a fresh
// window to prove the new configuration. At most one firing per cooldown, and a
// seat is only judged once it has enough closed trades to judge.
//
// Every decision is made from the numbers. When an LLM key is configured, the
// head also writes a short memo narrating the review; the memo never decides.

import { gradeSeat } from '../seats.js';
import { sol } from '../ledger.js';

export class Head {
	constructor({ bus, config, research, audit, ledger, memo, state }) {
		this.bus = bus;
		this.cfg = config.head;
		this.research = research;
		this.audit = audit;
		this.ledger = ledger;
		this.memo = memo;
		this.decisions = state.decisions ?? [];
		this.memos = state.memos ?? [];
		this.lastReview = state.lastReview ?? Date.now();
		this.lastFire = state.lastFire ?? 0;
		this.firings = state.firings ?? 0;
		this.agent = { name: 'HEAD', desk: 'HEAD', status: 'live' };
	}

	seatTrades(seat) {
		return this.ledger.trades.filter((t) => t.seat === seat.id && t.opened_at >= seat.window_start);
	}

	roster() {
		return this.research.seats.map((seat) => ({ seat, grade: gradeSeat(this.seatTrades(seat)) }));
	}

	due(now = Date.now()) {
		return now - this.lastReview >= this.cfg.review_every_minutes * 60_000;
	}

	/**
	 * One review. Pure over the ledger and seats apart from the memo call.
	 * @returns {{ promoted: string|null, fired: string|null, roster }}
	 */
	async review(now = Date.now()) {
		this.lastReview = now;
		const roster = this.roster();
		const judged = roster.filter((r) => r.grade.n >= this.cfg.min_trades_to_judge);
		let promoted = null;
		let fired = null;

		if (judged.length) {
			const best = judged.reduce((a, b) => (b.grade.score > a.grade.score ? b : a));
			if (best.grade.score > 0.5 && best.seat.budget < this.cfg.max_budget) {
				best.seat.budget = Number(Math.min(this.cfg.max_budget, best.seat.budget + this.cfg.promote_step).toFixed(2));
				promoted = best.seat.id;
				this.decide(now, 'promote', best.seat.id, `best record on the desk (${this.describe(best.grade)}); budget now ${best.seat.budget}x`);
			}
		}

		const cooled = now - this.lastFire >= this.cfg.cooldown_minutes * 60_000;
		if (cooled && judged.length) {
			const worst = judged.reduce((a, b) => (b.grade.score < a.grade.score ? b : a));
			if (worst.grade.score < this.cfg.fire_below_score && worst.seat.id !== promoted) {
				const trades = this.seatTrades(worst.seat);
				const moves = this.audit.rewrite(worst.seat, trades, now);
				worst.seat.window_start = now;
				worst.seat.budget = 1;
				worst.seat.fired += 1;
				worst.seat.hired_at = now;
				this.lastFire = now;
				this.firings += 1;
				fired = worst.seat.id;
				const change = moves.length ? moves.map((m) => `${m.key} ${m.from} -> ${m.to}`).join(', ') : 'bars already fit its record; fresh window only';
				this.decide(now, 'fire', worst.seat.id, `${this.describe(worst.grade)}, below the ${this.cfg.fire_below_score} bar. Rewritten: ${change}`);
			}
		}

		if (!promoted && !fired) {
			this.decide(now, 'hold', null, judged.length ? 'no seat earned a change this window' : `no seat has ${this.cfg.min_trades_to_judge} closed trades yet`);
		}

		await this.writeMemo(now, roster, { promoted, fired });
		return { promoted, fired, roster };
	}

	describe(grade) {
		return `${grade.wins}/${grade.n} wins, ${grade.netLamports >= 0 ? '+' : ''}${sol(grade.netLamports).toFixed(4)} SOL, score ${grade.score.toFixed(2)}`;
	}

	decide(now, kind, seat, text) {
		const entry = { t: now, kind, seat, text };
		this.decisions.push(entry);
		if (this.decisions.length > 300) this.decisions.splice(0, this.decisions.length - 300);
		this.bus.note('HEAD', 'HEAD', seat ? `${kind} ${seat}: ${text}` : text, { kind: `head-${kind}` });
	}

	async writeMemo(now, roster, outcome) {
		if (!this.memo?.enabled) return;
		try {
			const text = await this.memo.write({ roster, outcome, ledger: this.ledger, revisions: this.audit.revisions.slice(-10) });
			if (!text) return;
			this.memos.push({ t: now, text, model: this.memo.model });
			if (this.memos.length > 50) this.memos.splice(0, this.memos.length - 50);
			this.bus.note('HEAD', 'HEAD', `memo: ${text}`, { kind: 'memo' });
		} catch (err) {
			this.bus.note('HEAD', 'HEAD', `memo unavailable: ${err.message}`, { level: 'warn' });
		}
	}

	toJSON() {
		return {
			decisions: this.decisions,
			memos: this.memos,
			lastReview: this.lastReview,
			lastFire: this.lastFire,
			firings: this.firings,
		};
	}
}
