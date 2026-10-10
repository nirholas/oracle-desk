import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRevert, probeLamports } from '../src/chain/firewall.js';
import { sameOrigin } from '../src/server.js';
import { loadKeypair } from '../src/chain/wallet.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

test('the round-trip probe shrinks to what the payer can fund', () => {
	assert.equal(probeLamports(100_000_000n, null), 100_000_000n);
	assert.equal(probeLamports(100_000_000n, 1_000_000_000n), 100_000_000n);
	assert.equal(probeLamports(100_000_000n, 50_000_000n), 44_000_000n);
	assert.equal(probeLamports(100_000_000n, 6_500_000n), null);
});

test('only a sell-leg revert reads as a trap', () => {
	assert.equal(classifyRevert({ InstructionError: [1, { Custom: 6000 }] }, [], 3).status, 'warn');
	assert.equal(classifyRevert({ InstructionError: [4, { Custom: 6000 }] }, [], 3).status, 'fail');
	assert.equal(classifyRevert('InsufficientFundsForFee', [], 3).status, 'warn');
	assert.equal(classifyRevert({ InstructionError: [5, 'X'] }, ['Program log: insufficient lamports 1, need 2'], 3).leg, 'buy');
});

test('controls only accept same-origin requests', () => {
	assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4180', origin: 'http://127.0.0.1:4180' } }), true);
	assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4180', origin: 'https://evil.example' } }), false);
	assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4180' } }), false);
	assert.equal(sameOrigin({ headers: { host: '127.0.0.1:4180', origin: 'not a url' } }), false);
});

test('a keypair loads from base58 or a JSON byte array', () => {
	const kp = Keypair.generate();
	assert.equal(loadKeypair({ secretKey: bs58.encode(kp.secretKey) }).publicKey.toBase58(), kp.publicKey.toBase58());
	assert.equal(loadKeypair({ secretKey: JSON.stringify([...kp.secretKey]) }).publicKey.toBase58(), kp.publicKey.toBase58());
	assert.equal(loadKeypair({}), null);
	assert.throws(() => loadKeypair({ secretKey: '[1,2,3]' }), /64 bytes/);
});
