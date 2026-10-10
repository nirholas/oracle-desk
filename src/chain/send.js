// Sign, send and confirm, then read what the trade actually did.
//
// Compute limit comes from simulating the exact transaction; the priority fee
// is the 75th percentile of what the network paid recently for the accounts
// involved. After confirmation the fill is read back from the transaction's own
// balance deltas, so the book records what landed, not what was quoted.

import {
	ComputeBudgetProgram,
	TransactionMessage,
	VersionedTransaction,
} from '@solana/web3.js';

const CU_FLOOR = 60_000;
const CU_CEIL = 1_000_000;
const FEE_FLOOR_MICRO = 5_000;
const FEE_CEIL_MICRO = 2_000_000;
const CONFIRM_TIMEOUT_MS = 60_000;

function percentile(values, p) {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function stripComputeBudget(instructions) {
	const id = ComputeBudgetProgram.programId.toBase58();
	return instructions.filter((ix) => ix.programId.toBase58() !== id);
}

async function priorityFeeMicroLamports(connection, instructions) {
	const writable = new Map();
	for (const ix of instructions) {
		for (const k of ix.keys) if (k.isWritable) writable.set(k.pubkey.toBase58(), k.pubkey);
	}
	try {
		const fees = await connection.getRecentPrioritizationFees({ lockedWritableAccounts: [...writable.values()].slice(0, 128) });
		const paid = fees.map((f) => f.prioritizationFee).filter((f) => f > 0);
		return Math.max(FEE_FLOOR_MICRO, Math.min(FEE_CEIL_MICRO, percentile(paid, 75)));
	} catch {
		return FEE_FLOOR_MICRO;
	}
}

function compile(payer, blockhash, instructions) {
	return new VersionedTransaction(
		new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message(),
	);
}

/**
 * Send `instructions` signed by `keypair`. Throws with the program logs when
 * simulation or the chain rejects it.
 * @returns {Promise<{ signature: string, feeLamports: number, cuLimit: number, microLamports: number }>}
 */
export async function sendInstructions(connection, keypair, instructions) {
	const core = stripComputeBudget(instructions);
	const payer = keypair.publicKey;
	const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

	const probe = compile(payer, blockhash, [ComputeBudgetProgram.setComputeUnitLimit({ units: CU_CEIL }), ...core]);
	const sim = await connection.simulateTransaction(probe, { sigVerify: false, replaceRecentBlockhash: true });
	if (sim.value.err) {
		const tail = (sim.value.logs || []).slice(-6).join(' | ');
		throw Object.assign(new Error(`simulation rejected the trade: ${JSON.stringify(sim.value.err)} ${tail}`), { code: 'simulation_failed' });
	}
	const cuLimit = Math.max(CU_FLOOR, Math.min(CU_CEIL, Math.ceil((sim.value.unitsConsumed || 200_000) * 1.2)));
	const microLamports = await priorityFeeMicroLamports(connection, core);

	const tx = compile(payer, blockhash, [
		ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
		ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
		...core,
	]);
	tx.sign([keypair]);
	const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });

	const confirmed = await Promise.race([
		connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed'),
		new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error(`not confirmed within ${CONFIRM_TIMEOUT_MS / 1000}s`), { code: 'confirm_timeout', signature })), CONFIRM_TIMEOUT_MS)),
	]);
	if (confirmed.value.err) {
		throw Object.assign(new Error(`transaction failed on chain: ${JSON.stringify(confirmed.value.err)}`), { code: 'tx_failed', signature });
	}
	return { signature, cuLimit, microLamports };
}

/**
 * What a confirmed transaction did to `owner`: SOL moved (fees included) and
 * the change in their balance of `mint`.
 * @returns {Promise<{ solDeltaLamports: number, tokenDelta: bigint, feeLamports: number }>}
 */
export async function readFill(connection, signature, owner, mint) {
	let tx = null;
	for (let i = 0; i < 10 && !tx; i++) {
		tx = await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
		if (!tx) await new Promise((r) => setTimeout(r, 800));
	}
	if (!tx?.meta) throw Object.assign(new Error(`transaction ${signature} not readable yet`), { code: 'fill_unreadable', signature });
	const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
	const ownerStr = owner.toBase58();
	let ownerIndex = -1;
	for (let i = 0; i < keys.length; i++) {
		if (keys.get(i)?.toBase58() === ownerStr) {
			ownerIndex = i;
			break;
		}
	}
	const solDeltaLamports = ownerIndex >= 0 ? tx.meta.postBalances[ownerIndex] - tx.meta.preBalances[ownerIndex] : 0;
	const sum = (rows) =>
		(rows || [])
			.filter((b) => b.owner === ownerStr && b.mint === String(mint))
			.reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
	const tokenDelta = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
	return { solDeltaLamports, tokenDelta, feeLamports: tx.meta.fee };
}
