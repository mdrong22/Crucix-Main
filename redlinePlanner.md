# RedLine Planner — Crucix Intelligence Engine
> Architecture review, identified weaknesses, and implementation roadmap for the RedLine council feedback loop.

---

## 1. System Characterization

Crucix RedLine is a multi-agent LLM trading system built on a genuine intelligence pipeline. Unlike most retail algo bots that react purely to price and volume, RedLine ingests **30 live data sources** before forming a single trade idea — including geopolitical conflict events (ACLED/GDELT), flight and maritime anomalies (OpenSky, AIS ships), wildfire thermal signatures (FIRMS/NASA), WHO health alerts, CISA active exploit disclosures, Bluesky/Reddit/Telegram OSINT, and congressional trading clusters via FMP. That signal layer is closer to what a macro hedge fund calls "alternative data" than anything available at the retail level.

The council architecture — Scout identifies → Phi argues bull → Theta argues bear → Gregor adjudicates → Scribe reviews — is structurally sound. Adversarial debate before execution forces the system to surface counterarguments rather than pattern-match to a buy signal. Real safety engineering is present throughout: sells sort before buys (rotation safety), live quotes re-fetched and price-drift-gated at 2% before any order hits SnapTrade, PDT compliance tracked mechanically from actual order history, and emergency JSON bracket repair so Gregor's output cannot crash the loop.

---

## 2. Scored Assessment

| Dimension | Score | Notes |
|---|---|---|
| Signal Intelligence | 9/10 | 30-source OSINT stack, congressional clustering, delta memory, INTRADAY gap/earnings/breakout signals added |
| Council Architecture | 8/10 | Adversarial debate sound; thresholds tuned; TRADE AROUND + DEFENSIVE urgency gating added |
| Execution Safety | 8/10 | Price drift gate, PDT compliance, sells-first sort, live price enrichment on DEFENSIVE path, durable asset protection |
| Risk Management | 6/10 | Mechanical stop-loss watcher live; TRADE AROUND prevents panic-selling durable assets; cost basis now visible to all agents |
| Adaptive Strategy | 7/10 | Self-calibration feedback loop live; lastReview.json injected into Scout + Gregor; performance-weighted horizon scoring |
| Infrastructure | 8/10 | safeFetch, FMP caching, SSE dashboard, Telegram two-way, Scribe reports for all execution paths, runScribeReport helper |
| **Overall** | **B+ (7.5/10)** | A-tier architecture and signal stack; gaps: single-target debate, ETF candle data, ~30s LLM latency |

---

## 3. Identified Weaknesses (Priority Order)

### 3.1 No Feedback Loop — CRITICAL
The council makes decisions with zero awareness of its own track record. It does not know whether its last 20 calls were profitable, which signal types (congressional cluster, VIX spike, news score) actually predicted positive outcomes, or which horizons (INTRADAY/SWING/LONG) had the best win rates. Scribe generates qualitative narrative but no structured data is persisted and no structured data is fed back into future sessions. The council is flying blind.

### 3.2 No Mechanical Stop-Loss — CRITICAL
If Gregor places a LONG position and it drops 15% overnight, nothing in the system acts on it. Risk management currently lives entirely in prompts — Theta can argue against a trade, but once a trade is placed, no code enforces exits. Stop-loss must be a mechanical layer that runs independently of the LLM cycle, not a suggestion inside a prompt.

### 3.3 Single-Target Debate
Phi selects one ticker and the entire debate revolves around it. There is no comparative analysis — no mechanism to evaluate whether a different ticker might be a stronger opportunity. The council debates the *merits of the selected target* rather than *which target is best*.

### 3.4 Sweep Speed vs. Intraday Reality
The 10-minute sweep cycle is too slow for INTRADAY horizon trades during fast-moving markets. A lot can happen in 10 minutes around earnings, Fed announcements, or macro shocks. INTRADAY horizon should either be deprioritized relative to SWING/LONG, or the sweep interval should be configurable per-horizon.

### 3.5 No Structured P&L Attribution
There is no system connecting a past decision (Gregor bought NVDA at $X on signal Y at horizon Z) to its outcome. Without attribution, it is impossible to determine whether the signal stack is generating alpha or whether wins are random.

---

## 3b. Resolved Weaknesses (Session Updates)

The following weaknesses from the original assessment have been addressed:

