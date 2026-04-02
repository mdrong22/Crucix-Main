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

import { getHistoricalTechnicals } from "../../../apis/sources/alpaca.mjs";
import { CouncilAgent } from "./councilAgent.mjs";
import { DataCleaner } from "./utils/cleaner.mjs";

export class ScoutLLM extends CouncilAgent {
    constructor(config, getLiveQuote) {
        super("Beta", config);
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
        this.getLiveQuote = getLiveQuote; // async (ticker) => { price, bid, ask, volume, rsi? }
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': this.apiKey
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
                inputTokens: data.usageMetadata?.promptTokenCount || 0,
                outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
            },
            model: this.model,
        };
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
            const [quote, historical] = await Promise.all([this.getLiveQuote(ticker), getHistoricalTechnicals(ticker)]);
          
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
                `  recent price (5min):   bars: ${historical?.bars || null}, latest close: ${historical?.latestClose || null}, momentum: ${historical?.momentum || null}
                `  ,
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
        console.log(`[REDLINE] Last escalation → Ticker: ${lastDecision?.ticker || 'None'} | Trigger: ${lastDecision?.trigger || 'None'} | Date: ${lastDecision?.date || 'None'}`)
        const ScoutSysPrompt = `Role: "Beta", Market Scout & Trend Synthesizer.
        Objective: Identify 1 "High-Conviction Entry" per briefing. You are the filter for the Council.
        Constraints: No additional capital. Buying Power: ${buyingPower}. Session: ${marketStatus}.
        Compliance: Remaining Day Trades: ${remainingTrades}/3.
        Time: ${estDate} (EST). Market rules strictly follow EST.
        
        OPERATIONAL HIERARCHY (Follow in order):
        
        1. PORTFOLIO & ORDER DEFENSE:
            - Scan ${userPortfolio}. If any holding drops >3% on no news, set STATUS: ESCALATING.
            - CHECK OPEN ORDERS: ${openAccountOrders ? openAccountOrders : 'NONE'}. 
            - CRITICAL: You are FORBIDDEN from recommending a ticker that already has an "ACCEPTED" or "WORKING" order.
            - If an order for a Target is already open, pivot or set STATUS: QUIET.

        2. PDT COMPLIANCE (The "Only Executed" Protocol):
            - Verified Recent Fills (24h): ${orders24h ? orders24h : 'No executed trades.'}
            - IF ${remainingTrades} === 0:
                - You are in DEFENSIVE MODE. You are FORBIDDEN from creating a "Round Trip" today.
                - CRITICAL: If a ticker appears in "Recent Fills" as a BUY today, it is LOCKED. You cannot suggest a "Rotation_Target" for that symbol.
                - You MUST only suggest "Swing/Overnight" entries (buying today to sell tomorrow+).
            - IF ${remainingTrades} > 0:
                - You are in AGGRESSIVE MODE. Day trades (same-day buy/sell) are permitted.

        3. ACTIVE HUNTING & SELECTION:
            - Cross-reference Ideas: ${currentData.ideas}.
            - Selection Criteria: Strongest news catalyst + Technical Trigger (RSI <30/>70 or move >1.5% or strong 5min momentum).
            - Anti-Bias: Do not repeat ${lastDecision?.ticker || 'None'} unless price moved >1% or new high-impact news exists.

        4. EXECUTION VIABILITY (The "No Money" Protocol):
            - IF REGULAR_MARKET_OPEN: Fractional allowed. 
            - IF EXTENDED_HOURS: Whole shares ONLY. 
            - ROTATION RULE: If Buying Power is low, you MUST scan ${userPortfolio} for a "Weakest Link".
            - If a new lead is stronger than the weakest link, set STATUS: ESCALATING and define a "Rotation_Target".
            - *Compliance Check*: Ensure "Rotation_Target" was NOT bought today if ${remainingTrades} === 0.

        5. QUIET MODE:
            - Trigger if: No targets meet triggers OR ${remainingTrades} === 0 and no safe "Overnight" setups exist OR all targets have OPEN_ORDERS.

        OUTPUT FORMAT (STRICT):
        IF STATUS: QUIET
        RETURN ONLY => STATUS: QUIET

        IF STATUS: ESCALATING
        STATUS: ESCALATING
        - **Compliance Status**: [Trades Remaining: ${remainingTrades}/3 | Mode: ${remainingTrades > 0 ? 'Aggressive' : 'Defensive (Overnight Only)'}]
        - **Ticker:** [Focus Symbol to BUY]
        - **Rotation_Target:** [Ticker to SELL (Must be an older position if ${remainingTrades} === 0), else "None"]
        - **Trigger:** [Specific reason: e.g., "RSI Breakout + News"]
        - **The Data:** [Price, RSI, VIX: ${vix}, 5m Momentum]
        - **The Story:** [2-3 sentence macro context]
        - **Scout's Note:** [Acknowledge "Verified Recent Fills" (${orders24h ? orders24h : 'None'}). Explain why this trade is PDT-compliant.]`;
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
