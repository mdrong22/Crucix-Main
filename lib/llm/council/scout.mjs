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
    constructor(config, getLiveQuote, fallbackProvider) {
        super("Beta", config);
        this.model            = config.model;
        this.fallbackModel    = config.fallbackModel  || null;  // Gemini fallback model (flash-lite)
        this.fallbackApiKey   = config.fallbackApiKey || null;  // separate quota pool — if set, fallback uses this key
        this.fallbackDelayMs  = config.fallbackDelayMs ?? 2000; // delay before same-API retry after 429
        this.fallbackProvider = fallbackProvider;               // cross-API fallback (Groq)
        this.apiKey           = config.apiKey;
        this.baseUrl          = config.baseUrl;
        this.getLiveQuote     = getLiveQuote; // async (ticker) => { price, bid, ask, volume, rsi? }
    }

    // ── Internal: attempt a single model call ────────────────────────────────
    async _tryModel(model, systemPrompt, userMessage, opts = {}, apiKeyOverride = null) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKeyOverride || this.apiKey,
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

    // ── Rate-limit detection for Gemini responses ────────────────────────────
    _isGeminiRateLimit(msg = '') {
        return msg.includes('429') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('rate limit');
    }

    // ── Public: primary → flash-lite fallback (w/ delay + optional separate key) → Groq ──
    async complete(systemPrompt, userMessage, opts = {}) {
        let primaryErr;
        try {
            return await this._tryModel(this.model, systemPrompt, userMessage, opts);
        } catch (err) {
            primaryErr = err;
            const isRateLimit = this._isGeminiRateLimit(err.message);

            if (this.fallbackModel) {
                // If primary rate-limited AND we're using the same key, wait before retrying.
                // Covers transient RPM resets (~1 min window). Skip delay if fallback has its own key.
                if (isRateLimit && !this.fallbackApiKey) {
                    console.warn(`[Scout] ⚠ Primary (${this.model}) rate-limited — waiting ${this.fallbackDelayMs / 1000}s before flash-lite retry (same key)...`);
                    await new Promise(r => setTimeout(r, this.fallbackDelayMs));
                } else if (isRateLimit && this.fallbackApiKey) {
                    console.warn(`[Scout] ⚠ Primary (${this.model}) rate-limited — routing to flash-lite with separate key (no delay needed).`);
                } else {
                    console.warn(`[Scout] ⚠ Primary (${this.model}) failed: ${err.message} — trying flash-lite fallback.`);
                }

                try {
                    return await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts, this.fallbackApiKey);
                } catch (fallbackErr) {
                    console.error(`[Scout] ⚠ Flash-lite fallback (${this.fallbackModel}) failed: ${fallbackErr.message}`);
                }
            }
        }

        // Cross-API fallback (Groq) — completely separate quota
        if (this.fallbackProvider?.complete) {
            console.warn(`[Scout] Routing to cross-API fallback (${this.fallbackProvider.model || 'unknown'})...`);
            try {
                return await this.fallbackProvider.complete(systemPrompt, userMessage, opts);
            } catch (finalErr) {
                console.error(`[Scout] ✗ Cross-API fallback failed: ${finalErr.message}`);
            }
        }

        throw primaryErr; // all tiers exhausted
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
          
            // RSI: prefer Alpaca-computed RSI-14 from bars (reliable), fall back to SnapTrade quote RSI
            const rsiValue = historical?.rsi ?? quote?.rsi ?? null;
            const rsiNum   = rsiValue !== null ? parseFloat(rsiValue) : null;
            const rsiNote  = rsiNum !== null
                ? `RSI(14): ${rsiNum.toFixed(1)} (${rsiNum > 70 ? 'OVERBOUGHT ⚠' : rsiNum < 30 ? 'OVERSOLD 🟢' : 'neutral'})`
                : 'RSI(14): unavailable';

            const enriched = [
                ``,
                `══════════════════════════════════════════`,
                `⚡ VERIFIED LIVE DATA — ${ticker} (API-fetched, overrides any price you stated above)`,
                `══════════════════════════════════════════`,
                `  Price:   $${quote.price}  ← USE THIS. Discard any price from training data or earlier in this prompt.`,
                `  Bid:     $${quote.bid}`,
                `  Ask:     $${quote.ask}`,
                `  Volume:  ${quote.volume}`,
                `  200-MA:  ${long?.ma200 ?? 'N/A'} | Below 200-MA: ${long?.isBelowMA200 ? 'YES (Discount Zone)' : 'NO'}`,
                `  5m close: ${historical?.latestClose ?? 'N/A'} | Momentum: ${historical?.momentum ?? 'N/A'}%`,
                `  ${rsiNote}`,
                `INSTRUCTION: Rewrite "The Data" field using ONLY the numbers above. Do NOT use any price from your training data.`,
                `══════════════════════════════════════════`,
            ].join('\n');

            console.log(`[SCOUT] 📡 Live quote enrichment for ${ticker}: $${quote.price}`);
            return enriched;
        } catch (err) {
            console.warn(`[SCOUT] ⚠️  Live quote failed for ${ticker}: ${err.message}`);
            return '';
        }
    }

    async assessInfo(context, currentData, userPort, lastDecision, buyingPower, openAccOrders, remainingTrades, orders24h, openPositionCount = 0, geopoliticalSummary = null) {
        const [userPortfolio, openAccountOrders] = [DataCleaner.stringifyPortfolio(userPort) || [], DataCleaner.stringifyOpenOrders(openAccOrders) || []]

        // ── Performance context injection (Phase 4) ──────────────────────────
        const lastReview         = loadLastReview();
        const performanceContext = buildScoutPerformanceContext(lastReview);
        // Live VIX: try FRED (daily closing value) → yfinance ^VIX quote → N/A
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);
        const vix = currentData.fred?.find(f => f.id === 'VIXCLS')?.value
            ?? currentData.yfinance?.quotes?.find?.(q => q.symbol === '^VIX')?.price
            ?? 'N/A';
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
        const ScoutSysPrompt = `You are Beta, Scout for the RedLine Council. Find the single highest-conviction trade per sweep.
Buying Power: ${buyingPower} | Session: ${marketStatus} | Day Trades Left: ${remainingTrades}/3 | Time: ${estDate} EST
${performanceContext}
[HORIZONS] INTRADAY=technical trigger, same-day, needs day trade slot | SWING=news+technicals, 2-10d overnight | LONG=structural/congressional, weeks-months GTC. Every escalation must have one.

[GEO CONTEXT] ${geopoliticalSummary || 'None yet.'}

[SECOND-ORDER THINKING] The obvious play is crowded. Trace events 2-3 steps downstream.
Event → what INPUT does it disrupt → who BENEFITS from that input shortage/spike → is that beneficiary mid-cap and under-owned?
Example: Hormuz closure → natgas spike → fertilizer costs surge (80% natgas feedstock) → MOS/NTR/CF, not oil majors.
Rules: second-order play must NOT be the headline ticker. Must be an input/infrastructure provider. Mid-cap preferred.

[STRUCTURAL DISPLACEMENT] Scan for industries losing pricing power permanently (not cyclically).
Target the REPLACEMENT company, never the dying one. Low P/E on a structural loser is a trap.
Themes: legacy telecom→fiber/satellite | branch banking→neobanks/payments | coal→SMR/grid storage | legacy defense→drone/cyber | broadcast ads→programmatic.
Qualifier: replacement must have a NAMED catalyst in today's data (contract, policy, earnings) — not just "trend is good". Always LONG horizon.

[CONGRESSIONAL] Leading indicator — members act before policy moves.
Buys: ${congressBuyTickers || 'None'} | Clustered (≥2 members): ${congressClusteredBuys || 'None'}
- Cluster + any technical → LONG, ESCALATING
- Single large buy >$250k + catalyst → consider LONG
- Congressional SELL on target → avoid
${congressStr}

[PORTFOLIO DEFENSE] Holdings: ${userPortfolio}
Open Orders: ${openAccountOrders || 'NONE'} — FORBIDDEN from recommending any ticker with ACCEPTED/WORKING order.
Defensive rotation only if holding drops >6% with no news catalyst — sub-6% is noise.

[PDT] Recent fills (24h): ${orders24h || 'None.'}
${remainingTrades === 0
  ? 'DEFENSIVE MODE: no round trips. SWING or LONG only. Use constraint to force better entries.'
  : 'AGGRESSIVE MODE: intraday permitted. Still prefer SWING/LONG if signal warrants.'}

[SCORING] Ideas list (starting point only — cold discovery encouraged if score ≥7):
${JSON.stringify((currentData.ideas || []).slice(0, 6).map(i => ({ title: i.title, ticker: i.ticker, type: i.type, horizon: i.horizon })))}

CONVICTION: Congressional Cluster +3 | News Catalyst (earnings/FDA/contract) +2 | Emerging sector infrastructure +3* | Blue Chip Discount (Top10 cap, price<200MA, RSI<35) +3
TECHNICAL: RSI Extreme +2 | Volume Anomaly >2x +1 | 5m Momentum >1.5% +1 | Sector Rotation +1
DISCOVERY: OSINT Catalyst +2 | Second-Order Play +2 | Structural Displacement +2 | Insider Buy >$50k +1 | Strong Analyst Rating +1
PENALTIES: Repeat ${lastDecision?.ticker || 'None'} no new data -2 | Already in portfolio no rotation rationale -1
*Emerging sector floor: named catalyst today + backbone/infrastructure play (not headline ticker) + non-mega-cap. All 3 required.

Rotation candidate ONLY if: down ≥3% from entry AND new opp scores ≥7 pts. Sub-3% loss = noise, never rotate.

[POSITION CAP] Open now: ${openPositionCount}
0-2 → escalate if ≥7 pts | 3-4 → escalate if ≥7 pts (rotations don't bypass) | 5+ → QUIET unless rotation OR ≥9 pts
QUIET if: score below threshold | no SWING/LONG when trades=0 | all targets have open orders

[OUTPUT]
QUIET: STATUS: QUIET | Reason: [which threshold failed, 1 sentence]

ESCALATING:
STATUS: ESCALATING
- Horizon: [INTRADAY|SWING|LONG] — [why]
- Compliance: Trades=${remainingTrades}/3 | Mode=${remainingTrades > 0 ? 'Aggressive' : 'Defensive'}
- Ticker: [symbol]
- Play Type: [FIRST-ORDER|SECOND-ORDER|STRUCTURAL-DISPLACEMENT|TECHNICAL]
- Signal Score: [X pts — factors listed]
- Congressional Signal: [Cluster/Single/None + details]
- Rotation_Target: [ticker or None]
- Trigger: [specific signal combination]
- The Data: [price, RSI, VIX: ${vix}, momentum, congressional context]
- The Story: [2-3 sentences. If SECOND-ORDER: name upstream event + full chain. If STRUCTURAL: name dying industry + replacement thesis.]
- Scout's Note: [PDT compliance + horizon justification + why this beats the first-order play]`;
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
