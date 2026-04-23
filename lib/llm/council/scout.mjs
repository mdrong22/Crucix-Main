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
import { getSectorCacheMap } from "./utils/sectorCache.mjs";
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
    const flag = s.winRate >= 0.60 ? 'PREFER' : s.winRate < 0.45 ? 'CAUTION' : 'OK';
    return `  ${h}: WR=${pct(s.winRate)} P&L=${s.avgPnlPct.toFixed(1)}% [${flag}]`;
  }).join(' | ');

  const clusterWr = bs.congressionalCluster?.winRate;
  const highVixWr = bs.highVix?.winRate;
  const scoreNote = clusterWr != null
    ? `Cluster WR=${pct(clusterWr)}(${clusterWr >= 0.65 ? 'PRIORITIZE' : clusterWr < 0.50 ? 'verify freshness' : 'normal weight'})`
    : '';
  const vixNote = highVixWr != null && (bs.highVix?.decisions || 0) >= 3
    ? ` HighVIX WR=${pct(highVixWr)}(${highVixWr < 0.45 ? 'reduce size VIX≥25' : 'OK'})`
    : '';
  const recLine = review.recommendations?.[0] ? ` ▸${review.recommendations[0]}` : '';

  return `\n[PERF ${review.generatedAt?.slice(0, 10) || '?'}] WR=${pct(review.winRate)} PF=${review.profitFactor === 999 ? '∞' : review.profitFactor?.toFixed(2)} n=${review.resolved} | ${horizonLines || 'no data'} | ${scoreNote}${vixNote}${recLine} — favor WR≥60% horizons, avoid WR<45%.`;
}

// ── Portfolio composition analysis ──────────────────────────────────────────
// Maps tickers to sector buckets for concentration scoring.
const SECTOR_GROUPS = {
    defense:         ['BA', 'LMT', 'RTX', 'NOC', 'GD', 'HII', 'CACI', 'SAIC', 'LDOS', 'KTOS', 'AXON', 'PLTR', 'ITA', 'XAR', 'PPA'],
    preciousMetals:  ['GLD', 'SLV', 'IAU', 'SIVR', 'PPLT', 'GDX', 'GDXJ'],
    energyMidstream: ['KMI', 'WMB', 'ET', 'EPD', 'MPLX', 'OKE'],
    oilGas:          ['XOM', 'CVX', 'COP', 'SLB', 'HAL', 'USO', 'XLE', 'XOP', 'OIH'],
    broadMarket:     ['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VEA', 'VWO'],
    fixedIncome:     ['TLT', 'HYG', 'LQD', 'SHY', 'IEF', 'BND'],
    tech:            ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'GOOG', 'META', 'AMZN', 'XLK'],
    healthcare:      ['UNH', 'JNJ', 'LLY', 'ABBV', 'PFE', 'MRK', 'XLV'],
    financials:      ['JPM', 'BAC', 'GS', 'MS', 'WFC', 'C', 'XLF'],
};

// Pairs where holding A and adding B (or vice versa) is redundant overlap.
const REDUNDANT_PAIRS = [
    ['GLD', 'SLV'],  // both precious-metal safe havens
    ['GLD', 'IAU'],  // duplicate gold ETFs
    ['GLD', 'GDX'],  // gold spot + gold miners
    ['SLV', 'SIVR'], // duplicate silver ETFs
    ['KMI', 'WMB'],  // both midstream nat-gas pipeline operators
    ['KMI', 'ET'],
    ['WMB', 'ET'],
    ['BA',  'ITA'],  // BA is ~30% of ITA
    ['BA',  'LMT'],  // direct defense peers
    ['SPY', 'VOO'],  // duplicate S&P500
    ['SPY', 'VTI'],  // S&P500 vs total market (90%+ overlap)
    ['QQQ', 'XLK'],  // Nasdaq-100 vs tech sector ETF
];

// ETFs that should NOT be new SWING or INTRADAY entries (use LONG or TRADE AROUND).
const ETF_NEW_ENTRY_PENALTY_SET = new Set([
    'GLD','SLV','IAU','SIVR','PPLT','GDX','GDXJ',
    'SPY','QQQ','IWM','DIA','VOO','VTI','VEA','VWO',
    'XLF','XLK','XLV','XLP','XLU','XLI','XLB','XLRE',
    'ITA','XAR','PPA',
    'TLT','HYG','LQD','SHY','IEF','BND',
    'XLE','XOP','OIH','USO','UNG',
]);

