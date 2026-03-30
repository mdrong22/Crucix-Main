/**
 * gregor.mjs — Optimized Gregor, Master Macro Decider
 * Focus: High-speed JSON generation and strict "Whole Share" enforcement for Extended Hours.
 */

import { CouncilAgent } from "./councilAgent.mjs";

export class GregorLLM extends CouncilAgent {
    constructor(config) {
        super("Gregor", config);
        this.enableThinking = config.enableThinking ?? false;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        // Optimization: Lower max_tokens for faster completion when thinking is disabled
        const finalOpts = {
            ...opts,
            max_tokens: this.enableThinking ? 4000 : 800, 
            extra: { 
                ...(opts.extra || {}), 
                enable_thinking: this.enableThinking 
            }
        };
        
        const raw = await super.complete(systemPrompt, userMessage, finalOpts);
        // Remove thinking tags if present
        const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        console.log(`[GREGOR] ${cleaned}`);
        return cleaned;
    }

    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', opts = {}) {
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);  
        const hours = estDate.getHours();
        const minutes = estDate.getMinutes();
        const currentTimeValue = hours * 100 + minutes;
        
        // 09:30 to 16:00
        const isRegularHours = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus = isRegularHours ? "REGULAR_MARKET_OPEN" : "EXTENDED_HOURS_RESTRICTED";  

        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider. 
Mission: Synthesize debate to issue a 1-line JSON command. 
Status: ${marketStatus} | Power: ${buyingPower} | VIX: ${vix}.

STRICT RULES:
1. SESSION LOGIC: 
   - IF REGULAR_MARKET_OPEN: "order_type":"Market", "time_in_force":"Day", "trading_session":"REGULAR". "notional_value" is ALLOWED.
   - IF EXTENDED_HOURS_RESTRICTED: "order_type":"Limit", "time_in_force":"Day", "trading_session":"EXTENDED". "notional_value" is FORBIDDEN. Use "units" (Whole numbers only). 

2. UNIT CALCULATION (Extended Hours):
   - You MUST floor the units: Math.floor(${buyingPower} / price). If result < 1, action: "WAIT".

3. OUTPUT FORMAT:
   - Start with "TARGET: [TICKER]"
   - 1-sentence logic.
   - End with "VERDICT: {"action":"...","order_type":"...","time_in_force":"...","price":...,"units":...,"notional_value":...,"trading_session":"..."}"
   - NO markdown fences. NO trailing commas.`;

        const dataUserMsg = [
            `=== ACCOUNT ===`,
            `Buying Power: ${buyingPower} | Total Value: ${totalValue}`,
            `VIX: ${vix} | Time: ${estString}`,
            `Recent Orders: ${orders24h || 'None'}`,
            `=== TASK ===`,
            sysPrompts,
        ].join('\n');

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            return await this.complete(GregorSysPrompt, fullConversation, { ...opts, temp: 0.3 });
        } catch (err) {
            console.error("[RedLine] Gregor Error:", err.message);
            return 'VERDICT: {"action":"WAIT"}';
        }
    }
}