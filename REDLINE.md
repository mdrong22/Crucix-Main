# Project RedLine — System Guide

> The autonomous-research, human-approved trading layer of Crucix. This document explains what
> RedLine is, the ideas behind it, how it works end to end, and an honest accounting of where it's
> strong and where it isn't. Read it top to bottom to learn the system; use the file map at the end
> as a reference.

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
- **Breadth most retail systems don't have.** It fuses ~39 live sources — macro/economic,
  live prices, congressional trades, SEC filings, policy/executive actions, semiconductor lead
  indicators, and geopolitical OSINT — into the analyst's view.
- **It learns.** Every resolved trade feeds a track record and a confidence-calibration score back
  into the agent's next decision, so it adjusts toward what has actually worked for it.

The guiding value, borrowed and adapted from risk-first trading desks: **"survives" beats "looks
profitable."** Discipline (stop-losses, a circuit breaker, position sizing, approval gating) is never
waived; aggression is a dial on top of it.

---

## 2. Design principles

1. **Human-in-the-loop by default.** Approval gating is the safety model. Auto mode is opt-in.
2. **Deterministic risk, independent of the model.** The stop-loss watcher and the account circuit
   breaker are plain code with hard thresholds. The LLM cannot argue its way past them.
3. **Quality over quantity.** Most cycles are `NO_ACTION`. A daily new-buy cap discourages overtrading.
4. **Every call is explainable.** Each proposal carries `reasoning`, a `bearCase`, cited `sources`,
   and a `confidence` score. Trade and plan reports are generated for the record.
5. **Memory and learning.** A per-stock "stance book" gives cross-cycle consistency; a track record +
   calibration close the feedback loop.
6. **Token-frugal.** The sweep is distilled to a compact (~700–900 token) digest; the default agent
   runs on a Claude subscription via the CLI rather than per-token API billing.

---

## 3. The decision pipeline (end to end)

```
Sources  →  Synthesize  →  Agent context  →  Claude decides  →  Accept → Execute  →  Feedback ↻
(~39 feeds)  (clean+delta   (+ portfolio,     (think → bear      (guards →          (resolve P&L →
             +ideas/theses)  stances, record,  case → ONE call)   place order)       recalibrate)
                             guardrails)              │
                                                      └──→ NO_ACTION (nothing trades)
```

The feedback arrow is the point: resolved outcomes re-enter the agent's context, so the loop
tightens over time. The **stance book** also updates "sideways" every cycle — even on a NO_ACTION
sweep the agent can revise its per-stock plan, so its memory changes far more often than it trades.

---

## 4. Architecture, layer by layer

### 4.1 Data layer — the sweep
- **Entry:** `apis/briefing.mjs → fullBriefing()` runs ~39 sources in parallel, each with a 30s
  timeout, via `runSource()`. Failures are isolated — one dead feed never stalls the sweep.
- **Sources** span tiers: core OSINT/geopolitical (GDELT, OpenSky, FIRMS, ACLED…), economic/financial
  (FRED, Treasury, BLS, EIA, GSCPI), live market data (Yahoo Finance quotes + movers screener),
  congressional trades + insiders (**Bargo**), policy/executive actions (Federal Register), SEC EDGAR
  (8-K/Form 4), semiconductor lead indicators (TrendForce), and news (Finnhub, NewsAPI). Many are
  keyless; see `SOURCES.md` for the full catalog and which need keys.
- **Synthesis:** `dashboard/inject.mjs → synthesize()` maps the raw source payloads into clean,
  predictable fields (`fred`, `energy`, `markets`, `movers`, `congress`, `policy`, `sec`, …) and
  fetches an RSS news feed. This is the boundary where "40 different API shapes" becomes one schema.
- **Delta + memory:** `lib/delta` compares this sweep to the last and flags what escalated or is new.
  This gates expensive work — if nothing material changed, the LLM ideas/theses passes are skipped
  and cached results reused.

### 4.2 Intelligence layer — shared market read
- **Ideas** (`lib/llm/ideas.mjs`) — a market-wide brief of leverageable setups, throttled and
  delta-gated to conserve LLM quota.
- **Theses** (`lib/llm/thesis.mjs`) — forward-pacing megatrend → "unpriced rung" maps (e.g. a trend's
  bottleneck → the second-order stock that benefits). Cached to `runs/theses.json`, reused across
  restarts.
