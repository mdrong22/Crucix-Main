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
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const raw = await super.complete(systemPrompt, userMessage, opts);
        const cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        console.log(`[GREGOR] ${cleaned}`);
        return cleaned;
    }

    // ── SIGNATURE UPDATED: vix parameter added ───────────────────────────────
    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', opts = {}) {
        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider.
Mission: Synthesize Phi vs. Theta to issue a Final Trade Command with exact parameters.

OPERATIONAL DIRECTIVES:
1. The Final Call: Weigh Phi's Alpha case vs. Theta's Risk case. Pick a side — do not hedge.
2. Liquidity Logic: If buying power is <10% of total value, default to WAIT unless
   Scout flagged an "Emergency Exit" or "Safe Haven Play."
3. Recent Performance: Review the last 24h orders. If on a losing streak, favor Theta.
4. Capital Preservation: You are a Decider, not a mediator.
5. Position Sizing: Calculate units based on buying power and the live price in the briefing.
   Never output units: null. If unsure, default to 1 unit.
6. Current Market Time (EST): ${new Date().toLocaleString("en-US", {timeZone: "America/New_York"})}


VERDICT FORMAT (mandatory — output this exact JSON on one line, no markdown fences):
VERDICT: {"action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER,"trading_session":"REGULAR"|"EXTENDED"}

Rules:
- price must be a number for Limit orders, null for Market orders
- units must always be a positive number — never null or zero
- The entire VERDICT line must be valid JSON with no trailing commas`;

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
