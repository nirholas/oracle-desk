import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideLadderedExit, decideLiquidityDecay, moonbagExitFraction, updateStaleClock } from '../src/exit-logic.js';

const T0 = 1_000_000;
const base = {
	entry_lamports: 100,
	stop_loss_pct: 35,
	trailing_stop_pct: 25,
	take_profit_pct: null,
	initials_out_multiple: 2,
	moonbag_min_pct: 15,
	max_hold_seconds: 2700,
	opened_at: T0,
	initials_recovered: false,
};

test('holds a position that has not hit any rule', () => {
	assert.equal(decideLadderedExit(base, 110, 120, T0 + 1000), null);
});

test('the hard stop is a full exit while the stake is at risk', () => {
	assert.deepEqual(decideLadderedExit(base, 60, 100, T0 + 1000), { reason: 'stop_loss', sellFraction: 1 });
});

test('take-initials sells exactly the stake at 2x and keeps the rest', () => {
	const d = decideLadderedExit(base, 200, 200, T0 + 1000);
	assert.equal(d.reason, 'take_initials');
	assert.equal(d.sellFraction, 0.5);
	assert.equal(d.recoversInitials, true);
});

test('take-initials never sells past the moon-bag floor', () => {
	const d = decideLadderedExit({ ...base, initials_out_multiple: 1.05 }, 105, 105, T0 + 1000);
	assert.ok(d.sellFraction <= 0.85 + 1e-9);
});

test('the trailing stop does not arm until the position has been green', () => {
	assert.equal(decideLadderedExit(base, 70, 99, T0 + 1000), null);
});

test('a trailing stop in profit keeps a bag', () => {
	const d = decideLadderedExit(base, 140, 190, T0 + 1000);
	assert.equal(d.reason, 'trailing_stop');
	assert.equal(d.keepsMoonbag, true);
	assert.ok(Math.abs(d.sellFraction - 100 / 140) < 1e-9);
});

test('on house money a terminal exit banks down to the floor', () => {
	const d = decideLadderedExit({ ...base, initials_recovered: true }, 80, 200, T0 + 10_000_000);
	assert.equal(d.reason, 'trailing_stop');
	assert.equal(d.sellFraction, 0.85);
});

test('timeout underwater is a full exit', () => {
	assert.deepEqual(decideLadderedExit(base, 90, 100, T0 + 2700 * 1000), { reason: 'timeout', sellFraction: 1 });
});

test('moonbagExitFraction never returns 1', () => {
	assert.equal(moonbagExitFraction(100, 200, 0.15, false), 0.5);
	assert.equal(moonbagExitFraction(100, 101, 0.15, false), 0.85);
	assert.equal(moonbagExitFraction(100, 0, 0.15, false), 0.85);
	assert.equal(moonbagExitFraction(100, 500, 0.15, true), 0.85);
});

test('the stale clock runs only underwater and unchanged', () => {
	assert.equal(updateStaleClock(null, 90, 100, null, 5), null);
	assert.equal(updateStaleClock(90, 90, 100, null, 5), 5);
	assert.equal(updateStaleClock(90, 90, 100, 3, 5), 3);
	assert.equal(updateStaleClock(90, 91, 100, 3, 5), null);
	assert.equal(updateStaleClock(120, 120, 100, null, 5), null);
	assert.equal(decideLiquidityDecay(0, 180, 179_000), false);
	assert.equal(decideLiquidityDecay(0, 180, 180_000), true);
});