- **The digest:** `compactSweepForLLM()` distills everything the agent needs into a compact text block
  (it even drops raw OSINT detection counts the trade agent doesn't need). This is the single biggest
  token lever.

### 4.3 The agent — one analyst, one call
- **Core:** `lib/llm/analyst.mjs → generateProposal()`. One `provider.complete()` call to Claude
  (default via the `claude` CLI on a subscription; **Gemini** as fallback). No tool-calling loop — the
  context is pre-assembled and the model returns one JSON object.
- **The system prompt** encodes the method:
  - **THINK FIRST** — write `reasoning` and the single strongest `bearCase` before deciding. If the
    bear case wins → `NO_ACTION`.
  - **PRIORITY** (stop at first that applies): (1) urgent **maintenance** on a held position
    (thesis broken, stop breached, take profit) → usually SELL; (2) the best single **new buy**,
    discovered top-down (megatrend → catalyst → sector → under-owned stock, confirmed by technicals);
    (3) **NO_ACTION**.
  - **Risk rules** — R/R floors (≥1.5:1 swing, ≥2:1 long), PDT handling, size-to-buying-power, and
    "small size is fine" so thin capital still gets deployed on strong setups.
  - **Horizons** double as risk bands: `INTRADAY` (~-2% stop), `SWING` (~-5%), `LONG` (~-12%), each
    with trailing behavior. A mandatory `stopLoss` price is required on every new buy.
- **Output:** one JSON proposal — `action, ticker, side, order_type, price, units, stopLoss,
  confidence (0-100), expiresInMinutes, sources[], reasoning, bearCase, stanceUpdates[]`.
- **Strategy modes** (`STRATEGY_MODIFIERS`) tune the bar for *acting*, never the risk floors:
  `CONSERVATIVE / BALANCED / AGGRESSIVE / SCALPER`. **AUTO** resolves a mode from live conditions
  (`resolveAutoStrategy`): high VIX → CONSERVATIVE, calm + risk-on → AGGRESSIVE, heavy dislocation →
  SCALPER, else BALANCED.

### 4.4 Memory & learning
- **Stance book** (`lib/stances/store.mjs`) — the agent's living per-stock plan: a `stance`
  (WATCH / ACCUMULATE / HOLD / TRIM / EXIT / AVOID), a one-line `thesis`, an entry `plan`, an `exit`
  ("sell when…"), and a `confidence`. It persists across sweeps and is revised via `stanceUpdates` —
  this is what gives the agent consistency ("I'm waiting for SLV under $30") instead of reacting from
  scratch each cycle.
- **Track record** (`lib/llm/trackRecord.mjs`) — distills resolved trades (`runs/decisions.json`) via
  `computeStats` into win rate, profit factor, by-horizon and by-signal performance, plus behavioral
  self-corrections ("your avg win is smaller than your avg loss — you're cutting winners short").
  Injected into the agent's context so it leans into what pays off.
- **Confidence calibration** (`lib/llm/calibration.mjs`) — buckets resolved trades by the confidence
  the agent *claimed* and compares it to the win rate it *realized*, plus a **Brier score**
  (0 = perfect, 0.25 = coin-flip). It tells the agent when it's systematically over- or under-confident
  and in which band ("your 85%+ calls only win 55% — reserve 85+ for confirmed setups").
- **Standing directives** (`lib/directives/store.mjs`) — general user instructions the agent must
  follow, added via "Propose a Plan" when it accepts a reasonable directive.

### 4.5 Risk layer — deterministic, model-independent
- **Hard stop-loss watcher** (`lib/alerts/stopLossWatcher.mjs`) — runs on its own fast timer,
  **bypasses Accept/Deny**, and auto-sells to protect capital using each proposal's stop price (or the
  per-horizon floor). Also trails to lock gains and converts an underwater INTRADAY position to SWING
  at the close. This is the one place the system acts without you.
- **Account circuit breaker** (`lib/risk/circuitBreaker.mjs`) — if the account is down more than
  `maxDailyLossPct` on the ET day or more than `maxDrawdownPct` from its tracked peak, it **halts new
  buys** (maintenance/exits still allowed). It does *not* auto-flatten — it pauses new risk. A loss
  limit the model cannot talk its way past.
