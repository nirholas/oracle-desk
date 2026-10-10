// Pure exit decisions. No I/O and no clock of its own.
//
// Ported from the three.ws sniper fleet, where these rules were tuned against
// real fills: the hard stop always wins, the trailing stop only arms once the
// position has been green, the first profit event returns the stake and never
// more, and a bag always rides once the stake is back.

/** Coerce to a finite number, or null. Null means "disabled", never zero. */
export function pct(n) {
	if (n == null || n === '') return null;
	const x = Number(n);
	return Number.isFinite(x) ? x : null;
}

/** The take-initials multiple, or null when the ladder is off. Must be above 1. */
export function ladderMultiple(n) {
	const x = pct(n);
	return x != null && x > 1 ? x : null;
}

/** Moon-bag floor as a fraction of the position, clamped to [0, 0.95]. */
export function moonbagFraction(n) {
	const x = pct(n);
	return Math.max(0, Math.min(0.95, (x == null ? 15 : x) / 100));
}

/**
 * How much of the remaining position a terminal exit sells when a bag may
 * ride. Never 1. With the stake already recovered the whole remainder is house
 * money, so bank down to the floor. Still carrying cost but in profit: sell
 * exactly enough to return the stake.
 */
export function moonbagExitFraction(entry, value, moonbag, houseMoney) {
	const cap = 1 - moonbag;
	if (!(value > 0)) return cap;
	const target = houseMoney ? cap : entry / value;
	return Math.max(0, Math.min(target, cap));
}

/**
 * Liquidity-decay clock. A bonding-curve quote only moves when someone trades,
 * so an underwater position whose value is exactly unchanged sweep after sweep
 * is a coin nobody is trading. Returns the new stale-since (epoch ms) or null.
 */
export function updateStaleClock(prevValue, value, entry, staleSince, now) {
	const underwater = value < entry;
	const unchanged = prevValue != null && Number(prevValue) === Number(value);
	if (!underwater || !unchanged) return null;
	return staleSince ?? now;
}

export function decideLiquidityDecay(staleSince, decaySeconds, now) {
	if (staleSince == null || !(decaySeconds > 0)) return false;
	return (now - staleSince) / 1000 >= decaySeconds;
}

/**
 * Laddered exit: the reason and the fraction of the CURRENT remaining position
 * to sell, or null to hold.
 *
 * Priority: stop_loss, trailing_stop, take_initials, take_profit, timeout.
 *
 * @param {object} pos { entry_lamports, stop_loss_pct, trailing_stop_pct,
 *   take_profit_pct, initials_out_multiple, moonbag_min_pct, max_hold_seconds,
 *   opened_at, initials_recovered }
 * @param {number} value current value of the remaining position (lamports)
 * @param {number} peak  high-water mark of value since entry (lamports)
 * @param {number} now   epoch ms
 * @returns {{ reason: string, sellFraction: number, recoversInitials?: boolean, keepsMoonbag?: boolean } | null}
 */
export function decideLadderedExit(pos, value, peak, now) {
	const entry = Number(pos.entry_lamports);
	if (!(entry > 0)) return null;

	const mult = ladderMultiple(pos.initials_out_multiple);
	const moonbag = moonbagFraction(pos.moonbag_min_pct);
	const recovered = pos.initials_recovered === true;
	const sl = pct(pos.stop_loss_pct);
	const ts = pct(pos.trailing_stop_pct);
	const tp = pct(pos.take_profit_pct);

	let reason = null;
	if (sl != null && value <= entry * (1 - sl / 100)) {
		reason = 'stop_loss';
	} else if (ts != null && peak > entry && value <= peak * (1 - ts / 100)) {
		// Armed only once the position has been green. Armed underwater it just
		// realizes small losses; the hard stop above already caps the downside.
		reason = 'trailing_stop';
	} else if (mult != null && !recovered && value >= entry * mult) {
		const sellFraction = Math.max(0, Math.min(entry / value, 1 - moonbag));
		if (sellFraction > 0) return { reason: 'take_initials', sellFraction, recoversInitials: true };
	}

	if (reason == null) {
		if (tp != null && value >= entry * (1 + tp / 100) && (recovered || mult == null)) {
			reason = 'take_profit';
		} else {
			const heldS = (now - pos.opened_at) / 1000;
			if (pos.max_hold_seconds != null && heldS >= pos.max_hold_seconds) reason = 'timeout';
		}
	}
	if (reason == null) return null;

	// Before the stake is back the position is our money: a loss or a stop is a
	// full exit. Once in profit or on house money, a bag always rides.
	const inProfit = value > entry;
	if (!recovered && !inProfit) return { reason, sellFraction: 1 };
	if (!recovered && reason === 'stop_loss') return { reason, sellFraction: 1 };

	const sellFraction = moonbagExitFraction(entry, value, moonbag, recovered);
	if (!(sellFraction > 0)) return null;
	return { reason, sellFraction, keepsMoonbag: true };
}
