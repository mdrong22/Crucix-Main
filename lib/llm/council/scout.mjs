/** DEBUG LINE: IF STATUS: QUIET => 1 sentence explaining why standing down

 * scout.mjs — Beta, Market Scout & Trend Synthesizer
 *
 * FIXES:
 *  1. Fetches live price + RSI for the candidate ticker before escalating
 *     (was escalating on news alone with no price validation → Boeing bias)
 *  2. Fixed template literal typo: ${currentData.ideas}} → ${currentData.ideas}
 *  3. Live price injected into Scout's briefing so downstream council has real numbers
 *  4. getLiveQuote injected as dependency (same instance used in debate.mjs)
 */

import { getHistoricalTechnicals, getLongTermTechnicals } from "../../../apis/sources/alpaca.mjs";
import { CouncilAgent } from "./councilAgent.mjs";
import { DataCleaner } from "./utils/cleaner.mjs";
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const _scoutDir = dirname(fileURLToPath(import.meta.url));
const _lastReviewPath = join(_scoutDir, '../../../runs/lastReview.json');

function loadLastReview() {
  if (!existsSync(_lastReviewPath)) return null;
  try { return JSON.parse(readFileSync(_lastReviewPath, 'utf8')); }
  catch { return null; }
}

function buildScoutPerformanceContext(review) {
  if (!review) return '';
  const pct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'N/A';
  const bh  = review.byHorizon || {};
  const bs  = review.bySignal  || {};

  const horizonLines = Object.entries(bh).map(([h, s]) => {
    const flag = s.winRate >= 0.60 ? '✅ PREFERRED' : s.winRate < 0.45 ? '⚠ CAUTION' : '〜 NEUTRAL';
    return `  ${h.padEnd(10)} → Win Rate: ${pct(s.winRate).padEnd(6)} | Avg P&L: ${s.avgPnlPct.toFixed(1)}%  ${flag}`;
  }).join('\n');

  const clusterWr = bs.congressionalCluster?.winRate;
  const highVixWr = bs.highVix?.winRate;
  const scoreNote = clusterWr != null
    ? `Congressional Cluster win rate: ${pct(clusterWr)} — ${clusterWr >= 0.65 ? 'PRIORITIZE as LONG trigger' : clusterWr < 0.50 ? 'verify signal freshness' : 'proceed with normal weighting'}.`
    : '';
  const vixNote = highVixWr != null && (bs.highVix?.decisions || 0) >= 3
    ? `High-VIX trades: ${pct(highVixWr)} — ${highVixWr < 0.45 ? 'REDUCE size on VIX ≥ 25 setups' : 'acceptable risk profile'}.`
    : '';

  const recLine = review.recommendations?.[0] ? `▸ Priority: ${review.recommendations[0]}` : '';

  return `
═══════════════════════════════════════════════════
SECTION P — COUNCIL PERFORMANCE CONTEXT (from last review: ${review.generatedAt?.slice(0, 10) || 'unknown'})
═══════════════════════════════════════════════════
Overall: Win Rate ${pct(review.winRate)} | Profit Factor ${review.profitFactor === 999 ? '∞' : review.profitFactor?.toFixed(2)} | ${review.resolved} resolved decisions

BY HORIZON:
${horizonLines || '  No horizon data yet.'}

SIGNAL INTELLIGENCE:
  ${scoreNote}
  ${vixNote}

SELF-CALIBRATION DIRECTIVES:
${recLine}
  Apply these performance findings when scoring signals and selecting horizons.
  Favor horizons with win rate ≥ 60%. Deprioritize horizons with win rate < 45%.
═══════════════════════════════════════════════════`;
}

export class ScoutLLM extends CouncilAgent {
    constructor(config, getLiveQuote) {
        super("Beta", config);
        this.model         = config.model;
        this.fallbackModel = config.fallbackModel || null;
        this.apiKey        = config.apiKey;
        this.baseUrl       = config.baseUrl;
        this.getLiveQuote  = getLiveQuote; // async (ticker) => { price, bid, ask, volume, rsi? }
    }