/**
 * Analyses the cleaned portfolio array and returns a plain-text block injected
 * into Scout's prompt between [PORTFOLIO DEFENSE] and [SCORING].
 *
 * The key idea: sector concentration bias is PERFORMANCE-DRIVEN, not count-driven.
 *   • Sectors where held positions are winning  → positive scoring bonus for adding more
 *   • Sectors where held positions are flat/losing → penalty for piling on
 *
 * @param {Array<{symbol,units,price,avg_cost,pnl_pct,value}>} cleanedPortfolio
 *        Already-cleaned DataCleaner output (pnl_pct is a string like "4.23%")
 * @param {Record<string,string>} sectorCacheMap
 *        Live cache from sectorCache.mjs — Scout-learned ticker→sector mappings.
 *        Used as fallback for any ticker not found in the SECTOR_GROUPS seed.
 */
function buildPortfolioComposition(cleanedPortfolio, sectorCacheMap = {}) {
    if (!Array.isArray(cleanedPortfolio) || cleanedPortfolio.length === 0) return '';

    // Build ticker → P&L map
    const tickerPnl = {};
    for (const pos of cleanedPortfolio) {
        const sym = pos.symbol;
        if (!sym || sym === 'UNKNOWN') continue;
        tickerPnl[sym] = parseFloat(pos.pnl_pct) || 0; // pnl_pct already has "%" stripped by parseFloat
    }
    const heldTickers = new Set(Object.keys(tickerPnl));
    if (heldTickers.size === 0) return '';

    // ── Map held tickers into sector buckets ────────────────────────────────
    // Priority: SECTOR_GROUPS seed → Scout-learned cache → unclassified
    const sectorMap  = {}; // sectorName → [{ ticker, pnl }]
    const unclassed  = []; // tickers Scout hasn't classified yet
    for (const ticker of heldTickers) {
        let matched = false;
        // 1. Try hardcoded seed list
        for (const [sector, members] of Object.entries(SECTOR_GROUPS)) {
            if (members.includes(ticker)) {
                (sectorMap[sector] = sectorMap[sector] || []).push({ ticker, pnl: tickerPnl[ticker] });
                matched = true;
                break;
            }
        }
        // 2. Try Scout-learned cache (handles emergent / unlisted tickers)
        if (!matched) {
            const cached = sectorCacheMap[ticker];
            if (cached) {
                (sectorMap[cached] = sectorMap[cached] || []).push({ ticker, pnl: tickerPnl[ticker] });
                matched = true;
            }
        }
        // 3. Unclassified — will be labelled so Scout knows to classify it next time it appears
        if (!matched) unclassed.push(ticker);
    }

    // ── Compute bias per sector ──────────────────────────────────────────────
    // Bias is a signed integer added to/subtracted from a candidate's score
    // when that candidate belongs to the same sector.
    //
    //  avg P&L  ≥ +8%  → +3  STRONG BULLISH   (sector has real momentum — lean in)
    //  avg P&L  ≥ +4%  → +2  BULLISH
    //  avg P&L  ≥ +1%  → +1  MILD BULLISH
    //  avg P&L   0–1%  →  0  FLAT
    //  avg P&L ≥ -5%   → -1  WEAK
    //  avg P&L  < -5%  → -2  BEARISH          (sector under structural pressure — avoid doubling)
    //
    // FULL (≥2 positions) & BULLISH: cap allows +1 more at ≥8 pts threshold
    // FULL & FLAT/BEARISH:  hard cap — extra -2 pts on top of bias
    function sectorBiasScore(avgPnl) {
        if (avgPnl >= 8)  return  3;
        if (avgPnl >= 4)  return  2;
        if (avgPnl >= 1)  return  1;
        if (avgPnl >= 0)  return  0;
        if (avgPnl >= -5) return -1;
        return -2;
    }

    const sectorBias = {};
    for (const [sector, positions] of Object.entries(sectorMap)) {
        const avgPnl = positions.reduce((s, p) => s + p.pnl, 0) / positions.length;
        const bias   = sectorBiasScore(avgPnl);
        const count  = positions.length;
        const isFull = count >= 2;

        const signStr = bias > 0 ? `+${bias}` : `${bias}`;
        let label;
        if (bias >= 3)       label = 'STRONG BULLISH — lean in, sector has momentum';
        else if (bias === 2) label = 'BULLISH — adding correlated pick has tailwind';
        else if (bias === 1) label = 'MILD BULLISH — slight edge for sector-aligned picks';
        else if (bias === 0) label = 'FLAT — no momentum edge either way';
        else if (bias === -1)label = 'WEAK — sector under pressure, size carefully';
        else                 label = 'BEARISH — avoid doubling down here';

        sectorBias[sector] = { avgPnl, bias, signStr, label, positions, count, isFull };
    }

    // ── Redundant pairs already held ────────────────────────────────────────
    const redundantHeld = REDUNDANT_PAIRS
        .filter(([a, b]) => heldTickers.has(a) && heldTickers.has(b))
        .map(([a, b]) => `${a}+${b}`);

    // ── Build sector display lines ───────────────────────────────────────────
    function sectorDisplayName(s) {
        const spaced = s.replace(/([A-Z])/g, ' $1').trim();
        return spaced[0].toUpperCase() + spaced.slice(1);
    }

    const sectorLines = Object.entries(sectorBias).map(([s, d]) => {
        const name = sectorDisplayName(s);
        const fullTag = d.isFull ? ' [FULL]' : '';
        const posStr = d.positions
            .map(p => `${p.ticker}(${p.pnl >= 0 ? '+' : ''}${p.pnl.toFixed(1)}%)`)
            .join(', ');
        return `  ${name}${fullTag} [bias ${d.signStr}]: ${posStr} — ${d.label}`;
    });

    // ── Generate actionable scoring rules ────────────────────────────────────
    const rules = [];

    for (const [sector, d] of Object.entries(sectorBias)) {
        const name = sectorDisplayName(sector);
        if (d.bias >= 2 && d.isFull) {
            rules.push(`${name} BULLISH+FULL: 1 more correlated pick allowed at ≥8 pts — apply ${d.signStr} sector momentum bonus`);
        } else if (d.bias >= 1) {
            rules.push(`${name} momentum: correlated new pick → ${d.signStr} pts sector-momentum bonus`);
        } else if (d.bias <= -1 && d.isFull) {
            rules.push(`${name} BEARISH+FULL: do NOT add another position — hard cap, apply ${d.bias - 2} pts`);
        } else if (d.bias <= -1) {
            rules.push(`${name} under pressure: adding second position → ${d.signStr} pts sector-headwind penalty`);
        } else if (d.bias === 0 && d.isFull) {
            rules.push(`${name} FLAT+FULL: avoid adding more until momentum confirmed — apply -2 pts`);
        }
    }

    if (redundantHeld.length > 0) {
        rules.push(`Redundant pairs already held (${redundantHeld.join(', ')}): adding MORE to the same theme → -3 pts`);
    }
    rules.push(`ETF as new SWING/INTRADAY entry → -2 pts regardless of sector bias (ETFs = LONG or TRADE AROUND only)`);

    const unclassedNote = unclassed.length > 0
        ? `⚠ Unclassified held tickers (no sector data yet): ${unclassed.join(', ')} — if you escalate one of these, include a Sector: field so the system learns it.`
        : '';

    return [
        `[PORTFOLIO COMPOSITION & SECTOR BIAS]`,
        `Sector P&L and momentum bias (applied additively to SCORING below):`,
        ...sectorLines,
        unclassedNote,
        redundantHeld.length > 0 ? `⚠ Redundant pairs already held: ${redundantHeld.join(', ')} — avoid adding MORE to these themes.` : '',
        ``,
        `SECTOR BIAS RULES:`,
        ...rules.map(r => `  • ${r}`),
    ].filter(l => l !== '').join('\n');
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
        // Durable assets — ETFs/commodities that cycle but always recover.
        // Positions in these facing temporary headwinds → TRADE AROUND, not hard exit.
        this.durableAssets    = new Set(config.durableAssets || []);
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
     * Returns { enriched: string, quote: object, ticker: string } or null on failure.
     * Callers must mechanically patch the LLM output with quote.price — do NOT rely
     * on the LLM to update the price itself (training-data anchoring is too strong).
     */
    async _enrichWithLivePrice(draftText) {
        if (!this.getLiveQuote) return null;

        // Match both draft format (**Ticker:** X) and final output format (- Ticker: X)
        const tickerMatch = draftText.match(/\*\*Ticker:\*\*\s*([A-Z]{1,5})/)
                         || draftText.match(/[-\s]*Ticker:\s*([A-Z]{1,5})/i);
        if (!tickerMatch) return null;

        const ticker = tickerMatch[1];
        try {
            const [quote, historical, long] = await Promise.all([
                this.getLiveQuote(ticker),
                getHistoricalTechnicals(ticker),
                getLongTermTechnicals(ticker),
            ]);

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
            return { enriched, quote, ticker };
        } catch (err) {
            console.warn(`[SCOUT] ⚠️  Live quote failed for ${ticker}: ${err.message}`);
            return null;
        }
    }

    /**
     * Mechanically patches price citations in Scout's output so training-data anchoring
     * can't survive into the final briefing. LLM instructions alone are not reliable enough.
     *
     * Targets: "Price: $548.12" → "Price: $650.00 [LIVE]"
     * Also injects a hard price-override line at the top of The Data field.
     */
    _patchLivePrice(text, ticker, livePrice) {
        if (!text || !livePrice) return text;

        // 1. Replace "Price: $xxx" pattern wherever it appears (The Data field, narrative, etc.)
        let patched = text.replace(
            /\bPrice:\s*\$[\d,]+(?:\.\d{1,2})?/gi,
            `Price: $${livePrice} [LIVE]`
        );

        // 2. Replace inline "at $xxx" only when immediately adjacent to the ticker name
        //    e.g. "NOC at $548" → "NOC at $650 [LIVE]"
        const tickerEsc = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        patched = patched.replace(
            new RegExp(`(${tickerEsc}\\s+(?:is\\s+)?(?:currently\\s+)?(?:trading\\s+)?(?:priced?\\s+)?at\\s+)\\$[\\d,]+(?:\\.\\d{1,2})?`, 'gi'),
            `$1$${livePrice} [LIVE]`
        );

        // 3. Prepend a hard price-override banner before "- The Data:" line
        if (patched.includes('- The Data:') || patched.includes('The Data:')) {
            patched = patched.replace(
                /([-\s]*The Data:)/i,
                `⚡ LIVE_PRICE_${ticker}: $${livePrice} (mechanically verified — downstream agents must use this)\n$1`
            );
        } else {
            // No The Data field found — prepend to full output
            patched = `⚡ LIVE_PRICE_${ticker}: $${livePrice} [mechanically verified]\n` + patched;
        }

        return patched;
    }

    async assessInfo(context, currentData, userPort, lastDecision, buyingPower, openAccOrders, remainingTrades, orders24h, openPositionCount = 0, geopoliticalSummary = null) {
        const [userPortfolio, openAccountOrders] = [DataCleaner.stringifyPortfolio(userPort) || [], DataCleaner.stringifyOpenOrders(openAccOrders) || []]
        // Pass cleaned array + live sector cache — handles emergent tickers Scout has previously classified
        const portfolioComposition = buildPortfolioComposition(userPort, getSectorCacheMap());

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

[SECOND-ORDER THINKING] Trace 2-3 steps downstream: Event → disrupted INPUT → who BENEFITS from that shortage/spike (mid-cap, under-owned).
Example: Hormuz closure → natgas spike → fertilizer surge → MOS/NTR/CF (not oil majors).
Rules: NOT headline ticker. Must be input/infrastructure provider. Mid-cap preferred.

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

[PORTFOLIO DEFENSE — THREAT SCAN] Holdings: ${userPortfolio}
Open Orders: ${openAccountOrders || 'NONE'} — FORBIDDEN from recommending any ticker with ACCEPTED/WORKING order.

Before looking for new opportunities, scan EACH held position against today's macro/OSINT data.
Ask: "Is there an event in the current data that will cause this position to DROP before I act?"

DURABLE ASSETS (always recover — use TRADE AROUND, never panic-exit at a loss):
${[...this.durableAssets].join(', ')}
Rule: if a held durable asset faces a TEMPORARY headwind (fear premium unwind, short-term sector rotation) but no structural thesis change → output TRADE AROUND, not DEFENSIVE. The goal is to lower cost basis, not lock in a loss.

PROFIT SCAN: Also check if any held position is up >15% with no clear continuation catalyst. If so, output TRADE AROUND (Sell_Target=current price or slight premium, Reentry_Target=S1 or -5%). Profit-taking and re-entry is always better than riding a winner back to flat.

THREAT PATTERNS: Commodity fear (SLV/GLD/USO) → dump on ceasefire/de-escalation | Sector rotation → old regime outflows before price reacts | Catalyst expiry → thesis event resolved/imminent resolution | Geo reversal → escalation buy becomes SELL on peace signal, exit BEFORE confirmation | Sector headwind → rate hike vs growth, dollar strength vs commodities.
DEFENSIVE THRESHOLD: high-prob downside catalyst in today's data, not yet priced (position not already down >8%), specific+imminent only — no vague macro noise. Use DEFENSIVE only when the asset is NOT in the durable list OR the thesis is structurally broken (not just temporarily pressured). TRADE AROUND beats DEFENSIVE for durable assets.

${portfolioComposition}

[PDT] Recent fills (24h): ${orders24h || 'None.'}
${remainingTrades === 0
  ? 'DEFENSIVE MODE: no round trips. SWING or LONG only. Use constraint to force better entries.'
  : 'AGGRESSIVE MODE: intraday permitted. Still prefer SWING/LONG if signal warrants.'}

[SCORING] Ideas list (starting point only — cold discovery encouraged):
${JSON.stringify((currentData.ideas || []).slice(0, 6).map(i => ({ title: i.title, ticker: i.ticker, type: i.type, horizon: i.horizon })))}

CONVICTION: Congressional Cluster +3 | Earnings Beat+Raise same day +3 | FDA approval/PDUFA same day +3 | Contract/Award >$100M same day +3 | Emerging sector infrastructure +3* | Blue Chip Discount (Top10 cap, price<200MA, RSI<35) +3 | News Catalyst (earnings/FDA/contract) +2
INTRADAY: Pre-market gap >2% on volume +3 | Earnings day momentum (stock moving >3% on open, volume 3x) +3 | Technical breakout (price clears R1 on 2x+ volume) +2 | Catalyst within 24h (FDA/earnings/FOMC) +2
TECHNICAL: RSI Extreme (<30 or >70) +2 | Volume Anomaly >2x avg +1 | 5m Momentum >1.5% +1 | Sector Rotation +1 | RSI cross 50 (up or down) with momentum +1
DISCOVERY: OSINT Catalyst +2 | Second-Order Play +2 | Structural Displacement +2 | Insider Buy >$50k +1 | Strong Analyst Upgrade +1
PENALTIES: Repeat ${lastDecision?.ticker || 'None'} no new data -2 | Already in portfolio no rotation rationale -1 | Earnings in <2d (binary risk, no technical setup) -1 | [SECTOR BIAS above — bullish sector +1 to +3, bearish/flat+full sector -1 to -4, redundant pair -3, ETF new SWING/INTRADAY -2]
*Emerging sector floor: named catalyst today + backbone/infrastructure play (not headline ticker) + non-mega-cap. All 3 required.

CATALYST URGENCY: If catalyst (earnings, FDA, contract, FOMC) fires TODAY or TOMORROW — escalate at score ≥6. Window closes fast. INTRADAY preferred if catalyst is same-day. Missing a time-sensitive setup is as costly as a bad trade.

Rotation candidate ONLY if: down ≥3% from entry AND new opp scores ≥6 pts. Sub-3% loss = noise, never rotate.

[POSITION CAP] Open now: ${openPositionCount}
0-2 → escalate if ≥6 pts | 3-4 → escalate if ≥7 pts | 5+ → QUIET unless rotation OR ≥9 pts
MINIMUM NOTIONAL: Buying power is $${buyingPower}. If buying power < $25, output QUIET — an underfunded position adds no value and wastes a day trade slot.
QUIET if: score below threshold | buying power < $25 | no SWING/LONG when trades=0 | all targets have open orders
QUIET is disciplined patience, not failure. Preserving capital and day trade slots for a high-conviction setup is the correct play. State clearly which threshold forced QUIET.

[OUTPUT] — Choose ONE of the four statuses below. Priority: TRADE AROUND > DEFENSIVE > ESCALATING > QUIET.
QUIET: STATUS: QUIET | Reason: [which threshold failed, 1 sentence]

TRADE AROUND: (use for durable assets with temporary headwinds OR held positions up >15% ready to take profit)
STATUS: TRADE AROUND
- Ticker: [held symbol]
- Scenario: [UNDERWATER = in red, waiting for bounce to exit better | PROFIT TAKE = up >15%, locking gains and re-entering lower]
- Reason: [why this is temporary, not structural — or why taking profit now beats holding]
- Current_Price: [live price from portfolio data]
- Avg_Cost: [cost per share from portfolio — must match holdings data above]
- Breakeven: [avg_cost + small buffer for fees, e.g. avg_cost × 1.005]
- Sell_Target: [UNDERWATER: R1 or breakeven price | PROFIT TAKE: current price or slight premium]
- Reentry_Target: [specific re-buy price — S1, or current price −3% to −5%]
- Horizon: [expected time for Sell_Target to be reached — INTRADAY/SWING/LONG]
- The Data: [current price, RSI, momentum, key support/resistance if known]
- Scout's Note: [why TRADE AROUND beats selling at a loss or holding a winner. What invalidates this — e.g. if price breaks Reentry_Target before Sell fills, re-assess.]

DEFENSIVE:
STATUS: DEFENSIVE
- Ticker: [held symbol at risk — must NOT be in durable assets list unless thesis is structurally broken]
- Threat: [specific macro/geopolitical event that will cause the drop — be precise, not vague]
- Urgency: [IMMEDIATE = exit this session, thesis fully reversed | SWING = exit within 1-3 days, threat building | WATCH = monitor only, DO NOT act yet — no order will be placed]
- Exit_Before: [the specific event or price trigger that will cause the drop]
- Thesis_Expiry: [why the original buy thesis is now exhausted or reversed]
- The Data: [current price, P&L estimate, RSI, any relevant technicals]
- Scout's Note: [why this is a DEFENSIVE signal, not noise. What would have to be true for you to be WRONG about this threat.]

ESCALATING:
STATUS: ESCALATING
- Horizon: [INTRADAY|SWING|LONG] — [why]
- Compliance: Trades=${remainingTrades}/3 | Mode=${remainingTrades > 0 ? 'Aggressive' : 'Defensive'}
- Ticker: [symbol]
- Sector: [sector name — use existing names (Defense, Semiconductors, Biotech, Cybersecurity, Energy Midstream, Precious Metals, etc.) OR coin a new sector name if this is an emergent play that doesn't fit. This is stored permanently so the system learns your classifications over time.]
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

            // Step 2: Enrich with live price data — both ESCALATING and DEFENSIVE paths need this.
            // ESCALATING: re-run Scout with live data so it can update The Data field.
            // DEFENSIVE: no re-run needed (held position thesis is already written), just patch price.
            let finalText = draftText;

            if (draftText.toUpperCase().includes('ESCALATING')) {
                const enrichResult = await this._enrichWithLivePrice(draftText);
                if (enrichResult) {
                    const { enriched, quote, ticker } = enrichResult;

                    // Re-run with live price appended so Scout can update The Data field
                    const enrichedContext = context + enriched;
                    const enrichedRes = await this.complete(ScoutSysPrompt, enrichedContext, { maxTokens: 4096 });
                    finalText = enrichedRes.text;
                    console.log(`[SCOUT] ✅ Re-ran with live price data.`);

                    // Mechanically patch the price — LLM anchoring on training data is
                    // too strong to rely on prompt instructions alone.
                    if (quote?.price) {
                        const prePatch = finalText;
                        finalText = this._patchLivePrice(finalText, ticker, quote.price);
                        if (finalText !== prePatch) {
                            console.log(`[SCOUT] 🔧 Price patched in briefing: ${ticker} = $${quote.price}`);
                        }
                    }
                }
            } else if (draftText.toUpperCase().includes('STATUS: DEFENSIVE')) {
                // DEFENSIVE: patch live price without re-running — we only need Gregor/Phi/Theta
                // to have accurate price data, not a revised Scout analysis.
                const enrichResult = await this._enrichWithLivePrice(draftText);
                if (enrichResult) {
                    const { quote, ticker } = enrichResult;
                    if (quote?.price) {
                        const prePatch = finalText;
                        finalText = this._patchLivePrice(finalText, ticker, quote.price);
                        if (finalText !== prePatch) {
                            console.log(`[SCOUT] 🔧 Defensive price patched: ${ticker} = $${quote.price}`);
                        }
                    }
                } else {
                    console.warn(`[SCOUT] ⚠ Could not fetch live price for DEFENSIVE ticker — Gregor will use portfolio estimate.`);
                }
            }

            return finalText;

        } catch (err) {
            console.error("[RedLine] Beta Failed to Assess Market Data:", err.message);
        }
    }
}
