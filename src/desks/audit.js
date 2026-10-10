// Desk 5: AUDIT. Grades every closed trade against the seat that claimed it
// and feeds the result back into that seat's bars.
//
// The rule is local and bounded. On a loss, the check that came closest to
// saying no at entry (the binding check) moves one step stricter. On a clean
// win (1.5x or better), that same check relaxes half a step, so a seat that is
// too strict can find its way back. Every move stays inside the check's clamp,
// which is what stops the loop from strangling a seat into silence.

import { bindingCheck, evaluateSeat, moveBar, refitSeat } from '../seats.js';
import { sol } from '../ledger.js';

const WIN_MULTIPLE = 1.5;

export class Audit {
	constructor({ bus, research, state }) {
		this.bus = bus;
		this.research = research;
		this.revisions = state.revisions ?? [];
		this.grades = state.grades ?? [];
		this.agents = {
			GRADER: { name: 'GRADER', desk: 'AUDIT', status: 'live', graded: this.grades.length },
			TUNER: { name: 'TUNER', desk: 'AUDIT', status: 'live', revisions: this.revisions.length },
		};
	}

	/** Grade one closed trade and retune its seat. Returns the revision, if any. */
	onClosed(trade, now = Date.now()) {
		const seat = this.research.seat(trade.seat);
		const win = trade.pnl_lamports > 0;
		this.grades.push({ id: trade.id, seat: trade.seat, win, pnl_lamports: trade.pnl_lamports, t: now });
		if (this.grades.length > 1000) this.grades.splice(0, this.grades.length - 1000);
		this.agents.GRADER.graded = this.grades.length;
		this.bus.note(
			'AUDIT',
			'GRADER',
			`${trade.symbol || trade.mint.slice(0, 6)} graded ${win ? 'WIN' : 'LOSS'} for ${trade.seat}: ${trade.pnl_lamports >= 0 ? '+' : ''}${sol(trade.pnl_lamports).toFixed(4)} SOL (${trade.multiple.toFixed(2)}x, ${trade.reason.replace(/_/g, ' ')})`,
			{ mint: trade.mint, kind: win ? 'win' : 'loss' },
		);
		if (!seat || !trade.coin) return null;

		// Re-judge the verdict the seat bought on, as of entry, to find the check
		// that almost refused it.
		const atEntry = evaluateSeat(seat, trade.coin, trade.opened_at);
		const clean = trade.multiple >= WIN_MULTIPLE;
		if (win && !clean) return null;
		// Bars move between entry and grade. A loser today's bars already refuse
		// needs nothing; a clean winner they now refuse relaxes the check that
		// would turn it away.
		if (!win && !atEntry.pass) return null;
		const binding = atEntry.pass
			? bindingCheck(atEntry.checks)
			: atEntry.checks.filter((c) => !c.pass && c.value != null).sort((a, b) => b.margin - a.margin)[0];
		if (!binding) return null;
		const move = moveBar(seat, binding.key, win ? -0.5 : 1);
		if (!move) return null;

		seat.rev += 1;
		const why = win
			? `${trade.symbol || 'a winner'} cleared ${binding.label} by a hair and returned ${trade.multiple.toFixed(2)}x; relaxing it`
			: `${trade.symbol || 'a loser'} slipped through on ${binding.label}; tightening it`;
		return this.record({ seat: seat.id, ...move, why, trade: trade.id, kind: 'tune' }, now);
	}

	/**
	 * Rewrite a fired seat from its own window of trades. Called by the head.
	 * Returns the moves made (possibly none).
	 */
	rewrite(seat, trades, now = Date.now()) {
		const moves = refitSeat(seat, trades);
		seat.rev += 1;
		for (const m of moves) {
			this.record(
				{
					seat: seat.id,
					key: m.key,
					from: m.from,
					to: m.to,
					why: `refit from its own ${trades.length} trades: keeps ${m.kept} (net ${sol(m.keptNet).toFixed(4)} SOL), cuts ${m.dropped} (net ${sol(m.droppedNet).toFixed(4)} SOL)`,
					kind: 'rewrite',
				},
				now,
			);
		}
		return moves;
	}

	record(rev, now) {
		const entry = { n: this.revisions.length + 1, t: now, ...rev };
		this.revisions.push(entry);
		if (this.revisions.length > 500) this.revisions.splice(0, this.revisions.length - 500);
		this.agents.TUNER.revisions = this.revisions.length;
		this.bus.note('AUDIT', 'TUNER', `${rev.seat} ${rev.key}: ${rev.from} -> ${rev.to} (${rev.why})`, { kind: 'revision' });
		return entry;
	}

	toJSON() {
		return { revisions: this.revisions, grades: this.grades };
	}
}
