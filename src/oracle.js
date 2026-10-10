// The three.ws Oracle, read over its public API. No key, no account.
//
//   GET  /api/oracle/feed     latest verdicts (the backlog and the backstop)
//   SSE  /api/oracle/stream   every verdict the moment it is scored
//   GET  /api/oracle/coin     one coin's full read
//   GET  /api/oracle/model    the published conviction model (via @three-ws/oracle-model)
//
// Every verdict carries score, tier, the four pillars, rug risk, give-back risk,
// the measured hit rate for its band, and the plain-language reasons.

import { EventSource } from 'eventsource';
import { OracleModel } from '@three-ws/oracle-model';

const UA = 'oracle-desk/1.0 (+https://three.ws/oracle)';

export class OracleClient {
	constructor({ base = 'https://three.ws', network = 'mainnet', fetchImpl = globalThis.fetch } = {}) {
		this.base = base;
		this.network = network;
		this.fetch = fetchImpl;
		this.source = null;
		this.model = null;
	}

	async getJson(path, params = {}) {
		const url = new URL(path, this.base);
		for (const [k, v] of Object.entries({ network: this.network, ...params })) {
			if (v != null) url.searchParams.set(k, String(v));
		}
		const res = await this.fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
		if (!res.ok) {
			const retryAfter = Number(res.headers.get('retry-after')) || null;
			throw Object.assign(new Error(`oracle ${url.pathname} answered ${res.status}`), { status: res.status, retryAfter });
		}
		return res.json();
	}

	feed({ limit = 100, minScore = 0 } = {}) {
		return this.getJson('/api/oracle/feed', { limit, min_score: minScore });
	}

	coin(mint) {
		return this.getJson('/api/oracle/coin', { mint });
	}

	backtest(period = '30d') {
		return this.getJson('/api/oracle/backtest', { period });
	}

	async loadModel() {
		this.model = await OracleModel.fetch({ endpoint: `${this.base}/api/oracle/model`, network: this.network, fetch: this.fetch });
		return this.model;
	}

	/**
	 * Subscribe to live verdicts. The server rotates each connection every 90
	 * seconds; EventSource reconnects on its own, and the feed poll in the radar
	 * covers the moment between two connections.
	 */
	stream({ onCoin, onStatus }) {
		this.close();
		const url = new URL('/api/oracle/stream', this.base);
		url.searchParams.set('network', this.network);
		const source = new EventSource(url.toString());
		this.source = source;
		source.addEventListener('open', () => onStatus?.('live'));
		source.addEventListener('coin', (ev) => {
			try {
				onCoin(JSON.parse(ev.data));
			} catch {
				onStatus?.('bad-frame');
			}
		});
		source.addEventListener('error', () => onStatus?.(source.readyState === EventSource.CLOSED ? 'closed' : 'reconnecting'));
		return source;
	}

	close() {
		this.source?.close();
		this.source = null;
	}
}

export const oracleCoinUrl = (mint) => `https://three.ws/oracle/coin/${mint}`;
