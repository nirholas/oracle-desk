// Two brokers, one interface. The desks never know which one they are talking
// to; the only difference is whether a transaction gets signed.
//
//   buy(mint, lamports)   -> { tokens, costLamports, venue, sig }
//   sell(mint, tokens, { closeAccount }) -> { soldTokens, proceedsLamports, venue, sig }
//   mark(mint, tokens)    -> lamports the position would sell for right now
//   balance()             -> trading wallet balance in lamports

import { SystemProgram, PublicKey } from '@solana/web3.js';
import { createCloseAccountInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { readFill, sendInstructions } from './chain/send.js';

// What a live trade really costs beyond the quote, charged to paper fills so
// paper P&L is not flattered: the base fee plus a typical priority fee, and the
// rent a first buy locks in the token account (returned when it is closed).
export const PAPER_TX_FEE_LAMPORTS = 105_000;
export const TOKEN_ACCOUNT_RENT_LAMPORTS = 2_039_280;

export class PaperBroker {
	constructor({ venue, ledger, slippagePct }) {
		this.venue = venue;
		this.ledger = ledger;
		this.slippagePct = slippagePct;
		this.mode = 'paper';
		this.payer = null;
	}

	async balance() {
		return this.ledger.walletLamports;
	}

	async quoteEntry(mint, lamports) {
		return this.venue.quoteBuy(mint, lamports, this.slippagePct);
	}

	async buy(mint, lamports, quote) {
		const q = quote || (await this.venue.quoteBuy(mint, lamports, this.slippagePct));
		const cost = Number(q.costLamports) + PAPER_TX_FEE_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS;
		return { tokens: q.tokens, costLamports: cost, venue: q.venue, sig: null };
	}

	async sell(mint, tokens, { closeAccount = false } = {}) {
		const q = await this.venue.quoteSell(mint, tokens, this.slippagePct);
		const proceeds = Number(q.lamports) - PAPER_TX_FEE_LAMPORTS + (closeAccount ? TOKEN_ACCOUNT_RENT_LAMPORTS : 0);
		return { soldTokens: BigInt(tokens), proceedsLamports: proceeds, venue: q.venue, sig: null };
	}

	async mark(mint, tokens) {
		const q = await this.venue.quoteSell(mint, tokens, this.slippagePct);
		return Number(q.lamports);
	}

	async sweep(lamports) {
		return { sent: false, lamports, reason: 'paper vault' };
	}
}

export class LiveBroker {
	constructor({ venue, keypair, slippagePct, coldWallet }) {
		this.venue = venue;
		this.connection = venue.connection;
		this.keypair = keypair;
		this.payer = keypair.publicKey;
		this.slippagePct = slippagePct;
		this.coldWallet = coldWallet ? new PublicKey(coldWallet) : null;
		this.mode = 'live';
	}

	async balance() {
		return this.connection.getBalance(this.payer, 'confirmed');
	}

	async quoteEntry(mint, lamports) {
		return this.venue.quoteBuy(mint, lamports, this.slippagePct);
	}

	async buy(mint, lamports) {
		const built = await this.venue.buildBuy(mint, this.payer, lamports, this.slippagePct);
		const { signature } = await sendInstructions(this.connection, this.keypair, built.instructions);
		const fill = await readFill(this.connection, signature, this.payer, mint);
		if (fill.tokenDelta <= 0n) throw Object.assign(new Error(`buy ${signature} landed but no tokens arrived`), { code: 'empty_fill', signature });
		return { tokens: fill.tokenDelta, costLamports: -fill.solDeltaLamports, venue: built.venue, sig: signature };
	}

	async sell(mint, tokens, { closeAccount = false } = {}) {
		const built = await this.venue.buildSell(mint, this.payer, tokens, this.slippagePct);
		const instructions = [...built.instructions];
		if (closeAccount) {
			// Selling the whole balance: close the emptied token account in the
			// same transaction so its rent comes back with the proceeds.
			const mintPk = new PublicKey(String(mint));
			const program = await this.venue.baseTokenProgram(mintPk);
			const ata = getAssociatedTokenAddressSync(mintPk, this.payer, false, program);
			instructions.push(createCloseAccountInstruction(ata, this.payer, this.payer, [], program));
		}
		const { signature } = await sendInstructions(this.connection, this.keypair, instructions);
		const fill = await readFill(this.connection, signature, this.payer, mint);
		return { soldTokens: -fill.tokenDelta, proceedsLamports: fill.solDeltaLamports, venue: built.venue, sig: signature };
	}

	async mark(mint, tokens) {
		const q = await this.venue.quoteSell(mint, tokens, this.slippagePct);
		return Number(q.lamports);
	}

	/** Send profit to the cold wallet. Without one configured, nothing moves. */
	async sweep(lamports) {
		if (!this.coldWallet) return { sent: false, lamports, reason: 'no DESK_COLD_WALLET set' };
		const ix = SystemProgram.transfer({ fromPubkey: this.payer, toPubkey: this.coldWallet, lamports });
		const { signature } = await sendInstructions(this.connection, this.keypair, [ix]);
		return { sent: true, lamports, sig: signature };
	}
}
