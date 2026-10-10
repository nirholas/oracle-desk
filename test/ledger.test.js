import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';

const MINT = 'THREEsynthetic1111111111111111111111111111';
const T = Date.parse('2026-09-30T12:00:00Z');

function opened() {
	const l = new Ledger({ startLamports: 1_000_000_000, walletLamports: 1_000_000_000 });
	l.recordEntry({ mint: MINT, symbol: 'SYN', seat: 'PRIME', agent: 'SNIPER', costLamports: 100_000_000, tokens: 1_000_000n, coin: { score: 90 }, exits: {}, sig: null, now: T, venue: 'curve' });
	return l;
}

test('an entry moves SOL out of the wallet and opens a position', () => {
	const l = opened();
	assert.equal(l.walletLamports, 900_000_000);
	assert.equal(l.open().length, 1);
	assert.equal(l.entriesSince(T - 1), 1);
	assert.equal(l.hotEquity(), 1_000_000_000);
});

test('a full stop-loss closes and grades the trade', () => {
	const l = opened();
	const trade = l.recordExit(MINT, { soldTokens: 1_000_000n, proceedsLamports: 60_000_000, reason: 'stop_loss', now: T + 1000 });
	assert.equal(trade.pnl_lamports, -40_000_000);
	assert.equal(l.positions[MINT].status, 'closed');
	assert.equal(l.realizedToday(T + 1000), -40_000_000);
	assert.equal(l.netLamports(), -40_000_000);
});

test('take-initials keeps the position open with a proportional cost basis', () => {
	const l = opened();
	const trade = l.recordExit(MINT, { soldTokens: 500_000n, proceedsLamports: 100_000_000, reason: 'take_initials', now: T + 1000, recoversInitials: true });
	assert.equal(trade, null);
	const p = l.positions[MINT];
	assert.equal(p.status, 'open');
	assert.equal(p.initials_recovered, true);
	assert.equal(p.tokens, '500000');
	assert.equal(p.entry_lamports, 50_000_000);
});

test('a moon-bag exit grades the trade and leaves a bag riding', () => {
	const l = opened();
	l.recordExit(MINT, { soldTokens: 500_000n, proceedsLamports: 100_000_000, reason: 'take_initials', now: T + 1000, recoversInitials: true });
	const trade = l.recordExit(MINT, { soldTokens: 425_000n, proceedsLamports: 80_000_000, reason: 'trailing_stop', now: T + 2000, keepsMoonbag: true });
	assert.equal(trade.pnl_lamports, 80_000_000);
	assert.equal(trade.kept_bag, true);
	assert.equal(l.positions[MINT].status, 'bag');
	assert.equal(l.open().length, 0);
	assert.equal(l.bags().length, 1);

	const late = l.recordExit(MINT, { soldTokens: 75_000n, proceedsLamports: 5_000_000, reason: 'manual', now: T + 3000 });
	assert.equal(late, null);
	assert.equal(l.positions[MINT].status, 'closed');
	assert.equal(l.trades[0].pnl_lamports, 85_000_000);
	assert.equal(l.trades[0].bag_proceeds_lamports, 5_000_000);
});

test('sweep moves only the surplus above the keep line', () => {
	const l = new Ledger({ startLamports: 100, walletLamports: 300 });
	assert.equal(l.sweep(150), 150);
	assert.equal(l.walletLamports, 150);
	assert.equal(l.vaultLamports, 150);
	assert.equal(l.sweep(150), 0);
});
