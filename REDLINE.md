# Project RedLine — System Guide

> The autonomous-research, human-approved trading layer of Crucix. This document explains what
> RedLine is, the ideas behind it, how it works end to end, the agent and position lifecycles, and an
> honest accounting of where it's strong and where it isn't.

---

## Table of contents

1. [High concept](#1-high-concept)
2. [Design principles](#2-design-principles)
3. [The decision pipeline](#3-the-decision-pipeline-end-to-end)
4. [Architecture, layer by layer](#4-architecture-layer-by-layer)
5. [Agentic flows — how the agent decides](#5-agentic-flows--how-the-agent-decides)
6. [Position lifecycle — a trade from discovery to exit](#6-position-lifecycle--a-trade-from-discovery-to-exit)
7. [Discovery & the MARKET_SETUPS board](#7-discovery--the-market_setups-board)
8. [Per-position intelligence](#8-per-position-intelligence)
9. [Entry & risk guards](#9-entry--risk-guards)
10. [How it learns](#10-how-it-learns-the-loop-that-matters)
11. [Strengths](#11-strengths)
12. [Weaknesses & limitations](#12-weaknesses--limitations)
13. [Failure modes & safeguards](#13-failure-modes--the-safeguards-that-cover-them)
14. [Where it's headed](#14-where-its-headed)
15. [Worked example — ORCL +12%](#15-worked-example--how-a-new-name-is-discovered-orcl-12)
16. [File map](#16-file-map-where-to-look)

---

## 1. High concept

**RedLine turns a firehose of market + world data into one well-reasoned trade suggestion at a time,
and (by default) asks you before it acts.**

Most retail trading bots are reactive and autonomous: a rule fires, an order goes out. RedLine is the
opposite shape on purpose:

- **One analyst, not a rule engine.** A single LLM agent ("Claude") reviews the whole situation each
  cycle the way a human analyst would — weighing a thesis, a counter-thesis, the portfolio, and its
  own past performance — and emits **at most one** proposal.
- **Recommends, doesn't execute.** Proposals are Accept/Deny cards. Nothing hits the brokerage until
  you approve (unless you explicitly flip on Auto mode). The one exception is capital protection:
  hard stop-losses sell without asking.
- **Breadth most retail systems don't have.** It fuses ~39 live sources — macro/economic, live prices,
  congressional trades, SEC filings, policy/executive actions, semiconductor lead indicators, and
  geopolitical OSINT — into the analyst's view.
- **It learns.** Every resolved trade feeds a track record and a confidence-calibration score back into
  the agent's next decision, so it adjusts toward what has actually worked.

The guiding value: **"survives" beats "looks profitable."** Discipline (stop-losses, a circuit breaker,
position sizing, approval gating) is never waived; aggression is a dial on top of it.

---

## 2. Design principles

1. **Human-in-the-loop by default.** Approval gating is the safety model. Auto mode is opt-in.
2. **Deterministic risk, independent of the model.** The stop-loss watcher and the account circuit
   breaker are plain code with hard thresholds. The LLM cannot argue its way past them.
3. **Quality over quantity.** Most cycles are `NO_ACTION`. A daily new-buy cap and a minimum-conviction
   floor discourage overtrading and coin-flip entries.
4. **Every call is explainable.** Each proposal carries `reasoning`, a `bearCase`, cited `sources`, and
   a `confidence`. Trade and plan reports are generated for the record.
5. **Memory and learning.** A per-stock "stance book" gives cross-cycle consistency; a track record +
   calibration close the feedback loop.
6. **Token-frugal.** The sweep is distilled to a compact digest; the default agent runs on a Claude
   subscription via the CLI rather than per-token API billing.

---

## 3. The decision pipeline (end to end)

```
Sources  →  Synthesize  →  Agent context  →  Claude decides  →  Accept → Execute  →  Feedback ↻
(~39 feeds)  (clean+delta   (+ discovery,     (think → bear      (guards →          (resolve P&L →
             +ideas/theses)  stances, record,  case → ONE call)   place order)       recalibrate)
                             guardrails)              │
                                                      └──→ NO_ACTION (nothing trades)
```

The feedback arrow is the point: resolved outcomes re-enter the agent's context, so the loop tightens
over time. The **stance book** also updates "sideways" every cycle — even on a NO_ACTION sweep the agent
can revise its per-stock plan, so its memory changes far more often than it trades.

---

## 4. Architecture, layer by layer

### 4.1 Data layer — the sweep
`apis/briefing.mjs → fullBriefing()` runs ~39 sources in parallel, each with a 30s timeout; failures
are isolated so one dead feed never stalls the sweep. `dashboard/inject.mjs → synthesize()` maps the raw
payloads into one clean schema. `lib/delta` compares this sweep to the last and gates expensive LLM work
when nothing material changed.

### 4.2 Intelligence layer — shared market read
**Ideas** (`lib/llm/ideas.mjs`) — a market-wide brief, throttled + delta-gated. **Theses**
(`lib/llm/thesis.mjs`) — forward-pacing megatrend → "unpriced rung" maps, cached across restarts. **The
digest** — `compactSweepForLLM()` distills everything the agent needs into a compact text block (the
single biggest token lever).

### 4.3 The agent — one analyst, one call
`lib/llm/analyst.mjs → generateProposal()`: one `provider.complete()` call to Claude (default via the
`claude` CLI; **Gemini** fallback). No tool loop — the context is pre-assembled and the model returns one
JSON object. Horizons double as risk bands: `INTRADAY` (~-2% stop), `SWING` (~-5%), `LONG` (~-12%).

### 4.4 Memory & learning
**Stance book** (`lib/stances/store.mjs`) — the living per-stock plan (stance tag, thesis, entry plan,
exit, confidence, horizon). **Track record** (`lib/llm/trackRecord.mjs`) and **calibration**
(`lib/llm/calibration.mjs`) feed resolved outcomes back in. **Directives** (`lib/directives/store.mjs`).

### 4.5 Risk layer — deterministic, model-independent
**Hard stop-loss watcher** (`lib/alerts/stopLossWatcher.mjs`), **account circuit breaker**
(`lib/risk/circuitBreaker.mjs`), **post-stop moratorium** (`lib/risk/moratorium.mjs`), and mechanical
guards on Accept. See §9.

### 4.6 Execution & lifecycle
`lib/proposals/store.mjs` (status machine) + `server.mjs → acceptProposal` (guards → place → log →
report). See §6.

### 4.7 Delivery & control
**Dashboard** (`dashboard/public/redline.html`), **Telegram** (`lib/alerts/telegram.mjs`), **Propose /
Ask** (`lib/llm/planProposal.mjs`, `lib/llm/newsAsk.mjs`). See §5.

### 4.8 State (`runs/`)
Flat JSON stores: `settings.json`, `stances.json`, `decisions.json` (trade ledger + P&L),
`proposals.json`, `directives.json`, `breaker.json`, `theses.json`, `moratoriums.json`, `ma-state.json`,
`latest.json`.

---

## 5. Agentic flows — how the agent decides

There are three distinct LLM flows. All are **read-mostly** except the sweep, which is the only one that
can propose a trade.

### 5.1 The sweep decision loop (the main agent)
Runs every `REFRESH_INTERVAL_MINUTES`:

```
build context ─▶ THINK FIRST ─▶ PRIORITY (stop at first that applies) ─▶ emit ONE JSON
(digest +        (reasoning +     1. URGENT MAINTENANCE on a held name       (proposal
 MARKET_SETUPS +  strongest        (thesis broken / stop breached / MA        + stanceUpdates[])
 holdings +       bearCase;        cross / insider-13F selling / take-profit)
 stances +        if bear wins     2. BEST NEW_BUY — start from MARKET_SETUPS,
 track record +   → NO_ACTION)        skip support-tests & chases
 directives +                      3. NO_ACTION
 moratoriums +
 strategy mode)
```

- **THINK FIRST** — the prompt forces `reasoning` + the single strongest `bearCase` before a verdict. If
  the bear case beats the bull case, the answer is `NO_ACTION`.
- **One proposal max** — `NEW_BUY`, `MAINTENANCE` (usually a sell), or `NO_ACTION`.
- **Stance updates run every sweep** — even on `NO_ACTION`, the agent revises its per-stock plan
  (`stanceUpdates[]`), so memory changes far more often than it trades.
- **Strategy mode** tunes the *bar for acting* (Conservative/Balanced/Aggressive/Scalper/custom, plus
  regime-aware AUTO), never the risk floors.

### 5.2 Ask (`/ask`, dashboard "Ask") — read-only
Answers questions grounded in the **live plan**: holdings (real P&L), stances, active hard stops, recent
trades, track record, directives, and the current sweep (news/technicals). It explains; it never changes
state. In the news channel, `/ask` answers current-events/geopolitics grounded in the sweep, and can be
a reply to a posted story.

### 5.3 Propose (`/propose`) — user-driven plan edits
The user suggests a change in plain English ("watch URA", "promote MANE to swing", "drop WDC"). The agent
evaluates it against the live plan and returns **ACCEPT / PARTIAL / DENY** with reasoning, then applies
accepted stance edits, a standing directive, or a **horizon retype** of a held position. Reckless ideas
are denied.

---

## 6. Position lifecycle — a trade from discovery to exit

```
DISCOVER ─▶ AGENT JUDGES ─▶ GATES ─▶ EXECUTE ─▶ HOLD / MONITOR ─▶ EXIT ─▶ RECORD
(board      (THINK + bear   (§9)     (place +    (per-sweep        (4 ways    (report +
 surfaces    case; pick a             log +       intel + stance    below)     learn;
 it)         real setup)              stance +    revise + retype)             stop → moratorium)
                                      enforced
                                      stop)
```

**Entry.** A candidate clears the board (§7), the agent judges it a real setup, it passes every gate
(§9), and executes. On fill: the stance becomes `HOLD` with the real entry, the position's **horizon**,
and a **code-enforced hard stop** (the agent's price, or a horizon-derived one).

**Hold / monitor.** Every sweep the position is re-read with company-level depth (§8: news, insider &
13F selling, technicals, fresh MA crosses). The stance is revised as the view changes, and the agent (or
you, via `/propose`) can **retype** it up the horizon ladder (INTRADAY→SWING→LONG) when a winner has more
room — which widens the stop and changes the EOD behavior to match. The **anti-churn** guard stops a
just-entered loser from being whipsawed out on a reversed signal (winners still scalp fast).

**Exit — four ways, each writes a report and closes the stance:**

| Exit | Trigger | Notes |
|---|---|---|
| Agent MAINTENANCE sell | thesis break / take-profit the agent proposes | full exit uses `ClosePosition` (exact quantity, no dust) |
| **Hard stop** | price ≤ the enforced stop | auto-sells, no approval; a loss → **moratorium** (cooldown + logged failure) |
| **Trailing stop** | a profit retraces past the trail distance | locks gains once in profit |
| **EOD profit-lock** | an INTRADAY position up at the close | banks the gain before overnight risk |

**Intraday EOD sub-lifecycle.** A late-session INTRADAY entry is **blocked** (`INTRADAY_ENTRY_CUTOFF` —
no same-day runway). At the close: an INTRADAY **winner** profit-locks; a **loser** holds overnight
(converts to SWING coverage) — "close when up, hold when down."

---

## 7. Discovery & the MARKET_SETUPS board

`lib/discovery/discover.mjs` finds **new** names to buy. Every data source already names tickers — the
board harvests them, scores each, enriches the leaders, and ranks a shortlist the agent hunts from first.

```
WIDE UNIVERSE ─▶ SCORE ─▶ ENRICH TOP ─▶ RANK + FILTER ─▶ AGENT
(every ticker    (catalyst  (news +      (drop below       picks
 any signal       strength)  chart)       MIN_SCORE)        from it
 named, minus
 held/cooldown)
```

**Scoring** (catalyst up, red flags down):

| Adds points | Subtracts points |
|---|---|
| Congressional cluster buy (strong; scales w/ members) | Insider selling |
| Exec insider buy (bigger $ = more) | 13F funds cutting stakes |
| Analyst upgrade | Below its 200-MA (counter-trend) |
| Bullish options sweep | Below 50-MA + downtrend |
| 8-K material event | **50MA support-test** (hugging the 50MA on a pullback — the TSM/IBRX knife-catch) |
| In a HIGH/MED thesis | |
| Big one-day mover (scaled by magnitude) | |
| Confirmed STRONG / BUILDING chart setup | |

Then: drop anything below `DISCOVERY_MIN_SCORE` (noise like a lone +3% wiggle). What reaches the agent is
a ranked line with the catalyst, chart, and any ⚠ flags — e.g.
`MARKET_SETUPS: CEG (score 10 STRONG): insider-buy, bullish-sweep, thesis:AI | >MAs, RSI 61, RS +5 | news: …`.

The agent's NEW_BUY step favors high score + a STRONG/BUILDING setup + **no ⚠ flags**, and is told that
if the best option is a flagged support-test, that's a `NO_ACTION`, not a least-bad buy.

**Limit:** it's **catalyst-and-price triggered** — a name only appears if a signal named it or it moved
enough to rank in movers. A quiet-but-good setup won't surface (no market-wide technical screener yet).

---

## 8. Per-position intelligence

Each sweep, every name you **hold**, have a **stance** on, or that ranks as a **discovery candidate** is
pulled individually — not just as a macro headline:

| Digest line | What it is | Source |
|---|---|---|
| `POSITION_NEWS` | company-specific headlines (rulings, guidance, downgrades…) | Finnhub `/company-news` |
| `INSIDER_SELLS` | execs/directors reducing a holding (bearish) | Finnhub insider txns |
| `INSTITUTIONAL_SELLS` | 13F funds cutting stakes (quarterly, cached) | Finnhub institutional-ownership |
| `POSITION_TECHNICALS` | price vs 50/200-day MA, RSI, RS vs SPY, trend | Alpaca bars |
| `MA_CROSS` | a FRESH cross this sweep (price ±MA, death/golden), hysteresis-debounced | `lib/technicals/maCrossStore.mjs` |

This is what lets the agent catch a thesis-break on a name you own (a court ruling, insiders dumping, a
moving-average breakdown) instead of staying bullish on a stale thesis.

---

## 9. Entry & risk guards

**Entry gates** — a `NEW_BUY` must clear all of these before it's placed (exits/maintenance are never
gated):

| Gate | Blocks | Knob |
|---|---|---|
| Minimum conviction | a coin-flip buy below the confidence floor | `MIN_BUY_CONFIDENCE` (55) |
| Regular session | pre/after-market entries (thin, noisy) | `ALLOW_EXTENDED_HOURS_ENTRY` |
| Intraday cutoff | a late INTRADAY buy with no same-day runway | `INTRADAY_ENTRY_CUTOFF` (1500 ET) |
| Moratorium | re-buying a name that just stopped out | `MORATORIUM_HOURS` (48) |
| Investment type | a horizon the user disabled | `investmentTypes` setting |
| Daily cap | overtrading beyond the day's new-buy budget | `MAX_PROPOSALS_PER_DAY` |
| Buying-power floor | a buy that would drop below the min | `minBuyingPower` setting |
| No-size / price-safety / PDT | an order with no size, an implausible price, or a PDT violation | mechanical |

**Deterministic risk layer** (model cannot override):

- **Hard stop-loss watcher** — auto-sells at the enforced stop (the agent's price or the horizon floor),
  **trails** to lock gains, and runs the intraday EOD lifecycle.
- **Circuit breaker** — halts new buys at `maxDailyLossPct` / `maxDrawdownPct` (maintenance/exits still
  allowed). Pauses new risk; does not auto-flatten.
- **Anti-whipsaw** — MA-cross hysteresis + an anti-churn hold guard.
- **Post-stop moratorium** — cooldown + logged failed thesis after a hard stop.

---

## 10. How it learns (the loop that matters)

1. A proposal is accepted → `logDecisions` records it **with the stated confidence**.
2. `positionResolver` later marks it resolved (win/loss/breakeven + P&L).
3. On the next sweep, `buildTrackRecord()` and `buildCalibration()` inject compact self-corrections.
4. The agent adjusts: downweights losing horizons/signals, leans into winners, recalibrates confidence.

This is the single biggest lever on decision quality. It activates only after a minimum sample
(`TRACK_RECORD_MIN`, `CALIBRATION_MIN`) so it doesn't over-fit two trades.

---

## 11. Strengths

- **Safety-first by construction** — approval gating + a deterministic risk layer the model can't override.
- **Analyst-grade breadth** — macro + policy + congressional + SEC + semiconductor + OSINT in one view.
- **A real discovery funnel** — the board turns the signals you already pay for into a ranked, vetted
  shortlist, with entry guards that filter noise and knife-catches.
- **It explains itself** — reasoning, a bear case, cited sources, a confidence number, and reports.
- **It calibrates** — track record + Brier-scored confidence attacks overconfidence and cutting winners short.
- **Consistency via memory** — the stance book keeps a coherent plan per stock across cycles.
- **Cost-efficient** — token-frugal digest, Claude subscription, mostly free/keyless sources.
- **Tunable aggression without tunable risk.**

---

## 12. Weaknesses & limitations

- **Signal fragility on free tiers** — keyed sources go dark when a quota is exhausted; the agent isn't
  yet told *which* signals are dark.
- **Latency vs. autonomous bots** — approvals at sweep interval; every exit except the hard stop is a
  proposal. A deliberate trade of speed for control.
- **Cold-start + live-only learning** — no backtest/paper harness; the feedback loop costs real trades.
- **LLM variance** — guards catch *mechanically* unsafe orders, not a plausible-looking bad *idea*.
- **Discovery is catalyst/price-triggered** — a quiet-but-good setup won't surface (no market-wide screener).
- **Attribution is per-confidence, not yet per-source** — breadth can add noise.
- **Single-tenant, flat-file state** — `runs/*.json` isn't concurrency-safe or namespaced per user.
- **Operational dependencies + market-hours bound.**

---

## 13. Failure modes & the safeguards that cover them

| Failure | What protects against it |
|---|---|
| A data feed dies or rate-limits | Per-source isolation + timeout; dark signals logged; congress serves stale-on-error |
| Model proposes an absurd price | Live-quote hallucination guard rejects the order |
| Account bleeds out | Circuit breaker halts new buys at daily-loss / drawdown thresholds |
| A position craters | Hard stop-loss watcher auto-sells without approval |
| Coin-flip / low-conviction entry | Minimum-conviction floor drops it |
| Buying a knife-catch at the 50MA | Support-test flag + agent "that's a NO_ACTION" rule |
| Re-buying a name that just stopped out | Post-stop moratorium cooldown + logged thesis |
| Whipsaw churn on a volatile name | MA-cross hysteresis + anti-churn hold guard |
| Late intraday entry → overnight gap | Intraday entry cutoff; winners profit-lock at EOD |
| Order placed with no size | No-size guard rejects it before the broker |
| False "placed" notif on a failed auto-trade | The card is edited in place to the real outcome (✅/❌) |
| Overtrading | Daily new-buy cap + "most cycles NO_ACTION" bias |
| PDT violation | `isDayTrade` circuit blocks the round-trip |
| Stale offers linger | Proposals expire and the Telegram card auto-deletes |

---

## 14. Where it's headed

Near-term: **multitenancy** — one shared data server runs the sweep + ideas/thesis LLM and writes to a
database; many RedLine instances read from it and add per-user state. Market/OSINT keys are global; only
SnapTrade user credentials and Telegram chat IDs are per-tenant.

Other extensions: per-source predictive scoring, a paper/backtest harness, a data-health line in the
agent context, a **news-first catalyst detector** (catch a guidance/earnings surprise *before* the big
move), and a **confidence-decay exit** (trim a held position once the agent's own confidence collapses).

---

## 15. Worked example — how a new name is discovered (ORCL +12%)

A name you don't hold enters the system **only through the movers screener** — then travels to the agent:

1. **Front door — movers.** `apis/sources/movers.mjs` (Yahoo gainers) ranks ORCL at +12% →
   `synthesized.movers.gainers`.
2. **Scored.** `harvestAndScore()` scores the gainer **by magnitude** — ≥10% → 3 (a +3% wiggle is 1 and
   gets filtered as noise; this is how a catalyst mover clears the board but RIG-style churn doesn't).
3. **Monitored.** ORCL joins the enrichment set as a top candidate and a big mover (≥6%).
4. **Enriched — the "why".** `POSITION_NEWS` pulls *"Oracle surges on FY2029 $30B free-cash-flow
   guidance"* (the catalyst); `POSITION_TECHNICALS` shows it above both MAs, strong RS.
5. **Board.** `annotateBoard()` → score 3 + setup + news ≈ 4 ≥ `DISCOVERY_MIN_SCORE` → on `MARKET_SETUPS`.
6. **Agent sees it.** `buildAnalystContext` leads the NEW_BUY hunt from the board; ORCL is in front of the
   agent with its catalyst + chart, to judge re-rating vs. chase.
7. **If it buys** → gates (§9) → execute → stance HOLD + horizon → hard stop → trade report.

**The boundary:** this is **price-move triggered** — ORCL's news is pulled *because* the move was big
enough to rank in movers. A news-first "guidance/earnings-surprise" signal is the next upgrade to catch
catalysts *before* the big move.

---

## 16. File map (where to look)

| Area | File |
|---|---|
| Sweep orchestrator | `apis/briefing.mjs` |
| Data sources | `apis/sources/*.mjs` (congress = Bargo, movers = Yahoo) |
| Synthesis | `dashboard/inject.mjs` |
| Ideas / theses / digest | `lib/llm/ideas.mjs`, `lib/llm/thesis.mjs` |
| **The agent** | `lib/llm/analyst.mjs` |
| **Discovery board** | `lib/discovery/discover.mjs` |
| Per-position MA-cross | `lib/technicals/maCrossStore.mjs` |
| Stance book + tags/horizon | `lib/stances/store.mjs` |
| Track record / calibration | `lib/llm/trackRecord.mjs`, `lib/llm/calibration.mjs` |
| Risk | `lib/risk/circuitBreaker.mjs`, `lib/risk/moratorium.mjs`, `lib/alerts/stopLossWatcher.mjs` |
| Proposals / execution | `lib/proposals/store.mjs`, `server.mjs` (`acceptProposal`) |
| Brokerage | `lib/alerts/snaptrade.mjs` |
| Plan proposals / Ask | `lib/llm/planProposal.mjs`, `lib/llm/newsAsk.mjs`, `lib/directives/store.mjs` |
| Strategy modes | `lib/llm/modes.mjs` |
| Alerts / commands | `lib/alerts/telegram.mjs` |
| Dashboard | `dashboard/public/redline.html` |
| Settings | `lib/settings/store.mjs` |
| Server / sweep loop | `server.mjs` |
| Keys & sources catalog | `SOURCES.md` |

---

*RedLine is the trading brain of Crucix: wide-angle research, one disciplined suggestion at a time, a
human on the trigger, and a hard floor under the whole thing that no amount of model confidence can move.*
