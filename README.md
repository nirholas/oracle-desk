# Oracle Desk

**An autonomous pump.fun trading desk that fires its own strategies.** Six desks and a head of desk run
every new launch through radar, research, risk and execution. Every trade is graded on realized P&L.
When a strategy seat keeps losing, the head fires it, and the audit desk rewrites that seat's bars from
its own trade history.

Nothing on this desk is simulated. Launches come off the real pump.fun firehose, every coin is scored by
the live [three.ws Oracle](https://three.ws/oracle), and every fill is priced by the official pump.fun
SDKs against the real bonding curve or PumpSwap pool. Paper mode, the default, books those real quotes
and signs nothing. Live mode signs the same trades from your own keypair.

```
LAUNCHES ─▶ RADAR ─▶ RESEARCH ─▶ RISK ─▶ EXECUTION ─▶ AUDIT ─▶ seat bars move
  (every mint)   (Oracle verdicts)  (4 seats)  (caps)   (curve / pool)  (graded P&L)
                                                                  │
                         HEAD OF DESK ◀── realized record ────────┘
                  promotes the best seat · fires the worst · rewrites it from its own trades
                                  TREASURY freezes on drawdown, sweeps profit
```

## Quickstart

```bash
git clone https://github.com/nirholas/oracle-desk
cd oracle-desk
npm install
npm start
```

Open **http://127.0.0.1:4180**. The desk starts in paper mode with 5 SOL of paper balance, connects to
the pump.fun launch feed and the Oracle's live verdict stream, and begins judging coins immediately. No
API key and no account are needed.

`npm run status` prints the scoreboard from the saved book at any time, and `Ctrl+C` stops the desk and
prints it too. The book, the seats and their history are saved under `data/`, so a restart continues
where it left off. `node bin/oracle-desk.js run --reset` starts a fresh book.

## The desk

| Desk | Agents | What it does |
| --- | --- | --- |
| **Head of desk** | HEAD | Never trades. Each review (hourly by default) it grades every seat on its current window, adds budget to the best, and fires the worst if it is under the bar. At most one firing per cooldown, and never a seat with fewer than four closed trades. |
| **01 Radar** | LAUNCHES, STREAM, SWEEP | Sees everything, buys nothing. Counts every pump.fun mint from PumpPortal, receives every Oracle verdict over SSE the moment it is scored, and sweeps the Oracle feed on a timer so nothing is missed between stream connections. |
| **02 Research** | PRIME, MOMENTUM, STRUCTURE, SMART-MONEY | Four strategy seats, each a set of bars over the Oracle's published verdict: conviction score, rug risk, give-back risk, the four pillars, smart-wallet count, and coin age. Every seat judges every verdict; the seat with the widest margin claims the coin and owns the result. |
| **03 Execution** | SNIPER, ROUTER, LADDER | Quotes the bonding curve or the PumpSwap pool, runs the firewall, takes the fill, and works the exit ladder on every holding every few seconds. |
| **04 Risk** | RISK | Outranks everyone, the head included. Position size, open-position cap, hourly entry cap, daily loss cap, wallet reserve, a price-impact breaker, and a floor on the real SOL in a graduated pool. |
| **05 Audit** | GRADER, TUNER | Grades every closed trade against the seat that claimed it. After a loss, the check that came closest to refusing that coin moves one step stricter; after a clean win (1.5x or better) it relaxes half a step. Every bar has hard clamps, so the loop can never strangle a seat into silence. |
| **06 Treasury** | VAULT | Freezes new entries when equity falls below 60% of the start, lifts the freeze at 90%, and sweeps profit above 1.5x the start out of the hot wallet. |

### How a firing works

A seat's grade is half its smoothed win rate and half its net return on what it risked. When the head
fires a seat, audit refits each of its bars against the seat's own closed trades: candidate bars sit
between the values its entries actually showed, and a bar moves only if the new position would have kept
strictly more net P&L. The seat then starts a fresh window at 1x budget to prove the new configuration.
The dashboard and the tape show exactly which bars moved and which trades each move would have cut.

### Exits

The exit ladder is the one the three.ws sniper fleet runs on real money:

- **Hard stop** at -35%: a full exit while the stake is still at risk.
- **Take initials** at 2x: sell exactly enough to get the stake back, never more.
- **Trailing stop** at 25% from the peak, armed only once the position has been green.
- **A bag always rides** once the stake is back: a terminal exit in profit keeps at least 15%, which is
  then house money, marked to market, and outside the position slots.
- **Dead liquidity**: an underwater position whose quote has not moved for 3 minutes is closed.
- **Timeout** at 45 minutes.

## What "real" means here

- **Launches**: the PumpPortal public websocket (`subscribeNewToken`, `subscribeMigration`).
- **Scores**: the three.ws Oracle's public API, no key. `GET /api/oracle/feed` for the backlog,
  `/api/oracle/stream` (SSE) for live verdicts. Each verdict carries score, tier, the four pillars, rug
  risk, give-back risk, the measured hit rate for its band, and the plain-language reasons.
- **The model**: the Oracle's published conviction model is loaded through
  [`@three-ws/oracle-model`](https://www.npmjs.com/package/@three-ws/oracle-model), which the dashboard
  uses to show each position's probability of running and holding. The model, its weights and its
  held-out performance are public at [three.ws/oracle-lab](https://three.ws/oracle-lab).
- **Prices**: `@pump-fun/pump-sdk` on the bonding curve and `@pump-fun/pump-swap-sdk` on the graduated
  pool, fees included. Paper fills also pay what a live trade pays beyond the quote: the network and
  priority fee, and the rent a first buy locks in the token account (returned when a full exit closes it).
  An immediate buy-then-sell round trip returns about 97% on both venues, which is pump.fun's fees.
- **The firewall** refuses a mint that can still be minted or frozen, a coin in mayhem mode, and (when a
  wallet is present) any coin whose sell leg reverts when a buy and an immediate sell are simulated
  together in one transaction.

## Live mode

Live mode signs real transactions from your keypair. Memecoins routinely go to zero, a stop can fill far
below its trigger when a coin collapses between two sweeps, and past results say nothing about the next
trade. Run paper first, and only fund the trading wallet with what you can lose.

```bash
cp .env.example .env
# then set, in .env:
DESK_MODE=live
DESK_LIVE_ACK=I_UNDERSTAND_REAL_FUNDS
SOLANA_PRIVATE_KEY=<base58 secret or JSON byte array>   # or DESK_KEYPAIR=/path/to/id.json
SOLANA_RPC_URL=<a dedicated mainnet RPC>
DESK_COLD_WALLET=<optional: where treasury sweeps profit>
```

The key never leaves the process: it only signs locally. Every buy and sell is simulated first for its
compute limit, priced with the 75th percentile of recent priority fees for the accounts it touches, and
booked from the confirmed transaction's own balance changes rather than from the quote. The dashboard
binds to `127.0.0.1` and its controls accept only same-origin requests.

The risk caps in `desk.config.json` are the spending limits; read them before going live. A live desk
treats the wallet's on-chain balance as the truth and re-reads it every 30 seconds, so a deposit shows up
as profit; start with `--reset` after funding to set a clean baseline.

## Configuration

`desk.config.json` is the org chart. Everything is plain JSON:

| Key | Meaning |
| --- | --- |
| `head.review_every_minutes`, `fire_below_score`, `min_trades_to_judge`, `cooldown_minutes` | When and how the head judges seats. |
| `research.seats[]` | Each seat's `id`, `thesis` and starting `checks`. Available checks: `min_score`, `max_rug_risk`, `max_give_back`, `min_momentum`, `min_structure`, `min_pedigree`, `min_smart_wallets`, `max_age_s`. |
| `risk.*` | Entry size, caps, the price-impact breaker, the pool liquidity floor, slippage. |
| `exits.*` | The ladder above, plus the sweep interval. |
| `treasury.*` | Freeze and sweep thresholds. |

Environment variables are documented in [`.env.example`](.env.example). Set `ANTHROPIC_API_KEY` and the
head writes a short memo narrating each review; its decisions never depend on the memo.

## Develop

```bash
npm test
```

Tests cover the exit ladder, seat evaluation and refits, the ledger's accounting through a full ladder,
every risk gate, the audit and head rules, treasury, execution end to end, the firewall's classifiers,
the dashboard's origin check and key loading.

| Path | What lives there |
| --- | --- |
| `bin/oracle-desk.js` | The CLI: `run` and `status`. |
| `src/runtime.js` | Wires the desks, persists the book, builds the dashboard snapshot. |
| `src/desks/` | One file per desk, plus the head. |
| `src/seats.js` | Check definitions, evaluation, grading, and the refit. |
| `src/exit-logic.js` | The pure exit ladder. |
| `src/chain/` | Venue quotes and builds, sending, the firewall, the keypair loader. |
| `src/brokers.js` | Paper and live brokers behind one interface. |
| `web/` | The dashboard, in the three.ws Oracle theme. |

## About

Oracle Desk is built by [three.ws](https://three.ws), where the Oracle scores every pump.fun launch and
3D AI agents trade on it. The platform's coin is **$THREE**
(`FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`). Nothing here is financial advice.

Apache-2.0. This repository is exported from the three.ws monorepo, which is its source of truth; see
[CONTRIBUTING.md](CONTRIBUTING.md).
