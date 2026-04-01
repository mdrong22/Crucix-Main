import { init } from "@heyputer/puter.js/src/init.cjs";

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
        this.puter = init(config.apiKey)
    }

    async complete(systemPrompt, userMessage) {
        console.log(`[GREGOR] Thinking...`);
        const messages = [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(userMessage) 
                ? userMessage 
                : [{ role: 'user', content: userMessage }])
        ];
        try {
            const response = await this.puter.ai.chat(messages, {
                model: this.model,
                temperature: 0.1,
                use_web: true,
                favour_speed: true 
            });
            const raw = response.toString();
            let sanitized = raw.replace(/https?:\/\/googleusercontent\.com\/immersive_entry_chip\/\d+/gi, '');
            let cleaned = sanitized.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
            const firstBrace = cleaned.indexOf('{');
            const lastBrace = cleaned.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1) {
                cleaned = cleaned.substring(firstBrace, lastBrace + 1);
            }
            return `VERDICT: ${cleaned}`;

        } catch (err) {
            console.error(`[GREGOR] ❌ HeyPuter Execution Failed:`, err.message);
            try {
                console.warn("[GREGOR] Attempting emergency string completion...");
                const fallback = await puter.ai.complete(`System: ${systemPrompt}\nUser: ${JSON.stringify(userMessage)}\nVerdict:`, {
                    model: 'grok-3-mini'
                });
                return fallback.toString();
            } catch (fallbackErr) {
                throw new Error(`Gregor total failure: ${err.message} -> ${fallbackErr.message}`);
            }
        }
    }
    // ── SIGNATURE UPDATED: vix parameter added ───────────────────────────────
    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', openAccountOrders) {
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
        
        Context: 
        - Buying Power: ${buyingPower} 
        - Total Value: ${totalValue} 
        - Market Time: ${estDate} (EST) 
        - Market Status: ${marketStatus}
        - Open/Pending Orders: ${openAccountOrders}
        
        OPERATIONAL DIRECTIVES:
        1. The Final Call: Weigh the Bull's "Alpha" vs. the Bear's "Risk." 
        2. Open Order Check: Scan openAccountOrders ${openAccountOrders}. If the target ticker already has an "ACCEPTED" or "WORKING" order, you MUST output "action": "WAIT" to avoid duplicate executions.
        3. Post-Market Rule: It is currently after 4:00 PM EST. You MUST use "order_type":"Limit", "time_in_force":"GTC", and "trading_session":"EXTENDED" for any BUY/SELL. You MUST provide a specific "price".
        4. Ticker Extraction: You MUST start your response with "TARGET: [TICKER]" followed by your logic.
        5. Position Sizing: Calculate units based on buying power. If you want a fractional amount, you MUST provide "notional_value" (the USD amount) and you may set "units" to null.
        
        MANDATORY OUTPUT FORMAT:
        You are a machine. You must output exactly one line of JSON at the end of your response following the word "VERDICT:". 
        Do NOT use markdown code fences. Do NOT use multiple lines. Do NOT add trailing commas.
        The JSON must start on the same line as the word "VERDICT:".
        
        VERDICT: {"action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER_OR_NULL,"notional_value":NUMBER_OR_NULL,"trading_session":"REGULAR"|"EXTENDED"}
        
        Example:
        TARGET: BA
        Logic: Defense contracts and low RSI outweigh current VIX levels. No existing open orders found.
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
            `Open Account Orders ${openAccountOrders}`,
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
            const res = await this.complete(GregorSysPrompt, fullConversation);
            return res;
        } catch (err) {
            console.error("[RedLine] Gregor failed to reach a verdict:", err.message);
            throw err;
        }
    }
}