**Feedback Loop (was CRITICAL)** — Now implemented. `reviewCouncil.mjs` runs daily at 4:30 PM ET, computes win rates by horizon/signal, writes `lastReview.json`, and injects a compact performance context block into Scout and Gregor prompts. Scout uses the data to self-calibrate: horizons with WR < 45% get a scoring penalty; horizons with WR ≥ 60% get a bonus. Congressional cluster signals at 83% win rate get prioritized automatically.

**Portfolio Defense — Durable Asset Panic Selling (new, CRITICAL)** — System was exiting ETFs and commodities (SLV, GLD, ITA, SPY, etc.) at a loss via market order. These assets always recover; dumping them locks in the loss and misses the bounce. Fixed via TRADE AROUND mode (see Section 3c).

**DEFENSIVE urgency over-triggering (new)** — WATCH-level threats were launching the full bull/bear debate and sometimes exiting positions. Fixed: WATCH = Telegram alert only, no order; SWING = debate with HOLD bias; IMMEDIATE = debate with EXIT bias + Market order override.

**Live price hallucination on DEFENSIVE path (new)** — Scout's DEFENSIVE output had no candle data for ETFs, so Gregor used stale training-data prices (e.g. ITA at $223 when actual price was $214.77). Fixed: DEFENSIVE path now calls `_enrichWithLivePrice()` to patch current price into the briefing before sending to council.

**Scribe reports only on ESCALATING path (new)** — DEFENSIVE and TRADE AROUND executions were generating no Scribe narrative. Fixed: extracted `runScribeReport(trade, label)` helper called from all three execution branches.

**Cost basis invisible to council (new)** — `stringifyPortfolio` showed only current price and P&L%. Agents couldn't compute breakeven. Fixed: portfolio now includes `cost=X` and computed dollar P&L so every agent knows the breakeven without guessing.

**Scout going QUIET too often / Theta over-blocking (new)** — Pure INTRADAY technical setups could only score 4 points max under old signals. Fixed: added INTRADAY-specific signals (+3 for pre-market gap >2% on volume, +3 for earnings day momentum, +2 for confirmed breakout). CATALYST URGENCY threshold lowered from ≥7 to ≥6 when catalyst fires today/tomorrow. Theta REJECT threshold lowered from score<7 to score<6; WAIT threshold from score<8 to score<7.

**Gregor defaulting to WAIT without justification (new)** — WAIT verdicts had no cost. Fixed: OPPORTUNITY COST rule enforces that WAIT is only valid if (a) price >1.5×ATR above S1, (b) PDT=0 for INTRADAY, or (c) open order exists. All other WAITs require a NEXT_TRIGGER field; unjustified WAITs are treated as execution failures.

**DecisionLogger logging UNKNOWN for DEFENSIVE trades (new)** — Fixed: `logDecisions()` now accepts a `signalOverrides` param allowing DEFENSIVE/TRADE AROUND branches to inject `{ horizon: 'DEFENSIVE', trigger: urgency }` directly.

---

## 3c. TRADE AROUND Mode (New — Durable Asset Defense)

**Concept:** Durable assets (ETFs, commodities) cycle but always recover. The correct response to a drawdown on SLV, GLD, ITA, SPY, etc. is not a market exit — it is to place a GTC SELL at breakeven or R1, collect the bounce, then re-enter at a lower price to reduce the average cost.

**Durable Assets List (from `crucix.config.mjs`):**
Precious metals: SLV, GLD, GDX, GDXJ, IAU, SIVR, PPLT | Energy: USO, UNG, XLE, XOP, OIH | Broad market: SPY, QQQ, IWM, DIA, VOO, VTI, VEA, VWO | Sector ETFs: XLF, XLK, XLV, XLP, XLU, XLI, XLB, XLRE | Defense: ITA, XAR, PPA | Bonds: TLT, HYG, LQD, SHY, IEF, BND

**Two scenarios Scout can trigger:**
- `UNDERWATER` — position is in drawdown; goal is GTC SELL at breakeven/R1 to exit flat, then re-enter lower to reduce cost basis.
- `PROFIT_TAKE` — position is up >15%; goal is GTC SELL at current R1 to lock in gain.

**Hard enforcement in `server.mjs`:** The TRADE AROUND routing block overwrites `order_type=Limit` and `time_in_force=GTC` regardless of what Gregor outputs. No market orders on durable assets. The Telegram notification includes both the sell target and the re-entry target so the user knows the full plan.