    // ── Internal: attempt a single model call ────────────────────────────────
    async _tryModel(model, systemPrompt, userMessage, opts = {}) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey,
            },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userMessage }] }],
                generationConfig: {
                    maxOutputTokens: opts.maxTokens || 4096,
                },
            }),
            signal: AbortSignal.timeout(opts.timeout || 60000),
        });

        if (!res.ok) {
            const err = await res.text().catch(() => '');
            throw new Error(`Gemini API ${res.status}: ${err.substring(0, 200)}`);
        }

        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        return {
            text,
            usage: {
                inputTokens:  data.usageMetadata?.promptTokenCount      || 0,
                outputTokens: data.usageMetadata?.candidatesTokenCount  || 0,
            },
            model,
        };
    }

    // ── Public: try primary → fallback on any error ──────────────────────────
    async complete(systemPrompt, userMessage, opts = {}) {
        try {
            return await this._tryModel(this.model, systemPrompt, userMessage, opts);
        } catch (err) {
            if (this.fallbackModel) {
                console.warn(`[Scout] ⚠ Primary model (${this.model}) failed: ${err.message} — retrying with fallback: ${this.fallbackModel}`);
                return await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts);
            }
            throw err; // no fallback configured — propagate
        }
    }

    /**
     * Pulls live price data for a ticker extracted from the LLM's draft output.
     * Returns a formatted string to append to the Scout's briefing, or empty string on failure.
     */
    async _enrichWithLivePrice(draftText) {
        if (!this.getLiveQuote) return '';

        // Try to extract a ticker from the draft output
        const tickerMatch = draftText.match(/\*\*Ticker:\*\*\s*([A-Z]{1,5})/);
        if (!tickerMatch) return '';

        const ticker = tickerMatch[1];
        try {
            const [quote, historical, long] = await Promise.all([this.getLiveQuote(ticker), getHistoricalTechnicals(ticker), getLongTermTechnicals(ticker)]);
          
            const rsiNote = quote.rsi
                ? `RSI: ${quote.rsi.toFixed(1)} (${quote.rsi > 70 ? 'overbought' : quote.rsi < 30 ? 'oversold' : 'neutral'})`
                : 'RSI: unavailable';

            const enriched = [
                ``,
                `⚡ LIVE PRICE DATA (fetched now — use these in The Data field):`,
                `  Ticker:  ${ticker}`,
                `  Price:   $${quote.price}`,
                `  Bid:     $${quote.bid}`,
                `  Ask:     $${quote.ask}`,
                `  Volume:  ${quote.volume}`,
                `  200 Day Moving Average: ${long.ma200}`,
                `  Below 200-MA?: ${long?.isBelowMA200 ? 'YES (Discount Zone)' : 'NO'}`,
                `  recent price (5min):   bars: ${historical?.bars || null}, latest close: ${historical?.latestClose || null}, momentum: ${historical?.momentum || null}`,
                `  ${rsiNote}`,
            ].join('\n');

            console.log(`[SCOUT] 📡 Live quote enrichment for ${ticker}: $${quote.price}`);
            return enriched;
        } catch (err) {
            console.warn(`[SCOUT] ⚠️  Live quote failed for ${ticker}: ${err.message}`);
            return '';
        }
    }

    async assessInfo(context, currentData, userPort, lastDecision, buyingPower, openAccOrders, remainingTrades, orders24h) {
        const [userPortfolio, openAccountOrders] = [DataCleaner.stringifyPortfolio(userPort) || [], DataCleaner.stringifyOpenOrders(openAccOrders) || []]

        // ── Performance context injection (Phase 4) ──────────────────────────
        const lastReview         = loadLastReview();
        const performanceContext = buildScoutPerformanceContext(lastReview);
        // Live VIX from FRED data
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);
        const vix = currentData.fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
        const hours = estDate.getHours();
        const minutes = estDate.getMinutes();
        const currentTimeValue = hours * 100 + minutes;
        // Regular Hours: 0930 to 1600 (9:30 AM - 4:00 PM EST)
        const isRegularHours = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus = isRegularHours ? "REGULAR_MARKET_OPEN" : "EXTENDED_HOURS_RESTRICTED";

        // Congressional trading intel — cleaned and stringified via DataCleaner
        const congressRaw      = currentData.congress || currentData.Congress || null;
        const congressCleaned  = DataCleaner.cleanCongress(congressRaw);
        const congressStr      = DataCleaner.stringifyCongress(congressCleaned);
        const congressBuyTickers     = congressCleaned.topBuys.map(b => b.ticker).join(', ') || 'None';
        const congressClusteredBuys  = congressCleaned.topBuys.filter(b => b.clustered).map(b => b.ticker).join(', ') || 'None';

        console.log(`[REDLINE] Last escalation → Ticker: ${lastDecision?.ticker || 'None'} | Trigger: ${lastDecision?.trigger || 'None'} | Date: ${lastDecision?.date || 'None'}`)
        const ScoutSysPrompt = `Role: "Beta", Market Scout & Trend Synthesizer.
Objective: Identify the single highest-conviction opportunity per briefing. You are the intelligence filter for the Council.
You must classify EVERY escalation with a TRADE HORIZON — the Council now plans across timeframes, not just intraday.
Constraints: No additional capital. Buying Power: ${buyingPower}. Session: ${marketStatus}.
Compliance: Remaining Day Trades: ${remainingTrades}/3.
Time: ${estDate} (EST). Market rules strictly follow EST.
${performanceContext}
═══════════════════════════════════════════════════
SECTION 0 — HORIZON CLASSIFICATION (Mandatory)
═══════════════════════════════════════════════════
Every escalation MUST carry one of these horizons. Choose based on signal type:

  INTRADAY  → Technical trigger (RSI extreme, gap, momentum spike). Must close same day.
               ONLY valid when Remaining Day Trades >= 1.
  SWING     → News catalyst + technicals. Hold 2-10 days. Bypasses PDT (overnight hold).
               Preferred when Remaining Trades = 0 or signal needs time to develop.
  LONG      → Structural thesis: policy shift, Congressional cluster, fundamental re-rating.
               Hold weeks to months. GTC order. PDT irrelevant. Highest conviction required.
               CONGRESSIONAL CLUSTER buys are the primary trigger for LONG horizon.

═══════════════════════════════════════════════════
SECTION 1 — CONGRESSIONAL INTELLIGENCE (Check First)
═══════════════════════════════════════════════════
Congressional trading data is a leading indicator — members often act before policy moves.
Use this as a CONVICTION MULTIPLIER on other signals, or as a standalone LONG trigger.

  Recent Congressional Buys: ${congressBuyTickers || 'None'}
  CLUSTERED Buys (≥2 members, highest conviction): ${congressClusteredBuys || 'None'}

  RULES:
  - If a ticker has a CONGRESSIONAL CLUSTER + any confirming technical → set HORIZON: LONG, STATUS: ESCALATING.
  - If a ticker has a single large buy (>$250k) + catalyst → upgrade SWING to LONG consideration.
  - If a ticker appears in Congressional SELLS → flag as a distribution signal, avoid as a BUY target.

  Full Congressional Summary:
  ${congressStr}

═══════════════════════════════════════════════════
SECTION 2 — PORTFOLIO & ORDER DEFENSE
═══════════════════════════════════════════════════
  - Scan ${userPortfolio}. If any holding drops >3% on no news, set STATUS: ESCALATING with HORIZON: SWING (defensive rotation).
  - CHECK OPEN ORDERS: ${openAccountOrders ? openAccountOrders : 'NONE'}.
  - CRITICAL: FORBIDDEN from recommending a ticker with an existing "ACCEPTED" or "WORKING" order.
  - If an order for a Target is already open, pivot or set STATUS: QUIET.

═══════════════════════════════════════════════════
SECTION 3 — PDT COMPLIANCE
═══════════════════════════════════════════════════
  - Verified Recent Fills (24h): ${orders24h ? orders24h : 'No executed trades.'}
  - IF ${remainingTrades} === 0:
      - DEFENSIVE MODE. FORBIDDEN from creating a Round Trip (same-day buy+sell).
      - Locked tickers (bought today): cannot suggest as Rotation_Target.
      - MUST select SWING or LONG horizon only (overnight+ hold).
      - This is actually an opportunity — use PDT constraint to force better entries.
  - IF ${remainingTrades} > 0:
      - AGGRESSIVE MODE. Intraday trades permitted. Still prefer SWING/LONG if signal warrants.

═══════════════════════════════════════════════════
SECTION 4 — ACTIVE HUNTING & SIGNAL SCORING
═══════════════════════════════════════════════════
  - Cross-reference Ideas: ${currentData.ideas}.
  - SIGNAL SCORING (pick highest composite score):
      * Congressional Cluster Buy = +3 pts (LONG bias)
      * News Catalyst (earnings, FDA, contract) = +2 pts
      * Emerging sectors or tech innovations = +3 pts
          SPECIFICITY FLOOR (all 3 required to claim these points):
            1. A named sector catalyst must exist in today's data — specific legislation passed/proposed, earnings beat from a sector leader, or a named breakthrough announcement (not "AI is growing")
            2. The target must be a backbone/infrastructure/supplier play — NOT the headline name itself (e.g., power grid for AI data centers, optical networking, rare earth suppliers for EV — not NVDA when AI is trending)
            3. The stock must NOT already be a mega-cap (Top 10 market cap) — those are covered by Blue Chip Discount instead
      * Blue Chip Discount (Specifically for the giants when they are bleeding (Value focus). Top 10 Market Cap & Price < 200-day MA & RSI < 35) = +3 pts 
      * RSI Extreme (For mid-caps or momentum runners (Intraday focus) <30 oversold / >70 overbought breakout) = +2 pts
      * 5m Momentum >1.5% = +1 pt
      * Sector rotation signal = +1 pt
      * High-Conviction Analyst Rating (5-star / Strong Buy / >30% Fair Value Gap) = +1 pt
      * Repeated last decision (${lastDecision?.ticker || 'None'}) with no new data = -2 pts
  - Select the ticker with HIGHEST composite score.
  - Anti-Bias: Do not repeat ${lastDecision?.ticker || 'None'} unless price moved >1% or new catalyst exists.

═══════════════════════════════════════════════════
SECTION 5 — EXECUTION VIABILITY
═══════════════════════════════════════════════════
  - IF REGULAR_MARKET_OPEN: Fractional allowed (any horizon).
  - IF EXTENDED_HOURS: Whole shares ONLY. LONG/SWING orders preferred (GTC Limit).
  - ROTATION RULE: If Buying Power is low, scan ${userPortfolio} for "Weakest Link".
    If new lead outscores the weakest link, set ESCALATING + define Rotation_Target.
  - Compliance Check: Rotation_Target was NOT bought today if ${remainingTrades} === 0.

═══════════════════════════════════════════════════
SECTION 6 — QUIET MODE TRIGGERS
═══════════════════════════════════════════════════
  Stand down if: No target scores ≥ 3 pts OR Remaining Trades = 0 and no safe SWING/LONG setup OR all targets have OPEN_ORDERS.

═══════════════════════════════════════════════════
OUTPUT FORMAT (STRICT — no deviations)
═══════════════════════════════════════════════════
IF STATUS: QUIET → RETURN ONLY: STATUS: QUIET | Reason: [1 sentence]

IF STATUS: ESCALATING:
STATUS: ESCALATING
- **Horizon:** [INTRADAY | SWING | LONG] — [1-sentence reason for this horizon choice]
- **Compliance Status**: [Trades Remaining: ${remainingTrades}/3 | Mode: ${remainingTrades > 0 ? 'Aggressive' : 'Defensive (Overnight/Long Only)'}]
- **Ticker:** [Focus Symbol to BUY]
- **Signal Score:** [X/10 — list the scoring factors that applied]
- **Congressional Signal:** [Cluster/Single/None — member names and amounts if applicable]
- **Rotation_Target:** [Ticker to SELL, or "None"]
- **Trigger:** [Specific: e.g., "Congressional Cluster Buy + RSI 28 Bounce"]
- **The Data:** [Price, RSI, VIX: ${vix}, 5m Momentum, Congressional buy context if any]
- **The Story:** [2-3 sentences — macro + congressional narrative + why NOW]
- **Scout's Note:** [PDT compliance acknowledgment. Horizon justification. Why this beats alternatives.]`;
        try {
            // Step 1: Get Scout's draft analysis (ticker selection based on news/ideas)
            const draftRes = await this.complete(ScoutSysPrompt, context, { maxTokens: 4096 });
            const draftText = draftRes.text;

            // Step 2: If escalating, enrich with live price data for the chosen ticker
            let finalText = draftText;
            if (draftText.toUpperCase().includes('ESCALATING')) {
                const liveData = await this._enrichWithLivePrice(draftText);
                if (liveData) {
                    // Re-run with live price appended so Scout can update The Data field
                    const enrichedContext = context + liveData;
                    const enrichedRes = await this.complete(ScoutSysPrompt, enrichedContext, { maxTokens: 4096 });
                    finalText = enrichedRes.text;
                    console.log(`[SCOUT] ✅ Re-ran with live price data.`);
                }
            }
            return finalText;

        } catch (err) {
            console.error("[RedLine] Beta Failed to Assess Market Data:", err.message);
        }
    }
}
