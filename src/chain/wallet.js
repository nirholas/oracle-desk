// The trading keypair. Self-custody only: the key stays in your environment or
// on your disk and is never sent anywhere; it only signs locally.

import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

function fromBytes(bytes) {
	const arr = Uint8Array.from(bytes);
	if (arr.length !== 64) throw new Error(`a Solana secret key is 64 bytes, got ${arr.length}`);
	return Keypair.fromSecretKey(arr);
}

/** Parse a base58 secret, a JSON byte array, or read a keypair file. */
export function loadKeypair({ secretKey, keypairPath }) {
	if (keypairPath) return fromBytes(JSON.parse(readFileSync(keypairPath, 'utf8')));
	if (!secretKey) return null;
	const trimmed = secretKey.trim();
	if (trimmed.startsWith('[')) return fromBytes(JSON.parse(trimmed));
	return fromBytes(bs58.decode(trimmed));
}
