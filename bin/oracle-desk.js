#!/usr/bin/env node
// oracle-desk: run the desk, or print its scoreboard.
//
//   oracle-desk run [--reset] [--headless]
//   oracle-desk status

import { loadConfig, loadEnv } from '../src/config.js';
import { Desk, readState } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { gradeSeat } from '../src/seats.js';
import { Ledger, sol } from '../src/ledger.js';

const BANNER = `
   ___  ____      _    ____ _     _____   ____  _____ ____  _  __
  / _ \\|  _ \\    / \\  / ___| |   | ____| |  _ \\| ____/ ___|| |/ /
 | | | | |_) |  / _ \\| |   | |   |  _|   | | | |  _| \\___ \\| ' /
 | |_| |  _ <  / ___ \\ |___| |___| |___  | |_| | |___ ___) | . \\
  \\___/|_| \\_\\/_/   \\_\\____|_____|_____| |____/|_____|____/|_|\\_\\
   six desks · one head · real launches · powered by the three.ws Oracle
`;

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const DESK_COLOR = { RADAR: 36, RESEARCH: 34, EXECUTION: 32, RISK: 33, AUDIT: 35, TREASURY: 33, HEAD: 97, SYSTEM: 90 };

function printLog(entry) {
	const time = new Date(entry.t).toISOString().slice(11, 19);
	const who = paint(DESK_COLOR[entry.desk] ?? 37, `${entry.desk.padEnd(9)} ${String(entry.agent).padEnd(11)}`);
	const text = entry.level === 'error' ? paint(31, entry.text) : entry.level === 'warn' ? paint(33, entry.text) : entry.text;
	console.log(`${paint(90, time)} ${who} ${text}`);
}

function scoreboard(state, mode) {
	const ledger = new Ledger(state.ledger);
	const c = state.counters || {};
	const trades = ledger.trades;
	const wins = trades.filter((t) => t.pnl_lamports > 0).length;
	const lines = [
		`ORACLE DESK SCOREBOARD (${mode.toUpperCase()})`,
		'',
		`  launches seen      ${c.launches ?? 0}`,
		`  oracle verdicts    ${c.verdicts ?? 0}`,
		`  cleared research   ${c.cleared ?? 0}`,
		`  refused by risk    ${c.blocked ?? 0}`,
		`  refused by wall    ${c.firewalled ?? 0}`,
		`  entries taken      ${c.entries ?? 0}`,
		`  wins / losses      ${wins} / ${trades.length - wins}`,
		`  wallet             ${sol(ledger.walletLamports).toFixed(4)} SOL`,
		`  vault              ${sol(ledger.vaultLamports).toFixed(4)} SOL`,
		`  net since start    ${sol(ledger.netLamports()).toFixed(4)} SOL (marks as of last save)`,
		`  firings            ${state.head?.firings ?? 0}`,
		`  matrix revisions   ${state.audit?.revisions?.length ?? 0}`,
		'',
		'  seats:',
	];
	for (const seat of state.research?.seats || []) {
		const g = gradeSeat(trades.filter((t) => t.seat === seat.id && t.opened_at >= seat.window_start));
		lines.push(`    ${seat.id.padEnd(12)} rev ${String(seat.rev).padEnd(3)} ${g.wins}/${g.n} wins  ${sol(g.netLamports).toFixed(4)} SOL  score ${g.score.toFixed(2)}  budget ${seat.budget}x${seat.fired ? `  fired ${seat.fired}x` : ''}`);
	}
	return lines.join('\n');
}

async function run(args) {
	loadEnv();
	const config = loadConfig();
	const desk = new Desk(config, { reset: args.includes('--reset') });
	console.log(paint(36, BANNER));
	desk.bus.on('log', printLog);
	await desk.start();
	if (!args.includes('--headless')) {
		await startServer(desk, { host: config.host, port: config.port });
		console.log(paint(97, `\n  dashboard  http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}\n`));
	}
	let stopping = false;
	const shutdown = async () => {
		if (stopping) return;
		stopping = true;
		await desk.stop();
		console.log(`\n${scoreboard(readState(config), config.mode)}\n`);
		process.exit(0);
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

function status() {
	loadEnv();
	const config = loadConfig();
	const state = readState(config);
	if (!state.ledger) {
		console.log(`No ${config.mode} desk has run here yet. Start one with: npm start`);
		return;
	}
	console.log(scoreboard(state, config.mode));
}

const [command = 'run', ...rest] = process.argv.slice(2);
if (command === 'run') {
	run(rest).catch((err) => {
		console.error(paint(31, `oracle-desk: ${err.message}`));
		process.exit(1);
	});
} else if (command === 'status') {
	status();
} else {
	console.log('usage: oracle-desk run [--reset] [--headless] | oracle-desk status');
	process.exit(command === 'help' || command === '--help' ? 0 : 1);
}
