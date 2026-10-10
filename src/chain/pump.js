// pump.fun venue: quote and build trades on the bonding curve, and on the
// canonical PumpSwap pool once a coin has graduated.
//
// All pricing comes from the official SDKs (@pump-fun/pump-sdk and
// @pump-fun/pump-swap-sdk), fees included, so paper fills and live fills are
// priced by the exact same math. Every quote fails closed: a missing or zero
// number throws instead of reading as a free or worthless trade.

import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import {
	OnlinePumpSdk,
	PUMP_SDK,
	bondingCurveMarketCap,
	getBuySolAmountFromTokenAmount,
	getBuyTokenAmountFromSolAmount,
	getSellSolAmountFromTokenAmount,
} from '@pump-fun/pump-sdk';
import {
	OnlinePumpAmmSdk,
	PumpAmmSdk,
	buyQuoteInput,
	canonicalPumpPoolPda,
	sellBaseInput,
} from '@pump-fun/pump-swap-sdk';

const WSOL = 'So11111111111111111111111111111111111111112';
// A key nobody holds, used as the "user" when paper mode reads pool state that
// only needs a user to derive token accounts it never touches.
const READ_ONLY_USER = new PublicKey('11111111111111111111111111111112');
const GLOBAL_TTL_MS = 60_000;

const bn = (v) => new BN(BigInt(v).toString());
const big = (v) => BigInt(v.toString());

export class VenueError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

function requirePositive(value, what) {
	if (value == null) throw new VenueError('quote_unpriced', `${what} was not priced`);
	const v = big(value);
	if (v <= 0n) throw new VenueError('quote_unpriced', `${what} priced at zero`);
	return v;
}

export class PumpVenue {
	constructor({ rpcUrl, connection } = {}) {
		this.connection = connection || new Connection(rpcUrl, 'confirmed');
		this.online = new OnlinePumpSdk(this.connection);
		this.ammOnline = new OnlinePumpAmmSdk(this.connection);
		this.ammOffline = new PumpAmmSdk();
		this.globals = null;
		this.graduated = new Set();
		this.tokenPrograms = new Map();
	}

	/** The program that owns the mint: classic SPL Token or Token-2022. */
	async baseTokenProgram(mintPk) {
		const key = mintPk.toBase58();
		if (this.tokenPrograms.has(key)) return this.tokenPrograms.get(key);
		const info = await this.connection.getAccountInfo(mintPk);
		if (!info) throw new VenueError('mint_not_found', `mint ${key} does not exist`);
		const owner = info.owner.toBase58();
		if (owner !== TOKEN_PROGRAM_ID.toBase58() && owner !== TOKEN_2022_PROGRAM_ID.toBase58()) {
			throw new VenueError('mint_program_unknown', `mint ${key} is owned by ${owner}`);
		}
		this.tokenPrograms.set(key, info.owner);
		return info.owner;
	}

	markGraduated(mint) {
		this.graduated.add(String(mint));
	}

	async curveGlobals() {
		const now = Date.now();
		if (this.globals && now - this.globals.at < GLOBAL_TTL_MS) return this.globals;
		const [global, feeConfig] = await Promise.all([
			this.online.fetchGlobal(),
			this.online.fetchFeeConfig().catch(() => null),
		]);
		this.globals = { global, feeConfig, at: now };
		return this.globals;
	}

	/** 'curve' while the bonding curve is live, 'amm' once graduated. */
	async venue(mint) {
		const key = String(mint);
		if (this.graduated.has(key)) return 'amm';
		const curve = await this.online.fetchBondingCurve(new PublicKey(key));
		if (curve.complete) {
			this.graduated.add(key);
			return 'amm';
		}
		return 'curve';
	}

	async ammState(mint, user = READ_ONLY_USER) {
		const poolKey = canonicalPumpPoolPda(new PublicKey(String(mint)));
		let state;
		try {
			state = await this.ammOnline.swapSolanaState(poolKey, user);
		} catch (err) {
			throw new VenueError('pool_not_found', `no PumpSwap pool for ${mint}: ${err.message}`);
		}
		if (state.pool.quoteMint.toBase58() !== WSOL) {
			throw new VenueError('pool_not_sol', `pool for ${mint} is not SOL-quoted`);
		}
		const effective = big(state.poolQuoteAmount) + big(state.pool.virtualQuoteReserves ?? 0);
		if (effective <= 0n) throw new VenueError('pool_empty', `pool for ${mint} has no quote depth`);
		return { state, effective };
	}

	ammArgs(state) {
		// The SDK adds virtualQuoteReserves itself: pass the raw vault balance
		// beside it, never a pre-summed reserve, or depth is counted twice.
		return {
			baseReserve: state.poolBaseAmount,
			quoteReserve: state.poolQuoteAmount,
			virtualQuoteReserves: state.pool.virtualQuoteReserves,
			globalConfig: state.globalConfig,
			baseMintAccount: state.baseMintAccount,
			baseMint: state.pool.baseMint,
			quoteMint: state.pool.quoteMint,
			isMayhemMode: state.pool.isMayhemMode,
			creatorFeeBps: state.pool.creatorFeeBps,
			coinCreator: state.pool.coinCreator,
			creator: state.pool.creator,
			feeConfig: state.feeConfig,
		};
	}