- **Mechanical guards on Accept** — before any order: a live-quote sanity check (rejects orders whose
  price is implausibly far from market — a hallucination guard), the PDT day-trade circuit, and a
  fractional→`Day` time-in-force fix.

### 4.6 Execution & proposal lifecycle
- **Store** (`lib/proposals/store.mjs`) — each proposal is persisted with a status:
  `PENDING → ACCEPTED | DENIED | EXPIRED | EXECUTED | FAILED`. Expiry **deletes** the Telegram card so
  stale offers disappear.
- **Accept path** (`server.mjs → acceptProposal`) — guards → `snapTrade.PlaceOrder` → `logDecisions`
  (stamps the stated confidence) → `generateTradeReport`. In **Auto** mode a proposal self-accepts
  instantly and *only then* fires the execution alert to the news channel; manual accepts don't spam
  that channel.
- **Brokerage** (`lib/alerts/snaptrade.mjs`) — SnapTrade connects to the user's broker. Reads are
  cached and serially throttled to respect rate limits; execution always re-checks a live quote.

### 4.7 Delivery & control
- **Dashboard** (`dashboard/public/redline.html`) — the RedLine terminal: portfolio header + value
  chart, positions, orders, the **stance book** panel, the **decision cycle** panel (with a live
  calibration Brier readout), a Fortune-500 live ticker, a reports viewer, and a **settings** gear
  (Auto Trade, investment horizons, strategy mode, min buying power, circuit-breaker thresholds, UI
  toggles).
- **Telegram** (`lib/alerts/telegram.mjs`) — proposal cards with Accept/Deny buttons go to a dedicated
  proposals channel; alerts/status go to the news channel. Per-channel slash commands: `/info`,
  `/plan`, `/propose`, `/portfolio` (trades channel) and `/status`, `/sweep`, `/brief` (alerts).
- **Propose a Plan** — the user can push an idea or directive; the agent evaluates it
  (`evaluatePlanProposal`) and returns ACCEPT / PARTIAL / DENY with reasoning, applying accepted stance
  edits or directives on the next sweep. Reckless ideas are denied.

### 4.8 State (the `runs/` directory)
Flat JSON stores, each a single source of truth: `settings.json`, `stances.json`, `decisions.json`
(the trade ledger + resolved P&L), `proposals.json`, `directives.json`, `breaker.json`, `theses.json`,
`latest.json` (last raw sweep), plus `reviewState.json`.

---

## 5. How it learns (the loop that matters)

1. A proposal is accepted → `logDecisions` records it **with the stated confidence**.
2. `positionResolver` later marks it resolved (win/loss/breakeven + P&L).
3. On the next sweep, `buildTrackRecord()` and `buildCalibration()` read the resolved ledger and inject
   compact self-corrections into the agent's context.
4. The agent adjusts: downweights losing horizons/signals, leans into winners, and recalibrates its
   confidence numbers.

This is the single biggest lever on decision quality — it turns a reactive proposer into something
that improves with its own history. It only activates after a minimum sample (`TRACK_RECORD_MIN`,
`CALIBRATION_MIN`) so it doesn't over-fit two trades.

---

## 6. Strengths

- **Safety-first by construction.** Approval gating + a deterministic risk layer the model can't
  override is a genuinely different safety posture than autonomous rule bots.
- **Analyst-grade breadth.** Macro + policy + congressional + SEC + semiconductor + OSINT in one view
  is far wider than price/indicator bots, and the top-down "megatrend → unpriced rung" funnel is a
  real edge when the data is live.
- **It explains itself.** Reasoning, an explicit bear case, cited sources, and a confidence number on
  every call — plus generated reports — make decisions auditable instead of opaque.
- **It calibrates.** Track record + Brier-scored confidence is rare in retail systems and directly
  attacks the two classic failure modes (overconfidence, cutting winners short).
- **Consistency via memory.** The stance book keeps a coherent plan per stock across cycles rather
  than re-deciding from zero.
- **Cost-efficient.** Token-frugal digest; default agent runs on a Claude subscription, not per-token
  billing. Most data sources are free-tier or keyless.
- **Tunable aggression without tunable risk.** Strategy modes (incl. regime-aware AUTO) move the bar
  for acting while the stop-loss/R-R/circuit-breaker floors stay fixed.