**Output priority (Scout):** TRADE AROUND > DEFENSIVE > ESCALATING > QUIET. Scout scans the full portfolio for durable-asset UNDERWATER/PROFIT_TAKE opportunities on every sweep, not just when a threat is detected.

---

## 4. Proposed Solution — Two Council Modes

The core insight is that the council currently has only one mode: **tactical** (real-time signal → trade). It needs a second mode: **strategic** (retrospective performance → planning).

### Mode 1: RedLine Debate (Existing — Tactical)
Runs every sweep cycle. Scout identifies opportunities from live data. Phi and Theta debate a specific ticker. Gregor adjudicates and places an order. Scribe writes a qualitative report. **No change to this flow except injecting `lastReview` data into Scout and Gregor's context** (see Section 6).

### Mode 2: RedLine Review (New — Strategic)
Runs on a separate schedule — recommended: once daily, triggered at market close or the first sweep after 4:00 PM ET. Does **not** place trades. Instead it:

1. Reads the persisted decision log (`runs/decisions.json`)
2. Fetches current prices from SnapTrade for open positions
3. Computes win/loss statistics by horizon, by signal type, and by ticker
4. Writes a structured `runs/lastReview.json` with clean numeric stats
5. Optionally generates a narrative summary via Scribe for human review

The output of the Review becomes context for all future Debate sessions. The council becomes self-aware of its own performance.
A Review once created must be saved as a .docx and should be viewable in the redline.html report viewer
---

## 5. Implementation Plan

Build in strict order — each phase depends on the previous.

### Phase 1 — Decision Logger
**File:** `runs/decisions.json`  
**Trigger:** End of every `beginDebate()` call that produces a non-WAIT verdict

Every trade placed by Gregor must be persisted with full context at the moment of decision. This is the foundation. Without it, the Review has nothing to compute.

**Schema per decision entry:**
```json
{
  "id": "uuid-or-timestamp",
  "timestamp": "2026-04-09T14:32:00Z",
  "ticker": "NVDA",
  "action": "BUY",
  "horizon": "SWING",
  "orderType": "Limit",
  "timeInForce": "GTC",
  "entryPrice": 112.40,
  "units": 10,
  "notionalValue": 1124.00,
  "signals": {
    "congressionalCluster": true,
    "congressionalTickers": ["NVDA"],
    "signalScore": 8,
    "vix": 21.3,
    "newsScore": 2
  },
  "scoutHorizon": "SWING",
  "outcome": null,
  "exitPrice": null,
  "exitTimestamp": null,
  "pnlPct": null,
  "pnlDollar": null,
  "resolved": false
}
```

The `outcome`, `exitPrice`, and `pnlPct` fields start as `null` and are filled in by the Review council when the position is closed or when evaluation time is reached (e.g., for INTRADAY: end of day; for SWING: 10 days; for LONG: 30 days).

**Where to write it:** `lib/llm/council/utils/decisionLogger.mjs`  
**When to call it:** In `debate.mjs` → `beginDebate()`, after `finalTrades` array is built, before returning.

---

### Phase 2 — Position Resolver
**File:** `lib/llm/council/utils/positionResolver.mjs`

Before the Review council can compute P&L, it needs to reconcile logged decisions against actual SnapTrade position data. This module:

1. Reads `runs/decisions.json`
2. Fetches current portfolio from `FetchUserTrades()`
3. For each unresolved decision, checks if the position still exists:
   - If the position is **closed** (no longer in portfolio), marks `resolved: true`, records exit price and P&L
   - If the position is **still open**, records current unrealized P&L without marking resolved
   - If the decision horizon time has elapsed (INTRADAY: same day, SWING: 10d, LONG: 30d), flags for forced evaluation
4. Writes resolved entries back to `runs/decisions.json`

---

### Phase 3 — Review Council
**File:** `lib/llm/council/reviewCouncil.mjs`

This is the strategic session. It runs after the resolver has updated `decisions.json`.

