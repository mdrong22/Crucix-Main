/**
 * scout.mjs — Beta, Market Scout & Trend Synthesizer
 *
 * FIXES:
 *  1. Fetches live price + RSI for the candidate ticker before escalating
 *     (was escalating on news alone with no price validation → Boeing bias)
 *  2. Fixed template literal typo: ${currentData.ideas}} → ${currentData.ideas}
 *  3. Live price injected into Scout's briefing so downstream council has real numbers
 *  4. getLiveQuote injected as dependency (same instance used in debate.mjs)
 */

import { CouncilAgent } from "./councilAgent.mjs";

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
            const quote = await this.getLiveQuote(ticker);
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
                `  ${rsiNote}`,
            ].join('\n');

            console.log(`[SCOUT] 📡 Live quote enrichment for ${ticker}: $${quote.price}`);
            return enriched;
        } catch (err) {
            console.warn(`[SCOUT] ⚠️  Live quote failed for ${ticker}: ${err.message}`);
            return '';
        }
    }

    async assessInfo(context, currentData, userPortfolio, userAccountHoldings, lastDecision, buyingPower) {
        // Live VIX from FRED data
        const vix = currentData.fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
        console.log(`[REDLINE] Last escalation → Ticker: ${lastDecision?.ticker || 'None'} | Trigger: ${lastDecision?.trigger || 'None'} | Date: ${lastDecision?.date || 'None'}`)
        const ScoutSysPrompt = `Role: "Beta", Market Scout & Trend Synthesizer.
Objective: Identify 1 specific "Leverageable Idea" per briefing by connecting world intelligence with live market technicals.
Primary Sources: World intelligence ideas, portfolio state, and live VIX.

ANTI-BIAS RULE: Do NOT default to any single ticker repeatedly.
Cross-reference ALL tickers present in the ideas feed. Pick the one with the strongest
combination of: (a) direct news catalyst, (b) technical trigger (RSI extreme or >1.5% move),
and (c) portfolio fit. If a Ticker appears again, it must meet ALL three criteria independently.

OPERATIONAL DIRECTIVES:
1. Active Hunting: Cross-reference the ideas below with tickers moving >1.5% or hitting
   RSI extremes (<30 or >70). You MUST suggest a specific ticker if escalating.
   IMPORTANT: The live price data will be appended below after your initial analysis.
   Use it to confirm your ticker choice has real technical merit, not just news.

2. Anti-Repetition Logic:
   Last escalation → Ticker: ${lastDecision?.ticker || 'None'} | Trigger: ${lastDecision?.trigger || 'None'} | Date: ${lastDecision?.date || 'None'}
   If your proposed ticker matches the last escalation ticker, you are FORBIDDEN from
   escalating UNLESS: price has moved >1% OR a new High-Impact event has occurred.

3. Quiet Mode: If no triggers are met OR the info is redundant, respond strictly:
   "STATUS: QUIET. No escalation required."

4. Averaging Down: If a holding in the portfolio drops >3% on no fundamental news,
   flag it as a "Safe Haven Play" and set STATUS: ESCALATING with that ticker.

CURRENT DATA:
VIX: ${vix}
Portfolio: ${userPortfolio}
Holdings: ${userAccountHoldings}
Buying Power: ${buyingPower}
World Intelligence & Ideas:
${currentData.ideas}

OUTPUT FORMAT (STRICT — no extra text before STATUS line):
STATUS: [QUIET | ESCALATING]
- **Ticker:** [Focus Symbol]
- **Trigger:** [Escalation Reason — must be specific, not generic]
- **The Data:** [Price, RSI, VIX Level — use live price data appended below]
- **The Story:** [2-3 sentence macro context tied directly to the ticker]
- **Scout's Note:** [High-conviction take for the council — cite specific numbers]`;

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
