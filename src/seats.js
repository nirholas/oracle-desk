// Research seats: each one is a strategy expressed as bars over the Oracle's
// published verdict for a coin. A seat passes a coin only when every one of its
// checks clears. The audit desk moves those bars from realized P&L, inside the
// clamps below, and the head of desk can rewrite a seat outright from its own
// trade history.

/** Every check a seat can carry: how to read it off a verdict, which way is
 * stricter, the range the audit loop may move it through, and its step. */
export const CHECKS = {
	min_score: { label: 'conviction', read: (c) => c.score, dir: 'min', clamp: [40, 97], step: 2 },
	max_rug_risk: { label: 'rug risk', read: (c) => c.rug_risk, dir: 'max', clamp: [5, 60], step: 3 },
	max_give_back: { label: 'give-back risk', read: (c) => c.give_back_risk, dir: 'max', clamp: [10, 80], step: 3 },
	min_momentum: { label: 'momentum pillar', read: (c) => c.pillars?.momentum, dir: 'min', clamp: [0, 95], step: 3 },
	min_structure: { label: 'structure pillar', read: (c) => c.pillars?.structure, dir: 'min', clamp: [0, 90], step: 3 },
	min_pedigree: { label: 'pedigree pillar', read: (c) => c.pillars?.pedigree, dir: 'min', clamp: [0, 90], step: 3 },
	min_smart_wallets: { label: 'smart wallets', read: (c) => c.smart_wallet_count, dir: 'min', clamp: [0, 6], step: 1 },
	max_age_s: { label: 'age (s)', read: (c, now) => ageSeconds(c, now), dir: 'max', clamp: [60, 3600], step: 60 },
};

export function ageSeconds(coin, now) {
	const first = Date.parse(coin.coin_first_seen_at || coin.scored_at || '');
	return Number.isFinite(first) ? Math.max(0, (now - first) / 1000) : null;
}

function span(spec) {
	return spec.clamp[1] - spec.clamp[0] || 1;
}

function clampTo(spec, v) {
	return Math.max(spec.clamp[0], Math.min(spec.clamp[1], v));
}

/**
 * Evaluate one seat against one verdict. A missing reading fails its check:
 * the desk never trades on a number the Oracle did not publish.
 *
 * @returns {{ pass: boolean, checks: Array<{ key, label, value, bar, pass, margin }> }}
 */
export function evaluateSeat(seat, coin, now) {
	const checks = [];
	for (const [key, bar] of Object.entries(seat.checks)) {
		const spec = CHECKS[key];
		if (!spec || bar == null) continue;
		const raw = spec.read(coin, now);
		const value = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
		let pass = false;
		let margin = -1;
		if (value != null) {
			const diff = spec.dir === 'min' ? value - bar : bar - value;
			pass = diff >= 0;
			margin = diff / span(spec);
		}
		checks.push({ key, label: spec.label, value, bar, pass, margin });
	}
	return { pass: checks.length > 0 && checks.every((c) => c.pass), checks };
}

/** The passing check with the thinnest margin: the one that almost said no. */
export function bindingCheck(checks) {
	let best = null;
	for (const c of checks) {
		if (!c.pass) continue;
		if (!best || c.margin < best.margin) best = c;
	}
	return best;
}

/**
 * Move one bar by `steps` (positive = stricter). Returns the revision, or null
 * when the clamp stops it.
 */
export function moveBar(seat, key, steps) {
	const spec = CHECKS[key];
	if (!spec || seat.checks[key] == null) return null;
	const from = seat.checks[key];
	const delta = spec.step * steps * (spec.dir === 'min' ? 1 : -1);
	const to = Number(clampTo(spec, from + delta).toFixed(2));
	if (to === from) return null;
	seat.checks[key] = to;
	return { key, from, to };
}

/**
 * Seat grade over its current window, in [0, 1]. Half is the smoothed win
 * rate, half is net P&L relative to what the seat risked, so a seat that wins
 * often but small, or rarely but big, both read fairly.
 */
export function gradeSeat(trades) {
	const n = trades.length;
	if (!n) return { n: 0, wins: 0, netLamports: 0, score: 0.5 };
	const wins = trades.filter((t) => t.pnl_lamports > 0).length;
	const net = trades.reduce((s, t) => s + t.pnl_lamports, 0);
	const risked = trades.reduce((s, t) => s + t.cost_lamports, 0) || 1;
	const winRate = (wins + 1) / (n + 2);
	const returnScore = 1 / (1 + Math.exp(-4 * (net / risked)));
	return { n, wins, netLamports: net, score: Number((0.5 * winRate + 0.5 * returnScore).toFixed(4)) };
}

/**
 * Rewrite a seat from its own trades: for each check, pick the bar that would
 * have kept the most net P&L, holding the other checks fixed. Candidate bars
 * are midpoints between the values its own entries showed. Only moves that
 * strictly improve the seat's own record are made, and every bar stays inside
 * its clamp.
 *
 * @returns {Array<{ key, from, to, keptNet, droppedNet, kept, dropped }>}
 */
export function refitSeat(seat, trades) {
	const moves = [];
	for (const key of Object.keys(seat.checks)) {
		const spec = CHECKS[key];
		if (!spec) continue;
		const rows = trades
			.map((t) => {
				const raw = spec.read(t.coin || {}, t.opened_at);
				return { value: raw == null ? null : Number(raw), pnl: t.pnl_lamports };
			})
			.filter((r) => r.value != null && Number.isFinite(r.value));
		if (rows.length < 2) continue;

		const current = seat.checks[key];
		const netAt = (bar) =>
			rows.reduce((s, r) => s + ((spec.dir === 'min' ? r.value >= bar : r.value <= bar) ? r.pnl : 0), 0);
		// Candidate bars sit halfway between neighbouring observed values, so a
		// bar never lands exactly on a trade it is meant to keep or cut.
		const values = [...new Set(rows.map((r) => r.value))].sort((a, b) => a - b);
		const candidates = values.slice(1).map((v, i) => clampTo(spec, (values[i] + v) / 2));
		let bestBar = current;
		let bestNet = netAt(current);
		for (const bar of candidates) {
			const n = netAt(bar);
			// Move only on a strict improvement; among equals, stay nearest the
			// current bar. A tie is not evidence.
			const closer = Math.abs(bar - current) < Math.abs(bestBar - current);
			if (n > bestNet || (n === bestNet && bestBar !== current && closer)) {
				bestNet = n;
				bestBar = bar;
			}
		}
		if (bestBar === current) continue;
		const keep = (r) => (spec.dir === 'min' ? r.value >= bestBar : r.value <= bestBar);
		const kept = rows.filter(keep);
		const dropped = rows.filter((r) => !keep(r));
		seat.checks[key] = Number(bestBar.toFixed(2));
		moves.push({
			key,
			from: current,
			to: seat.checks[key],
			kept: kept.length,
			dropped: dropped.length,
			keptNet: kept.reduce((s, r) => s + r.pnl, 0),
			droppedNet: dropped.reduce((s, r) => s + r.pnl, 0),
		});
	}
	return moves;
}

export function makeSeat(def, now) {
	return {
		id: def.id,
		thesis: def.thesis,
		checks: { ...def.checks },
		budget: 1,
		rev: 0,
		hired_at: now,
		window_start: now,
		fired: 0,
		stats: { seen: 0, passed: 0, claimed: 0 },
	};
}