**Computed statistics:**
```json
{
  "generatedAt": "2026-04-09T16:05:00Z",
  "totalDecisions": 47,
  "resolved": 31,
  "open": 16,
  "winRate": 0.58,
  "avgWinPct": 4.2,
  "avgLossPct": -2.8,
  "profitFactor": 1.51,
  "byHorizon": {
    "INTRADAY": { "decisions": 12, "winRate": 0.42, "avgPnlPct": 0.8 },
    "SWING":    { "decisions": 15, "winRate": 0.67, "avgPnlPct": 3.9 },
    "LONG":     { "decisions": 4,  "winRate": 0.75, "avgPnlPct": 8.1 }
  },
  "bySignal": {
    "congressionalCluster": { "decisions": 6, "winRate": 0.83 },
    "highVix":              { "decisions": 9, "winRate": 0.44 },
    "newsScore>=2":         { "decisions": 14, "winRate": 0.57 }
  },
  "topWinners": ["NVDA", "PLTR", "AAPL"],
  "topLosers": ["INTC", "SNAP"],
  "councilRating": {
    "scoutAccuracy": 0.62,
    "horizonAlignmentRate": 0.74,
    "gregorsWaitRate": 0.31
  },
  "narrativeSummary": "SWING calls on congressional cluster signals continue to outperform. INTRADAY win rate is below 50% — PDT burns are occurring on low-conviction setups. Recommend Scout increase minimum signal score threshold for INTRADAY from 6 to 8."
}
```

The Review council also invokes Scribe with this structured data to generate a full narrative performance report for the human (Matt), separate from the structured JSON.

---

### Phase 4 — Inject lastReview into Debate Sessions
**Files:** `lib/llm/council/scout.mjs`, `lib/llm/council/omega.mjs`

Once `runs/lastReview.json` exists, it gets loaded at the start of each Debate session and injected into two places:

**Scout** receives a compact performance summary before signal scoring:
```
=== COUNCIL PERFORMANCE CONTEXT ===
Overall win rate: 58% (31 resolved decisions)
INTRADAY win rate: 42% — CAUTION: below threshold
SWING win rate: 67% — PREFERRED horizon
LONG win rate: 75% (small sample) — HIGH CONVICTION only
Congressional cluster signal: 83% win rate — PRIORITIZE
High-VIX trades: 44% win rate — ELEVATED RISK
Last review: 2026-04-09 16:05 EST
Recommendation: Raise INTRADAY signal score minimum to 8. Favor SWING/LONG.
```

This directly influences Scout's signal scoring and horizon classification — the system begins to self-calibrate.

**Gregor** receives a sizing confidence modifier:
```
PERFORMANCE CONTEXT: Win rate 58%, profit factor 1.51.
Congressional cluster positions: 83% win rate — apply +20% sizing on clustered signals.
INTRADAY below 50% win rate — reduce sizing to minimum tier until rate recovers.
```

---

## 6. Data Flow Diagram

```
[Sweep Cycle — Every 10 min]
    ↓
[Debate Mode]
    Scout → Phi (Bull) → Theta (Bear) → Gregor (Verdict)
    ↓                                        ↓
[lastReview.json injected               [Decision logged to
 into Scout + Gregor context]            runs/decisions.json]
    ↓
[Scribe → qualitative report]

[Review Mode — Once Daily, ~4:30 PM ET]
    ↓
[positionResolver.mjs]
    ↓ (reconciles decisions.json vs SnapTrade portfolio)
[reviewCouncil.mjs]
    ↓ (computes stats by horizon, signal, ticker)
[runs/lastReview.json] ← used by next Debate cycle
    ↓
[Scribe → human-readable performance report → Telegram/Discord]
```

---

## 6b. Signal Scoring Reference (Current)

**Base signals:**
- Congressional cluster (same ticker, 2+ members): +4
- VIX elevated (>20): +1 | VIX high (>28): +2 | VIX extreme (>35): +3
- OSINT news score ≥ 2: +1 | ≥ 4: +2
- Defense contract match: +2
- Supply chain stress (GSCPI >1.5): +1
- Commodity / energy event: +1
- Geopolitical escalation (ACLED/GDELT): +1

**INTRADAY-specific signals (new):**
- Pre-market gap >2% on volume above average: +3 ("institutional accumulation")
- Earnings day momentum (beat + guidance raise): +3
- Technical breakout confirmed on volume: +2
- Catalyst fires today or tomorrow (CATALYST URGENCY): escalate at score ≥6 (not 7)

**Position cap modifier:** 0–2 open positions → escalate at ≥6 pts; 3–4 open → ≥7; 5+ open → ≥8

**Performance modifier (from lastReview.json):** Horizon WR ≥ 60% → threshold –1; Horizon WR < 45% → threshold +1. Applied before final escalation check.

**Theta verdict thresholds (current):**
- REJECT hard-blocks only at score < 6 (down from 7)
- WAIT hard-blocks only at score < 7 (down from 8)
- PROCEED WITH CAUTION is the expected outcome on a well-set-up trade when stop is defined and R/R ≥ 1.5:1

