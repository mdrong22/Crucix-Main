/**
 * theta.mjs — Theta, Lead Risk Architect (Bear)
 *
 * FIXES:
 *  1. portfolio, vix now injected as user-turn message (were only in system prompt)
 *  2. VIX no longer hardcoded at 27.45 — passed in live from debate.mjs
 *  3. Same message-handling fix as Phi (user turn guard)
 *  4. assessInfo signature updated: accepts vix parameter
 */

import { CouncilAgent } from "./councilAgent.mjs";

export class ThetaLLM extends CouncilAgent {
    constructor(config) {
        super("Theta", config);
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        console.log(`[${this.name}] Thinking...`);

        const messages = [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(userMessage)
                ? userMessage.filter(m => m.role !== 'system')  // keep user + assistant turns
                : [{ role: 'user', content: String(userMessage) }])
        ];

        // Guard: API rejects payloads with no user turn
        const hasUserTurn = messages.some(m => m.role === 'user');
        if (!hasUserTurn) {
            console.warn(`[${this.name}] ⚠️  No user-turn in conversation. Adding fallback.`);
            messages.push({ role: 'user', content: 'Please review the briefing and provide your risk assessment.' });
        }

        // QwQ-32b / Qwen3 does not support temperature parameter
        const isQwQ = this.model.includes('qwq') || this.model.includes('qwen3');

        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                ...(!isQwQ && { temperature: opts.temp ?? 0.7 }),
                max_completion_tokens: opts.maxTokens || 2048,
                ...(opts.extra || {})
            }),
            signal: AbortSignal.timeout(opts.timeout || 30000),
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API Error: ${res.status} - ${errData.error?.message || res.statusText}`);
        }

        const data = await res.json();
        console.log(`[THETA] ${data.choices[0].message.content}`);
        return data.choices[0].message.content;
    }

    // ── SIGNATURE UPDATED: vix is now a parameter, not hardcoded ────────────
    async assessInfo(sysPrompts, conversation, userPortfolio, vix = 'N/A') {
        const BearSysPrompt = `Role: "Theta", Lead Risk Architect.
Mission: Protect the portfolio by identifying the Single Point of Failure in the proposed trade.

OPERATIONAL DIRECTIVES:
1. The Prosecutor: Your job is to find reasons to say NO. Assume every rally is a trap.
2. Portfolio Exposure: If the portfolio is already heavy in a sector, flag "Overexposure."
3. Volatility Tax: At the current VIX level, assume stop-losses will be hunted.
   Demand 2x the normal margin of safety. Use the actual VIX number in your argument.
4. Structural Flaws:
   - If Phi cites "News" → you cite "Liquidity risk and news fade"
   - If Phi cites "RSI" → you cite "Divergence and overbought exhaustion"
   - If Phi cites "Contracts" → you cite "Execution risk and budget delays"
5. Concentrate on ONE primary risk — the single reason this trade should be rejected.

OUTPUT: Cold, calculated Bear Thesis in bullet points.
Focus exclusively on why we should REJECT or WAIT.`;

        // ── KEY FIX: portfolio + vix injected as user-turn data ──────────────
        const dataUserMsg = [
            `=== PORTFOLIO STATE ===`,
            `${userPortfolio || '(none provided)'}`,
            ``,
            `=== LIVE MARKET CONDITIONS ===`,
            `VIX: ${vix}`,
            ``,
            `=== YOUR TASK ===`,
            sysPrompts,
        ].join('\n');

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            const res = await this.complete(BearSysPrompt, fullConversation);
            return res;
        } catch (err) {
            console.error("[RedLine] Theta failed to assess market data:", err.message);
            throw err;
        }
    }
}
