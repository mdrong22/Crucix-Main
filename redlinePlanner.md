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
| Signal Intelligence | 8.5/10 | 30-source OSINT stack, congressional clustering, delta memory |
| Council Architecture | 7/10 | Adversarial debate is sound; Phi upgraded to GPT-OSS-120B fixes prior asymmetry |
| Execution Safety | 7/10 | Price drift gate, PDT compliance, sells-first sort all solid |
| Risk Management | 4/10 | No mechanical stop-loss; risk lives in prompts, not code |
| Adaptive Strategy | 4/10 | No feedback loop — council has no memory of past P&L |
| Infrastructure | 7/10 | safeFetch, FMP caching, SSE dashboard, Telegram two-way commands |
| **Overall** | **6.5/10** | Signal ceiling is high; feedback loop and mechanical risk are the critical gaps |

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

## 7. What This Does Not Solve

These gaps require separate work and are noted here to avoid scope creep during the feedback loop implementation.

**Mechanical Stop-Loss** remains unaddressed. The feedback loop teaches the council what worked historically but does not protect open positions between sweeps. A mechanical stop-loss module should run on its own interval (e.g., every 2 minutes), independent of the LLM cycle, checking current prices against logged entry prices and a configurable stop threshold. This is a code problem, not a prompt problem, and should be treated as a separate workstream after the feedback loop is stable.

**Single-Target Debate** remains. The Review data will show *which signals predicted wins* but the debate still evaluates one ticker at a time. Comparative multi-ticker evaluation would require restructuring `beginDebate()` significantly and is a future enhancement.

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

---

## 9. Build Order

1. ✅ `decisionLogger.mjs` + wire into `debate.mjs` — capturing data on every verdict
2. ✅ `positionResolver.mjs` — reconciles open decisions against live SnapTrade portfolio
3. ✅ `reviewCouncil.mjs` — compute structured stats from resolved decisions, write `lastReview.json`
4. ✅ Inject `lastReview.json` into Scout and Gregor prompts
5. ✅ `stopLossWatcher.mjs` — independent mechanical exit layer, polls every 90s