---

## 7. What This Does Not Solve

These gaps require separate work and are noted here to avoid scope creep during the feedback loop implementation.

**Mechanical Stop-Loss** remains unaddressed. The feedback loop teaches the council what worked historically but does not protect open positions between sweeps. A mechanical stop-loss module should run on its own interval (e.g., every 2 minutes), independent of the LLM cycle, checking current prices against logged entry prices and a configurable stop threshold. This is a code problem, not a prompt problem, and should be treated as a separate workstream after the feedback loop is stable.

**Single-Target Debate** remains. The Review data will show *which signals predicted wins* but the debate still evaluates one ticker at a time. Comparative multi-ticker evaluation would require restructuring `beginDebate()` significantly and is a future enhancement.

---

## 7b. Known Limitations (Current)

**ETF candle data gap:** Yahoo Finance candle endpoints don't reliably return OHLCV data for ETFs in the same format as equities. Scout's live price enrichment on the DEFENSIVE path patches the current quote price but has no RSI, ATR, or S1/R1 levels for ETFs. Gregor must rely on Scout's computed levels from the briefing context. Workaround: Scout outputs a TRADE AROUND rather than DEFENSIVE for durable ETFs, which avoids needing candle-derived levels.

**LLM latency (~30s per sweep):** The council runs 4 LLM calls sequentially (Scout → Phi → Theta → Gregor). With Groq as the primary provider, each call is ~5–8s. Total sweep-to-order latency is ~25–35s. On fast-moving INTRADAY setups (earnings, gap days), significant price drift can occur between Scout's signal and Gregor's order. Mitigation: 2% price drift gate at order time; Market order override for IMMEDIATE urgency.

**Training data price anchoring:** LLMs trained on historical data may "remember" old price levels for well-known tickers (e.g. a model trained in late 2024 may anchor AAPL at $180). Live price enrichment patches Scout's briefing with current quote, but if enrichment fails or the ticker has no candle data, agents may hallucinate stale prices. Mitigation: portfolio `avg_cost` and live price always visible in agent prompts; explicit instruction to agents to use only numbers from the briefing.

**Single-target debate:** Council debates one ticker per sweep. No comparative multi-ticker scoring. A stronger opportunity may exist in the portfolio or universe that isn't evaluated. Planned future enhancement: Scout ranks top 3 signals, Phi/Theta debate all three with comparative R/R before Gregor picks one.

**PDT compliance is mechanical, not strategic:** The system tracks remaining day trades but does not factor them into INTRADAY vs SWING horizon selection. At PDT=1, the system will still generate INTRADAY signals; Gregor must manually respect the limit. Future: PDT=1 should automatically shift INTRADAY signals to SWING horizon in Scout.

---

## 8. File Checklist

