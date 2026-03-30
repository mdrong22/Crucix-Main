/**
 * gregor.mjs — Gregor, Master Macro Decider
 *
 * FIXES:
 *  1. VIX no longer hardcoded at 27.45 — passed in live via assessInfo signature
 *  2. VERDICT output format now specifies full JSON object (was just BUY|SELL|WAIT word —
 *     debate.mjs's JSON extractor always failed, causing every trade to default to WAIT)
 *  3. assessInfo signature updated to accept vix parameter
 *  4. Debate context injected as user-turn message so Gregor sees Phi + Theta arguments
 */

import { CouncilAgent } from "./councilAgent.mjs";

export class GregorLLM extends CouncilAgent {
    constructor(config) {
        super("Gregor", config);
        this.enableThinking = config.enableThinking
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        opts ={...opts, extra: { ...(opts.extra || {}), enable_thinking: this.enableThinking } }
        const raw = await super.complete(systemPrompt, userMessage, opts);
        const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        console.log(`[GREGOR] ${cleaned}`);
        return cleaned;
    }

    // ── SIGNATURE UPDATED: vix parameter added ───────────────────────────────
    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', opts = {}) {
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);  
        const hours = estDate.getHours();
        const minutes = estDate.getMinutes();
        const currentTimeValue = hours * 100 + minutes;
        const isRegularHours = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus = isRegularHours ? "REGULAR_MARKET_OPEN" : "EXTENDED_HOURS_RESTRICTED";  
        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider. 

        Mission: Synthesize Phi vs. Theta to issue a Final Command. We must grow the portfolio and increase capital from ${buyingPower} in the shortest time if possible. No additional capital will be given.
        
        Context: Buying Power: ${buyingPower} | Total Value: ${totalValue} | Market Time: ${estDate} (EST) | Market Status: ${marketStatus}.
        
        OPERATIONAL DIRECTIVES:
        1. The Final Call: Weigh the Bull's "Alpha" vs. the Bear's "Risk." 
        2. Post-Market Rule: It is currently after 4:00 PM EST. You MUST use "order_type":"Limit", "time_in_force":"GTC", and "trading_session":"EXTENDED" for any BUY/SELL.
        3. Ticker Extraction: You MUST start your response with "TARGET: [TICKER]" followed by your logic.
        4. Position Sizing: Calculate units based on buying power. If you want a fractional amount, you MUST provide "notional_value" (the USD amount) and you may set "units" to null.
        
        MANDATORY OUTPUT FORMAT:
        You are a machine. You must output exactly one line of JSON at the end of your response following the word "VERDICT:". 
        Do NOT use markdown code fences. Do NOT use multiple lines. Do NOT add trailing commas.
        The JSON must start on the same line as the word "VERDICT:".
        
        VERDICT: {"action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER_OR_NULL,"notional_value":NUMBER_OR_NULL,"trading_session":"REGULAR"|"EXTENDED"}
        
        Example:
        TARGET: BA
        Logic: Defense contracts and low RSI outweigh current VIX levels.
        VERDICT: {"action":"BUY","order_type":"Limit","time_in_force":"GTC","price":190.52,"units":null,"notional_value":100,"trading_session":"EXTENDED"}`;

        // ── KEY FIX: all decision data injected as user-turn message ─────────
        // Previously buyingPower/totalValue/orders24h were only string-interpolated
        // into the system prompt. Gregor's base complete() may not see system content
        // the same way — putting it in the user turn ensures it's grounded.
        const dataUserMsg = [
            `=== ACCOUNT STATE ===`,
            `Buying Power: ${buyingPower ?? 'N/A'} USD`,
            `Total Value:  ${totalValue ?? 'N/A'} USD`,
            `Live VIX:     ${vix}`,
            ``,
            `=== LAST 24H ORDERS ===`,
            `${orders24h || '(no recent orders)'}`,
            ``,
            `=== YOUR TASK ===`,
            sysPrompts,
        ].join('\n');

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            const res = await this.complete(GregorSysPrompt, fullConversation, opts);
            return res;
        } catch (err) {
            console.error("[RedLine] Gregor failed to reach a verdict:", err.message);
            throw err;
        }
    }
}
