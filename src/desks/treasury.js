// Desk 6: TREASURY. Banks profit and guards the downside.
//
// If hot equity (wallet plus marked holdings) falls below a fraction of where
// the desk started, treasury freezes risk: no new entries until equity climbs
// back. Exits keep running while frozen, since selling only ever reduces risk. On
// its sweep interval it moves surplus above the keep line out of the trading
// wallet: into the paper vault, or in live mode to DESK_COLD_WALLET.

import { sol } from '../ledger.js';

export class Treasury {
	constructor({ bus, config, ledger, risk, broker, state }) {
		this.bus = bus;
		this.cfg = config.treasury;
		this.ledger = ledger;
		this.risk = risk;
		this.broker = broker;
		this.lastSweep = state.lastSweep ?? Date.now();
		this.sweeps = state.sweeps ?? [];
		this.agent = { name: 'VAULT', desk: 'TREASURY', status: 'live' };
	}

	/** Freeze or lift based on hot equity. Returns the new frozen state. */
	guard() {
		const start = this.ledger.startLamports;
		if (!start) return this.risk.frozen;
		const equity = this.ledger.hotEquity();
		if (!this.risk.frozen && equity < start * this.cfg.freeze_below_fraction) {
			this.risk.frozen = true;
			this.bus.note('TREASURY', 'VAULT', `equity ${sol(equity).toFixed(3)} SOL is below ${Math.round(this.cfg.freeze_below_fraction * 100)}% of start: new entries frozen`, { level: 'warn', kind: 'freeze' });
		} else if (this.risk.frozen && equity >= start * this.cfg.unfreeze_at_fraction) {
			this.risk.frozen = false;
			this.bus.note('TREASURY', 'VAULT', `equity recovered to ${sol(equity).toFixed(3)} SOL: freeze lifted`, { kind: 'unfreeze' });
		}
		return this.risk.frozen;
	}

	async maybeSweep(now = Date.now()) {
		if (now - this.lastSweep < this.cfg.sweep_every_minutes * 60_000) return null;
		this.lastSweep = now;
		const keep = this.ledger.startLamports * this.cfg.keep_multiple_of_start;
		const surplus = Math.max(0, Math.floor(this.ledger.walletLamports - keep));
		if (surplus <= 0) return null;
		try {
			const result = await this.broker.sweep(surplus);
			if (result.sent || this.broker.mode === 'paper') {
				this.ledger.sweep(this.ledger.walletLamports - surplus);
				this.sweeps.push({ t: now, lamports: surplus, sig: result.sig || null });
				this.bus.note('TREASURY', 'VAULT', `swept ${sol(surplus).toFixed(4)} SOL of profit to ${this.broker.mode === 'paper' ? 'the vault' : 'cold storage'}`, { sig: result.sig, kind: 'sweep' });
			} else {
				this.bus.note('TREASURY', 'VAULT', `${sol(surplus).toFixed(4)} SOL is above the keep line; not swept (${result.reason})`);
			}
			return result;
		} catch (err) {
			this.bus.note('TREASURY', 'VAULT', `sweep failed: ${err.message}`, { level: 'error' });
			return null;
		}
	}

	toJSON() {
		return { lastSweep: this.lastSweep, sweeps: this.sweeps.slice(-100) };
	}
}
