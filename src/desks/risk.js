// Desk 4: RISK. One agent, and it outranks everyone, the head included.
//
// It sizes every entry and can refuse any of them: frozen by treasury, the
// open-position cap, the hourly entry cap, the daily loss cap, a coin the desk
// already holds, or a wallet that would dip below its reserve. When it says
// no, nobody overrides it.

import { lamports, sol } from '../ledger.js';

const HOUR_MS = 3_600_000;

export class Risk {
	constructor({ bus, config, ledger, state }) {
		this.bus = bus;
		this.cfg = config.risk;
		this.ledger = ledger;
		this.frozen = state.frozen ?? false;
		this.paused = state.paused ?? false;
		this.blocks = state.blocks ?? {};
		this.lastLogged = {};
		this.agent = { name: 'RISK', desk: 'RISK', status: 'live' };
	}

	/**
	 * Why this entry must not happen, or null when it may. Pure over the
	 * ledger's current state.
	 */
	refusal(mint, now = Date.now()) {
		if (this.paused) return 'desk paused';
		if (this.frozen) return 'treasury freeze';
		if (this.ledger.holding(mint)) return 'already holding';
		if (this.ledger.open().length >= this.cfg.max_open_positions) return 'open-position cap';
		if (this.ledger.entriesSince(now - HOUR_MS) >= this.cfg.max_entries_per_hour) return 'hourly entry cap';
		if (-this.ledger.realizedToday(now) >= lamports(this.cfg.daily_loss_cap_sol)) return 'daily loss cap';
		return null;
	}

	/** Entry size in lamports for a seat, or 0 when the wallet cannot afford it. */
	sizeFor(seat) {
		const cap = this.ledger.walletLamports * this.cfg.max_position_fraction;
		const want = lamports(this.cfg.base_size_sol) * Math.max(0.2, seat.budget);
		const spendable = this.ledger.walletLamports - lamports(this.cfg.min_wallet_reserve_sol);
		const size = Math.floor(Math.min(cap, want, spendable));
		return size > 1_000_000 ? size : 0;
	}

	/** Count a refusal under a stable `reason`; `detail` only colors the log line. */
	block(reason, coin, detail = null, now = Date.now()) {
		this.blocks[reason] = (this.blocks[reason] ?? 0) + 1;
		// At a cap every cleared coin is refused for the same reason; one line a
		// minute per reason says so without drowning the tape.
		if (reason === 'already holding' || now - (this.lastLogged[reason] ?? 0) < 60_000) return;
		this.lastLogged[reason] = now;
		this.bus.note('RISK', 'RISK', `blocked ${coin.symbol || coin.mint.slice(0, 6)}: ${detail || reason}`, { mint: coin.mint, level: 'warn' });
	}

	describe() {
		return {
			frozen: this.frozen,
			paused: this.paused,
			blocks: this.blocks,
			caps: {
				max_open_positions: this.cfg.max_open_positions,
				max_entries_per_hour: this.cfg.max_entries_per_hour,
				daily_loss_cap_sol: this.cfg.daily_loss_cap_sol,
				base_size_sol: this.cfg.base_size_sol,
				max_position_fraction: this.cfg.max_position_fraction,
				reserve_sol: this.cfg.min_wallet_reserve_sol,
			},
			wallet_sol: sol(this.ledger.walletLamports),
		};
	}

	toJSON() {
		return { frozen: this.frozen, paused: this.paused, blocks: this.blocks };
	}
}