---

## 7. Weaknesses & limitations

- **Signal fragility on free tiers.** Keyed sources silently go dark when a free quota is exhausted
  (this bit the congressional feed on FMP — now on Bargo, with rate-limit detection + stale-fallback).
  Data quality varies sweep to sweep, and the agent isn't yet told *which* signals are dark.
- **Latency vs. autonomous bots.** Approvals happen at sweep interval, and every exit except the hard
  stop is a *proposal* — so for fast intraday moves the human-in-the-loop design is slower by nature.
  That's a deliberate trade of speed for control.
- **Cold-start learning.** Track record and calibration need a meaningful number of resolved trades
  before they help; early decisions run with little self-knowledge. Learning is **live-only** — there's
  no backtest/paper-sim harness, so the feedback loop costs real (if small) trades to train.
- **LLM variance.** A model can still produce a weak proposal; the guards catch *mechanically* unsafe
  orders (bad price, PDT, sizing) but not a plausible-looking bad *idea* — a user can still accept one.
- **Attribution is per-confidence, not yet per-source.** Calibration tells you *how well-calibrated*
  the agent is, but the system doesn't yet measure which of the ~39 sources actually predict outcomes,
  so OSINT breadth can add noise as well as signal.
- **Single-tenant, flat-file state.** `runs/*.json` isn't concurrency-safe or namespaced per user;
  true multitenancy (shared data server + per-user state) is designed but not built (see `SOURCES.md`).