	/**
	 * What `lamports` buys right now.
	 * @returns {{ venue, tokens: bigint, costLamports: bigint, priceImpactPct: number, mayhem: boolean }}
	 */
	async quoteBuy(mint, lamports, slippagePct = 5) {
		const venue = await this.venue(mint);
		if (venue === 'amm') {
			const { state, effective } = await this.ammState(mint);
			const r = buyQuoteInput({ quote: bn(lamports), slippage: slippagePct, ...this.ammArgs(state) });
			const tokens = requirePositive(r.base, 'AMM buy');
			const spot = (Number(lamports) * Number(state.poolBaseAmount)) / Number(effective);
			const impact = spot > 0 ? Math.max(0, ((spot - Number(tokens)) / spot) * 100) : 100;
			// Real SOL in the vault, excluding virtual boost depth: what a seller
			// can actually be paid out of.
			const realQuoteLamports = big(state.poolQuoteAmount);
			return { venue, tokens, costLamports: BigInt(lamports), priceImpactPct: impact, mayhem: Boolean(state.pool.isMayhemMode), realQuoteLamports };
		}
		const { global, feeConfig } = await this.curveGlobals();
		const curve = await this.online.fetchBondingCurve(new PublicKey(String(mint)));
		const quoteMint = curve.quoteMint && curve.quoteMint.toBase58() !== PublicKey.default.toBase58() ? curve.quoteMint : new PublicKey(WSOL);
		if (quoteMint.toBase58() !== WSOL) throw new VenueError('curve_not_sol', `curve for ${mint} is not SOL-quoted`);
		const mintSupply = curve.tokenTotalSupply;
		const tokens = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: curve, amount: bn(lamports), quoteMint });
		const tokensOut = requirePositive(tokens, 'curve buy');
		const cost = getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: curve, amount: tokens, quoteMint });
		const mcap = bondingCurveMarketCap({ mintSupply, virtualQuoteReserves: curve.virtualQuoteReserves, virtualTokenReserves: curve.virtualTokenReserves });
		const impact = Number(mcap) > 0 ? Math.min(100, (Number(lamports) / Number(mcap)) * 100) : 100;
		return { venue, tokens: tokensOut, costLamports: big(cost), priceImpactPct: impact, mayhem: Boolean(curve.isMayhemMode) };
	}

	/** What selling `tokens` returns right now, in lamports. */
	async quoteSell(mint, tokens, slippagePct = 5) {
		const venue = await this.venue(mint);
		if (venue === 'amm') {
			const { state } = await this.ammState(mint);
			const r = sellBaseInput({ base: bn(tokens), slippage: slippagePct, ...this.ammArgs(state) });
			return { venue, lamports: requirePositive(r.uiQuote ?? r.minQuote, 'AMM sell') };
		}
		const { global, feeConfig } = await this.curveGlobals();
		const curve = await this.online.fetchBondingCurve(new PublicKey(String(mint)));
		const out = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: curve.tokenTotalSupply, bondingCurve: curve, amount: bn(tokens) });
		return { venue, lamports: requirePositive(out, 'curve sell') };
	}

	/** Instructions for a live buy of `lamports` from `user`. */
	async buildBuy(mint, user, lamports, slippagePct = 5) {
		const mintPk = new PublicKey(String(mint));
		const venue = await this.venue(mintPk);
		if (venue === 'amm') {
			const { state } = await this.ammState(mintPk, user);
			return { venue, instructions: await this.ammOffline.buyQuoteInput(state, bn(lamports), slippagePct) };
		}
		const { global, feeConfig } = await this.curveGlobals();
		const tokenProgram = await this.baseTokenProgram(mintPk);
		const buyState = await this.online.fetchBuyState(mintPk, user, tokenProgram);
		if (buyState.bondingCurve.complete) {
			this.markGraduated(mintPk);
			return this.buildBuy(mint, user, lamports, slippagePct);
		}
		const mintSupply = buyState.bondingCurve.tokenTotalSupply;
		const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: buyState.bondingCurve, amount: bn(lamports), quoteMint: buyState.quoteMint });
		requirePositive(amount, 'curve buy');
		const quoteAmount = getBuySolAmountFromTokenAmount({ global, feeConfig, mintSupply, bondingCurve: buyState.bondingCurve, amount, quoteMint: buyState.quoteMint });
		const instructions = await PUMP_SDK.buyV2Instructions({
			global,
			bondingCurveAccountInfo: buyState.bondingCurveAccountInfo,
			bondingCurve: buyState.bondingCurve,
			associatedUserAccountInfo: buyState.associatedUserAccountInfo,
			mint: mintPk,
			user,
			amount,
			quoteAmount,
			slippage: slippagePct,
			tokenProgram,
			quoteTokenProgram: buyState.quoteTokenProgram,
		});
		return { venue, instructions };
	}

	/** Instructions for a live sell of `tokens` from `user`. */
	async buildSell(mint, user, tokens, slippagePct = 5) {
		const mintPk = new PublicKey(String(mint));
		const venue = await this.venue(mintPk);
		if (venue === 'amm') {
			const { state } = await this.ammState(mintPk, user);
			return { venue, instructions: await this.ammOffline.sellBaseInput(state, bn(tokens), slippagePct) };
		}
		const { global, feeConfig } = await this.curveGlobals();
		const tokenProgram = await this.baseTokenProgram(mintPk);
		const sellState = await this.online.fetchSellState(mintPk, user, tokenProgram);
		if (sellState.bondingCurve.complete) {
			this.markGraduated(mintPk);
			return this.buildSell(mint, user, tokens, slippagePct);
		}
		const quoteAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: sellState.bondingCurve.tokenTotalSupply, bondingCurve: sellState.bondingCurve, amount: bn(tokens) });
		const instructions = await PUMP_SDK.sellV2Instructions({
			global,
			bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
			bondingCurve: sellState.bondingCurve,
			mint: mintPk,
			user,
			amount: bn(tokens),
			quoteAmount,
			slippage: slippagePct,
			tokenProgram,
			quoteTokenProgram: sellState.quoteTokenProgram,
		});
		return { venue, instructions };
	}
}
