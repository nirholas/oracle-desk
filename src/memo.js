// The head of desk's review memo, written by Claude from the review's numbers.
//
// Optional: enabled only when ANTHROPIC_API_KEY is set. The memo narrates what
// the head decided; it never decides anything. Every number in the prompt is
// the desk's own, so the memo cannot invent a trade.

import { sol } from './ledger.js';

const MODEL = 'claude-opus-5-5';

const SYSTEM = [
	'You are the head of an autonomous pump.fun trading desk writing your review memo.',
	'Write at most 80 words, plain prose, no lists, no headers, no emoji.',
	'Use only the numbers given. Never invent trades, prices, or coins.',
	'Say what the desk decided this review and why, then the one thing to watch next.',
].join(' ');

export class Memo {
	constructor({ apiKey }) {
		this.enabled = Boolean(apiKey);
		this.apiKey = apiKey;
		this.model = MODEL;
		this.client = null;
	}

	async getClient() {
		if (!this.client) {
			const { default: Anthropic } = await import('@anthropic-ai/sdk');
			this.client = new Anthropic({ apiKey: this.apiKey });
		}
		return this.client;
	}

	brief({ roster, outcome, ledger, revisions }) {
		const seats = roster.map(({ seat, grade }) => ({
			seat: seat.id,
			thesis: seat.thesis,
			trades: grade.n,
			wins: grade.wins,
			net_sol: Number(sol(grade.netLamports).toFixed(4)),
			score: grade.score,
			budget: seat.budget,
			bars: seat.checks,
		}));
		return JSON.stringify({
			decision: outcome,
			wallet_sol: Number(sol(ledger.walletLamports).toFixed(4)),
			vault_sol: Number(sol(ledger.vaultLamports).toFixed(4)),
			net_sol: Number(sol(ledger.netLamports()).toFixed(4)),
			open_positions: ledger.open().length,
			seats,
			recent_revisions: revisions.map((r) => `${r.seat} ${r.key} ${r.from}->${r.to}: ${r.why}`),
		});
	}

	async write(review) {
		const client = await this.getClient();
		const response = await client.beta.messages.create({
			model: this.model,
			max_tokens: 16000,
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: { effort: 'low' },
			system: SYSTEM,
			messages: [{ role: 'user', content: `This review's numbers:\n${this.brief(review)}` }],
		});
		if (response.stop_reason === 'refusal') return null;
		const text = response.content
			.filter((b) => b.type === 'text')
			.map((b) => b.text)
			.join(' ')
			.trim();
		return text || null;
	}
}