- **Operational dependencies.** The default agent needs the `claude` CLI logged in on the host and
  carries ~27k tokens of CLI overhead per call; SnapTrade and Telegram must be configured; a few data
  points are cached/stale (e.g. the digest's VIX is FRED prior-close, not the live tick).
- **Stock/market-hours bound.** Unlike 24/7 crypto bots, it operates in market windows; its risk and
  cadence assumptions are built around that.

---

## 8. Failure modes & the safeguards that cover them

| Failure | What protects against it |
|---|---|
| A data feed dies or rate-limits | Per-source isolation + timeout; dark signals are logged; congress serves stale-on-error |
| Model proposes an absurd price | Live-quote hallucination guard rejects the order |
| Account bleeds out | Circuit breaker halts new buys at daily-loss / drawdown thresholds |
| A position craters | Hard stop-loss watcher auto-sells without approval |
| Overtrading | Daily new-buy cap + "most cycles NO_ACTION" prompt bias |
| Overconfident sizing | Confidence calibration feeds the bias back for self-correction |
| PDT violation | `isDayTrade` circuit blocks the round-trip |
| Stale offers linger | Proposals expire and the Telegram card auto-deletes |

---

## 9. Where it's headed

The near-term architectural goal is **multitenancy**: one shared **data server** runs the ~39-source
sweep + the ideas/thesis LLM and writes the synthesized intelligence to a database; many **RedLine
instances** read from it and add per-user portfolio/stances/execution on top. The key split is already
documented (`data-server.env.example` vs `redline.env.example`): market/OSINT keys are global and set
up once; only SnapTrade user credentials and Telegram chat IDs are per-tenant. The real work there is
making the per-tenant state (stances, decisions, breaker, proposals) isolated and concurrency-safe,
not the keys.

Other natural extensions: per-source predictive scoring (so breadth is pruned to what pays), a
paper/backtest harness so learning isn't live-only, and a data-health line in the agent context so it
knows when a signal is dark.

---

## 10. Discovery & per-position intelligence

Two capabilities sit on top of the base pipeline: **finding new names**, and **watching the ones you
already hold** with company-level depth. Both run inside the sweep and feed the agent digest.

**Per-name intelligence** — each sweep, every name you **hold**, have a **stance** on, or that ranks as a
**discovery candidate** gets pulled individually (not just as a macro headline):

| Digest line | What it is | Source |
|---|---|---|
| `POSITION_NEWS` | company-specific headlines (court rulings, guidance, downgrades…) | Finnhub `/company-news` |
| `INSIDER_SELLS` | execs/directors reducing a holding (bearish) | Finnhub insider txns |
| `INSTITUTIONAL_SELLS` | 13F funds cutting stakes (quarterly, cached) | Finnhub institutional-ownership |
| `POSITION_TECHNICALS` | price vs 50/200-day MA, RSI, RS vs SPY, trend | Alpaca bars |
| `MA_CROSS` | a FRESH cross this sweep (price ±MA, death/golden), hysteresis-debounced | `lib/technicals/maCrossStore.mjs` |

**Discovery board (`MARKET_SETUPS`)** — `lib/discovery/discover.mjs` harvests every ticker the sweep's
signals already name (congress/insider buys, upgrades, option sweeps, 8-Ks, movers scaled by magnitude,
thesis targets, prior ideas), scores each by catalyst strength, enriches the top ones with the news +
chart above, and ranks a shortlist. A **min-conviction floor** (`DISCOVERY_MIN_SCORE`) drops single-signal
noise; **counter-trend** (<200-MA) and **insider/13F-selling** names are down-weighted. The agent's
NEW_BUY step hunts here first.

**Post-stop moratorium** (`lib/risk/moratorium.mjs`) — a hard-stop puts the ticker on a re-entry cooldown
and logs the failed thesis, so the system doesn't immediately re-buy a name that just stopped it out, and
the failure informs later decisions (`/cooldowns`, `/lift`).

**Position lifecycle controls**
- **Investment-type retype** — the agent (or you, via `/propose`) can promote a held position
  INTRADAY→SWING→LONG when a winner has more room; the live stop floor + EOD behavior change to match.
- **Intraday EOD lifecycle** — a late-session INTRADAY entry is blocked (`INTRADAY_ENTRY_CUTOFF`, no
  same-day runway); at the close an INTRADAY **winner** is profit-locked and a **loser** holds overnight.
- **Anti-whipsaw** — MA-cross hysteresis + an anti-churn hold guard (a just-entered loser isn't soft-exited
  on a reversed signal; winners still scalp fast; the hard stop always covers the downside).
- **Direct stance control** — set any tag now (`/stance <TICKER> <HOLD|WATCH|EXIT|…>` or the dashboard ✎),
  independent of the agent.
- **Every exit writes a report** — agent sells, hard stops, trailing/EOD profit-locks — each with the
  realized result (entry → exit, up/down, WIN/LOSS verdict).

---

## 11. Worked example — how a new name is discovered (ORCL +12%)

A name you don't hold enters the system **only through the movers screener** — then travels to the agent:

1. **Front door — movers.** `apis/sources/movers.mjs` (Yahoo gainers screener) ranks ORCL at +12% →
   `synthesized.movers.gainers`. (Digest: `MARKET_GAINERS: ORCL +12%`.)
2. **Scored.** `harvestAndScore()` scores the gainer **by magnitude** — ≥10% → **3** (a small wiggle would
   be 1 and get filtered as noise; this is how a real catalyst mover clears the board but RIG-style churn
   doesn't).
3. **Monitored.** ORCL joins the enrichment set both as a top candidate and as a **big mover (≥6%)**.
4. **Enriched — the "why".** `POSITION_NEWS` pulls *"Oracle surges on FY2029 $30B free-cash-flow
   guidance"* (the catalyst); `POSITION_TECHNICALS` shows it above both MAs, strong RS.
5. **Board.** `annotateBoard()` → score 3 + setup + news ≈ **4** ≥ `DISCOVERY_MIN_SCORE` → it lands on
   `MARKET_SETUPS` with its headline attached.
6. **Agent sees it.** `buildAnalystContext` leads the NEW_BUY hunt from `MARKET_SETUPS`; ORCL is right in
   front of the agent, with the guidance catalyst and chart, to judge **re-rating vs. chase**.
7. **If it buys** → the normal gates (regular-hours · intraday cutoff · moratorium · size) → execute →
   stance `HOLD` + horizon → hard stop → trade report.

**The boundary:** this is **price-move triggered** — ORCL's news is pulled *because* the move was big
enough to rank in movers. If it had re-rated on the same news with only a +3% candle (and you didn't hold
it), it would still be filtered. A news-first "guidance/earnings-surprise" signal is the next upgrade to
catch catalysts *before* the big move.

---

## 12. File map (where to look)

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

*RedLine is the trading brain of Crucix: wide-angle research, one disciplined suggestion at a time,
a human on the trigger, and a hard floor under the whole thing that no amount of model confidence can
move.*
