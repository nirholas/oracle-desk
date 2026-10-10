// The last check before money moves. Read-only: it never signs.
//
//   authority   a mint that can still be minted or frozen by someone is refused
//   mayhem      coins in pump.fun's mayhem mode trade against a protocol agent
//   round_trip  simulate buying and immediately selling in one transaction; a
//               coin whose sell leg reverts is a trap you cannot exit
//
// Ported from the three.ws trade firewall. The round trip needs a funded payer
// to simulate from, so it runs whenever the desk has a wallet and is reported
// as skipped (never as passed) when it does not.

import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { getMint, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

const PROBE_RESERVE_LAMPORTS = 6_000_000n;
const MIN_PROBE_LAMPORTS = 1_000_000n;
const FUNDING_SHAPED = /insufficient (lamports|funds)|InsufficientFunds(ForFee|ForRent)?|AccountNotFound/i;

/** Largest probe the payer can fund, never above the real entry. Null when none. */
export function probeLamports(entryLamports, balanceLamports) {
	if (balanceLamports == null) return BigInt(entryLamports);
	const affordable = BigInt(balanceLamports) - PROBE_RESERVE_LAMPORTS;
	if (affordable < MIN_PROBE_LAMPORTS) return null;
	return affordable < BigInt(entryLamports) ? affordable : BigInt(entryLamports);
}

/**
 * Which leg of a reverted round trip failed. Only a SELL-leg failure is the
 * trap shape; a buy-leg or funding failure says nothing about sellability.
 */
export function classifyRevert(simErr, logs, buyIxCount) {
	const err = typeof simErr === 'object' ? JSON.stringify(simErr) : String(simErr);
	const ix = Array.isArray(simErr?.InstructionError) ? Number(simErr.InstructionError[0]) : null;
	if (ix != null && ix < buyIxCount) return { leg: 'buy', status: 'warn', reason: 'buy leg reverted' };
	if (FUNDING_SHAPED.test(err) || (logs || []).some((l) => FUNDING_SHAPED.test(String(l)))) {
		return { leg: 'buy', status: 'warn', reason: 'probe underfunded' };
	}
	return { leg: 'sell', status: 'fail', reason: 'sell leg reverts: cannot exit' };
}

export class Firewall {
	constructor({ venue, connection }) {
		this.venue = venue;
		this.connection = connection;
	}

	async authority(mintPk) {
		const program = await this.venue.baseTokenProgram(mintPk);
		const mint = await getMint(this.connection, mintPk, 'confirmed', program);
		if (mint.mintAuthority) return { check: 'authority', status: 'fail', reason: 'mint authority still active' };
		if (mint.freezeAuthority) return { check: 'authority', status: 'fail', reason: 'freeze authority still active' };
		return { check: 'authority', status: 'pass', reason: program.equals(TOKEN_2022_PROGRAM_ID) ? 'renounced (token-2022)' : 'renounced' };
	}

	async roundTrip(mint, payer, entryLamports, balanceLamports) {
		if (!payer) return { check: 'round_trip', status: 'skip', reason: 'no wallet to simulate from' };
		const probe = probeLamports(entryLamports, balanceLamports);
		if (probe == null) return { check: 'round_trip', status: 'warn', reason: 'wallet too thin to probe' };
		const quote = await this.venue.quoteBuy(mint, probe, 15);
		const buy = await this.venue.buildBuy(mint, payer, probe, 15);
		const sell = await this.venue.buildSell(mint, payer, quote.tokens, 99);
		const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
		const tx = new VersionedTransaction(
			new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...buy.instructions, ...sell.instructions] }).compileToV0Message(),
		);
		const sim = await this.connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
		if (sim.value.err) {
			const v = classifyRevert(sim.value.err, sim.value.logs, buy.instructions.length);
			return { check: 'round_trip', status: v.status, reason: v.reason };
		}
		return { check: 'round_trip', status: 'pass', reason: `buy and sell both execute (${buy.venue})` };
	}

	/**
	 * Run every check. `ok` is false on any fail, and on an error inside a
	 * check: the firewall fails closed.
	 */
	async assess({ mint, payer, entryLamports, balanceLamports, mayhem }) {
		const mintPk = new PublicKey(String(mint));
		const results = [];
		results.push(mayhem ? { check: 'mayhem', status: 'fail', reason: 'coin is in mayhem mode' } : { check: 'mayhem', status: 'pass', reason: 'normal mode' });
		for (const run of [() => this.authority(mintPk), () => this.roundTrip(mint, payer, entryLamports, balanceLamports)]) {
			try {
				results.push(await run());
			} catch (err) {
				results.push({ check: 'error', status: 'fail', reason: err.message.slice(0, 160) });
			}
		}
		return { ok: results.every((r) => r.status !== 'fail'), results };
	}
}
