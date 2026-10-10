// The desk's nervous system. Desks never call each other directly: they emit
// and subscribe, so any one of them can be read, replaced or tested alone.
// Every emit that carries a `text` is also written to the desk log, which is
// what the dashboard tape and the terminal render.

import { EventEmitter } from 'node:events';

const LOG_LIMIT = 400;

export class Bus extends EventEmitter {
	constructor() {
		super();
		this.setMaxListeners(50);
		this.log = [];
		this.seq = 0;
	}

	/** Append a line to the desk log and broadcast it. */
	note(desk, agent, text, extra = {}) {
		const entry = { id: ++this.seq, t: Date.now(), desk, agent, text, ...extra };
		this.log.push(entry);
		if (this.log.length > LOG_LIMIT) this.log.splice(0, this.log.length - LOG_LIMIT);
		this.emit('log', entry);
		return entry;
	}

	/**
	 * Emit and wait for every async subscriber. A handler that throws is
	 * reported on the log and never breaks the others.
	 */
	async publish(event, payload) {
		const handlers = this.listeners(event);
		for (const handler of handlers) {
			try {
				await handler(payload);
			} catch (err) {
				this.note('SYSTEM', 'BUS', `${event} handler failed: ${err?.message || err}`, { level: 'error' });
			}
		}
	}
}
