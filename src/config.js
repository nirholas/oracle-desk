// Configuration: desk.config.json is the org chart, the environment is the
// wiring (mode, keys, RPC). Both are read once at boot.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIVE_ACK = 'I_UNDERSTAND_REAL_FUNDS';

export function loadEnv(path = join(ROOT, '.env')) {
	if (existsSync(path)) process.loadEnvFile(path);
}

function num(value, fallback) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

export function loadDeskConfig(path = process.env.DESK_CONFIG || join(ROOT, 'desk.config.json')) {
	return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadConfig(env = process.env) {
	const mode = env.DESK_MODE === 'live' ? 'live' : 'paper';
	return {
		mode,
		liveAck: env.DESK_LIVE_ACK === LIVE_ACK,
		rpcUrl: env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
		oracleBase: (env.ORACLE_BASE_URL || 'https://three.ws').replace(/\/+$/, ''),
		paperSol: num(env.DESK_PAPER_SOL, 5),
		coldWallet: env.DESK_COLD_WALLET || null,
		port: num(env.DESK_PORT, 4180),
		host: env.DESK_HOST || '127.0.0.1',
		dataDir: env.DESK_DATA_DIR || join(ROOT, 'data'),
		secretKey: env.SOLANA_PRIVATE_KEY || null,
		keypairPath: env.DESK_KEYPAIR || null,
		anthropicKey: env.ANTHROPIC_API_KEY || null,
		desk: loadDeskConfig(),
	};
}
