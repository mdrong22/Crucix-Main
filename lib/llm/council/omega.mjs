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
import { DataCleaner } from "./utils/cleaner.mjs";

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
            const firstJSONChar = cleaned.search(/[\[\{]/); // Finds first { or [
            const lastJSONChar = cleaned.lastIndexOf(']') > cleaned.lastIndexOf('}') 
                                ? cleaned.lastIndexOf(']') 
                                : cleaned.lastIndexOf('}');

            if (firstJSONChar !== -1 && lastJSONChar !== -1) {
                cleaned = cleaned.substring(firstJSONChar, lastJSONChar + 1);
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
    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', openAccountOrders, GetPortfolio, remainingTrades) {
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);  
        const hours = estDate.getHours();
        const minutes = estDate.getMinutes();
        const currentTimeValue = hours * 100 + minutes;
        const isRegularHours = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus = isRegularHours ? "REGULAR_MARKET_OPEN" : "EXTENDED_HOURS_RESTRICTED";  
        const port = await GetPortfolio()
        const portfolio = DataCleaner.stringifyPortfolio(port)
        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider. 
        Mission: Synthesize Alpha vs. Risk to issue a Final Command. Maximize portfolio growth from ${buyingPower}.
        
        CONTEXT: 
        - Buying Power: ${buyingPower} 
        - Market Time: ${estDate} (EST) | Status: ${marketStatus}
        - Remaining Day Trades: ${remainingTrades}/3
        - Verified Fills (24h): ${orders24h}

        OPERATIONAL DIRECTIVES:
        1. THE FINAL CALL: Weigh the Scout's lead against current VIX: ${vix} and Portfolio: ${portfolio}.
        
        2. PDT SAFETY PROTOCOL (CRITICAL):
           - If ${remainingTrades} === 0:
             - You are FORBIDDEN from executing a "Round Trip" (Buying and Selling the same ticker on the same day).
             - Check "Verified Fills (24h)". If a ticker was BOUGHT today, you CANNOT SELL it. If it was SOLD today, you CANNOT BUY it back.
             - Any trade must be an "Overnight Hold" or a "Rotation" of an OLD position from ${portfolio}.
        
        3. OPEN ORDER DEFENSE: Scan ${openAccountOrders}. If a target ticker already has an "ACCEPTED" or "WORKING" order, output "action": "WAIT". Avoid duplicate fills.

        4. POST-MARKET EXECUTION: Since Status is ${marketStatus}, if EXTENDED:
           - Use "order_type":"Limit", "time_in_force":"GTC", "trading_session":"EXTENDED".
           - Provide a specific "price". No "notional_value" allowed for Limits; calculate "units" instead.

        5. POSITION SIZING: Use "notional_value" (and units: null) ONLY for "order_type":"Market" during REGULAR sessions.

        MANDATORY OUTPUT FORMAT:
        Start with "TARGET: [TICKER]". 
        Logic: [Brief justification citing PDT status if applicable].
        VERDICT: [{"action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER_OR_NULL,"notional_value":NUMBER_OR_NULL,"trading_session":"REGULAR"|"EXTENDED"}]`;

        // ── KEY FIX: all decision data injected as user-turn message ─────────
        // Previously buyingPower/totalValue/orders24h were only string-interpolated
        // into the system prompt. Gregor's base complete() may not see system content
        // the same way — putting it in the user turn ensures it's grounded.
        const dataUserMsg = [
            `=== ACCOUNT STATE ===`,
            `Buying Power: ${buyingPower ?? 'N/A'} USD`,
            `Total Value:  ${totalValue ?? 'N/A'} USD`,
            `Live VIX:     ${vix}`,
            `Remaining Day Trades: ${remainingTrades}/3`,
            ``,
            `=== VERIFIED FILLS (LAST 24H) ===`,
            `${orders24h || '(no recent orders)'}`,
            ``,
            `=== PORTFOLIO & OPEN ORDERS ===`,
            `Current Holdings: ${portfolio}`,
            `Pending Orders: ${openAccountOrders || 'NONE'}`,
            ``,
            `=== SCOUT & COUNCIL INPUT ===`,
            `${sysPrompts}`, 
            ``,
            `=== FINAL INSTRUCTION ===`,
            `If Remaining Trades is 0, ensure the VERDICT does not create a same-day round trip.`,
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
