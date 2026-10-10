import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, bindingCheck, evaluateSeat, gradeSeat, makeSeat, moveBar, refitSeat } from '../src/seats.js';

const NOW = Date.parse('2026-09-30T12:00:00Z');
const coin = (over = {}) => ({
	mint: 'THREEsynthetic1111111111111111111111111111',
	score: 80,
	rug_risk: 15,
	give_back_risk: 30,
	pillars: { pedigree: 40, structure: 50, narrative: 10, momentum: 75 },
	smart_wallet_count: 2,
	coin_first_seen_at: new Date(NOW - 120_000).toISOString(),
	...over,
});
const seat = (checks) => makeSeat({ id: 'S', thesis: 't', checks }, NOW);

test('a seat passes only when every check clears', () => {
	const s = seat({ min_score: 70, max_rug_risk: 20, max_age_s: 600 });
	assert.equal(evaluateSeat(s, coin(), NOW).pass, true);
	assert.equal(evaluateSeat(s, coin({ rug_risk: 25 }), NOW).pass, false);
	assert.equal(evaluateSeat(s, coin({ coin_first_seen_at: new Date(NOW - 900_000).toISOString() }), NOW).pass, false);
});

test('a missing reading fails its check instead of passing', () => {
	const s = seat({ min_score: 50, max_rug_risk: 40 });
	assert.equal(evaluateSeat(s, coin({ rug_risk: null }), NOW).pass, false);
});

test('the binding check is the passing check with the thinnest margin', () => {
	const s = seat({ min_score: 78, max_rug_risk: 40 });
	const { checks } = evaluateSeat(s, coin(), NOW);
	assert.equal(bindingCheck(checks).key, 'min_score');
});

test('moveBar goes stricter in the right direction and stops at the clamp', () => {
	const s = seat({ min_score: 96, max_rug_risk: 6 });
	assert.deepEqual(moveBar(s, 'min_score', 1), { key: 'min_score', from: 96, to: 97 });
	assert.equal(moveBar(s, 'min_score', 1), null);
	assert.deepEqual(moveBar(s, 'max_rug_risk', 1), { key: 'max_rug_risk', from: 6, to: 5 });
	assert.deepEqual(moveBar(s, 'max_rug_risk', -1), { key: 'max_rug_risk', from: 5, to: 8 });
	assert.equal(CHECKS.min_score.clamp[1], 97);
});

test('gradeSeat is neutral with no trades and rewards net return', () => {
	assert.equal(gradeSeat([]).score, 0.5);
	const good = gradeSeat([{ pnl_lamports: 50, cost_lamports: 100 }, { pnl_lamports: 30, cost_lamports: 100 }]);
	const bad = gradeSeat([{ pnl_lamports: -60, cost_lamports: 100 }, { pnl_lamports: -40, cost_lamports: 100 }]);
	assert.ok(good.score > 0.6);
	assert.ok(bad.score < 0.4);
});

test('refitSeat moves a bar to cut its own losers when that keeps more P&L', () => {
	const s = seat({ min_score: 60 });
	const trade = (score, pnl) => ({ coin: coin({ score }), pnl_lamports: pnl, opened_at: NOW });
	const moves = refitSeat(s, [trade(62, -40), trade(64, -30), trade(81, 90), trade(88, 20)]);
	assert.equal(moves.length, 1);
	assert.equal(moves[0].from, 60);
	assert.equal(moves[0].to, 72.5);
	assert.equal(moves[0].dropped, 2);
	assert.equal(moves[0].droppedNet, -70);
	assert.equal(s.checks.min_score, 72.5);
});

test('refitSeat leaves a seat alone when no bar would have done better', () => {
	const s = seat({ min_score: 60 });
	const moves = refitSeat(s, [
		{ coin: coin({ score: 62 }), pnl_lamports: 40, opened_at: NOW },
		{ coin: coin({ score: 70 }), pnl_lamports: 10, opened_at: NOW },
	]);
	assert.deepEqual(moves, []);
	assert.equal(s.checks.min_score, 60);
});
