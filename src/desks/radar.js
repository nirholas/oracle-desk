// Desk 1: RADAR. Sees everything, buys nothing.
//
//   LAUNCHES  every pump.fun mint the moment it is created (PumpPortal)
//   STREAM    every Oracle verdict the moment it is scored (SSE)
//   SWEEP     the Oracle feed on a timer, so nothing scored between two
//             stream connections is ever missed
//
// A verdict is forwarded to research once per (mint, scored_at): a coin the
// Oracle re-scores upward gets a second look, which is how a seat catches a
// coin crossing its bar after launch.

import WebSocket from 'ws';

const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_MAX_MS = 30_000;
const WATCHDOG_MS = 120_000;
const SEEN_LIMIT = 5_000;

export class Radar {
	constructor({ bus, oracle, config, counters }) {
		this.bus = bus;
		this.oracle = oracle;
		this.config = config;
		this.counters = counters;
		this.seen = new Map();
		this.agents = {
			LAUNCHES: { name: 'LAUNCHES', desk: 'RADAR', status: 'idle', count: 0, last_at: null },
			STREAM: { name: 'STREAM', desk: 'RADAR', status: 'idle', count: 0, last_at: null },
			SWEEP: { name: 'SWEEP', desk: 'RADAR', status: 'idle', count: 0, last_at: null },
		};
		this.timers = [];
		this.ws = null;
		this.backoff = 1_000;
		this.stopped = false;
	}

	start() {
		this.stopped = false;
		this.connectLaunches();
		this.oracle.stream({
			onCoin: (coin) => this.ingest(coin, 'STREAM'),
			onStatus: (status) => {
				const prev = this.agents.STREAM.status;
				this.agents.STREAM.status = status;
				if (status === 'live' && prev !== 'live' && prev !== 'idle') this.bus.note('RADAR', 'STREAM', 'Oracle stream reconnected');
			},
		});
		const pollMs = (this.config.radar?.feed_poll_seconds ?? 30) * 1000;
		this.sweep();
		this.timers.push(setInterval(() => this.sweep(), pollMs));
		this.timers.push(setInterval(() => this.watchdog(), 15_000));
	}

	stop() {
		this.stopped = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.oracle.close();
		this.ws?.terminate();
		this.ws = null;
	}

	async sweep() {
		const agent = this.agents.SWEEP;
		try {
			const body = await this.oracle.feed({ limit: 100 });
			agent.status = 'live';
			// Oldest first, so research sees verdicts in the order they happened.
			const items = [...(body.items || [])].reverse();
			for (const coin of items) this.ingest(coin, 'SWEEP');
		} catch (err) {
			agent.status = 'error';
			this.bus.note('RADAR', 'SWEEP', `Oracle feed unavailable: ${err.message}`, { level: 'warn' });
		}
	}

	ingest(coin, via) {
		if (!coin?.mint || coin.score == null) return;
		const key = `${coin.mint}:${coin.scored_at || ''}`;
		const agent = this.agents[via];
		agent.last_at = Date.now();
		if (this.seen.has(key)) return;
		this.seen.set(key, Date.now());
		if (this.seen.size > SEEN_LIMIT) {
			const drop = this.seen.size - SEEN_LIMIT;
			let i = 0;
			for (const k of this.seen.keys()) {
				if (i++ >= drop) break;
				this.seen.delete(k);
			}
		}
		agent.count += 1;
		this.counters.verdicts += 1;
		this.bus.publish('verdict', coin);
	}

	connectLaunches() {
		if (this.stopped) return;
		const agent = this.agents.LAUNCHES;
		const ws = new WebSocket(PUMPPORTAL_URL);
		this.ws = ws;
		agent.status = 'connecting';
		ws.on('open', () => {
			this.backoff = 1_000;
			agent.status = 'live';
			agent.last_at = Date.now();
			ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
			ws.send(JSON.stringify({ method: 'subscribeMigration' }));
		});
		ws.on('message', (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			agent.last_at = Date.now();
			if (msg.txType === 'create' && msg.mint) {
				agent.count += 1;
				this.counters.launches += 1;
			} else if (msg.txType === 'migrate' && msg.mint) {
				this.counters.graduations += 1;
				this.bus.publish('graduated', msg.mint);
			}
		});
		const retry = () => {
			if (this.stopped || this.ws !== ws) return;
			agent.status = 'reconnecting';
			const wait = this.backoff;
			this.backoff = Math.min(RECONNECT_MAX_MS, this.backoff * 2);
			setTimeout(() => this.connectLaunches(), wait);
		};
		ws.on('close', retry);
		ws.on('error', () => ws.terminate());
	}

	/** A socket that is open but silent is dead. Kill it and reconnect. */
	watchdog() {
		const agent = this.agents.LAUNCHES;
		if (agent.status === 'live' && agent.last_at && Date.now() - agent.last_at > WATCHDOG_MS) {
			this.bus.note('RADAR', 'LAUNCHES', 'launch feed silent for 2 minutes, reconnecting', { level: 'warn' });
			this.ws?.terminate();
		}
	}
}