| File | Status | Notes |
|---|---|---|
| `runs/decisions.json` | ✅ Complete | Auto-created on first debate verdict |
| `lib/llm/council/utils/decisionLogger.mjs` | ✅ Complete | Logs verdict + signal context, dedup helpers |
| `lib/llm/council/utils/positionResolver.mjs` | ✅ Complete | Reconciles decisions vs SnapTrade portfolio |
| `lib/llm/council/utils/generateReviewReport.mjs` | ✅ Complete | Dedup logic, writes HTML + DOCX to /reports |
| `scripts/generateReviewDocx.py` | ✅ Complete | python-docx formatted Word document generator |
| `dashboard/public/redline.html` — Report Viewer | ✅ Complete | Filter bar, delete button, modal w/ nav + download |
| `server.mjs` | ✅ Complete | Review Mode scheduler (4:30 PM ET), calls runReviewCouncil, download/delete APIs |
| `lib/alerts/debate.mjs` | ✅ Complete | logDecisions() wired after finalTrades built |
| `lib/llm/council/reviewCouncil.mjs` | ✅ Complete | Computes stats, writes lastReview.json, triggers report generation |
| `runs/lastReview.json` | ✅ Complete | Auto-generated by reviewCouncil.mjs on each daily review |
| `lib/llm/council/scout.mjs` | ✅ Complete | SECTION P injected — performance context + horizon calibration |
| `lib/llm/council/omega.mjs` | ✅ Complete | Sizing modifier block injected into Gregor's user-turn message |
| `lib/alerts/stopLossWatcher.mjs` | ✅ Complete | Mechanical stop-loss, trailing stop, INTRADAY EOD — no LLM |
| `crucix.config.mjs` — durableAssets | ✅ Complete | 35+ ETFs/commodities that trigger TRADE AROUND instead of DEFENSIVE |
| `lib/llm/council/scout.mjs` — TRADE AROUND output | ✅ Complete | UNDERWATER/PROFIT_TAKE scan; durable-asset DEFENSIVE → TRADE AROUND routing |
| `lib/llm/council/scout.mjs` — DEFENSIVE live price | ✅ Complete | `_enrichWithLivePrice()` called on DEFENSIVE path; prevents price hallucination |
| `lib/llm/council/scout.mjs` — DEFENSIVE urgency | ✅ Complete | WATCH/SWING/IMMEDIATE urgency levels defined and enforced in server.mjs |
| `lib/llm/council/scout.mjs` — INTRADAY scoring | ✅ Complete | Gap +3, earnings day +3, breakout +2, CATALYST URGENCY at ≥6 |
| `lib/llm/council/scout.mjs` — buildScoutPerformanceContext | ✅ Complete | Compressed to single compact line; strips decorative borders |
| `lib/llm/council/omega.mjs` — OPPORTUNITY COST | ✅ Complete | WAIT only valid for 3 specific conditions; all others require NEXT_TRIGGER |
| `lib/llm/council/phi.mjs` — SHORT-TERM ALPHA | ✅ Complete | Gap/earnings/breakout/catalyst-window citation templates added |
| `lib/llm/council/theta.mjs` — VERDICT DEFAULTS | ✅ Complete | PROCEED WITH CAUTION as default; REJECT/WAIT require justification |
| `lib/alerts/debate.mjs` — Theta thresholds | ✅ Complete | REJECT at score<6 (was 7); WAIT at score<7 (was 8) |
| `lib/llm/council/utils/decisionLogger.mjs` — signalOverrides | ✅ Complete | Allows DEFENSIVE/TRADE AROUND to inject horizon and trigger directly |
| `lib/llm/council/utils/cleaner.mjs` — stringifyPortfolio | ✅ Complete | Now includes avg_cost and computed dollar P&L for all agents |
| `server.mjs` — runScribeReport helper | ✅ Complete | Extracted; called from ESCALATING, DEFENSIVE, and TRADE AROUND branches |
| `server.mjs` — TRADE AROUND routing block | ✅ Complete | Hard-enforces Limit/GTC; sends Telegram with sell + re-entry targets |
| `server.mjs` — DEFENSIVE urgency gating | ✅ Complete | WATCH=alert only; SWING=debate; IMMEDIATE=Market order override |

---

## 9. Build Order

1. ✅ `decisionLogger.mjs` + wire into `debate.mjs` — capturing data on every verdict
2. ✅ `positionResolver.mjs` — reconciles open decisions against live SnapTrade portfolio
3. ✅ `reviewCouncil.mjs` — compute structured stats from resolved decisions, write `lastReview.json`
4. ✅ Inject `lastReview.json` into Scout and Gregor prompts
5. ✅ `stopLossWatcher.mjs` — independent mechanical exit layer, polls every 90s
6. ✅ TRADE AROUND mode — GTC SELL at breakeven/R1 for durable ETFs/commodities; re-entry target in Telegram
7. ✅ DEFENSIVE urgency gating — WATCH/SWING/IMMEDIATE routing; live price enrichment on DEFENSIVE path
8. ✅ Signal scoring upgrades — INTRADAY gap/earnings/breakout signals; CATALYST URGENCY; Theta threshold tuning
9. ✅ OPPORTUNITY COST rule — Gregor WAIT requires NEXT_TRIGGER unless one of 3 specific conditions is met
10. ✅ Cost basis visibility — `stringifyPortfolio` now includes avg_cost + dollar P&L for all agents
11. ✅ Scribe for all paths — `runScribeReport` helper called from ESCALATING, DEFENSIVE, and TRADE AROUND branches
12. ✅ signalOverrides in `logDecisions` — DEFENSIVE/TRADE AROUND inject correct horizon into decision log

**Planned (not yet built):**
- Multi-ticker comparative debate — Scout ranks top 3, council evaluates all before Gregor selects
- PDT-aware horizon shifting — PDT=1 auto-shifts INTRADAY signals to SWING in Scout
- ETF candle data source — fill the S1/R1/ATR gap for durable ETFs on DEFENSIVE path
- Mechanical position sizing with portfolio heat map — cap total risk exposure independent of Gregor prompt