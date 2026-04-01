/**
 * phi.mjs — Phi, Lead Growth Catalyst (Bull)
 *
 * FIXES:
 *  1. scoutBriefing, portfolio, buyingPower now injected as a user-turn message
 *     (previously only in system prompt — model couldn't ground responses on them)
 *  2. Removed NVIDIA named-stock anchor from prompt
 *  3. TARGET: enforced as single-line regex-safe output
 *  4. Fallback guard added when conversation has no user turn
 */

import { CouncilAgent } from './councilAgent.mjs';

export class PhiLLM extends CouncilAgent {
    constructor(config) {
        super("Phi", config);
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
            messages.push({ role: 'user', content: 'Please review the briefing and respond.' });
        }

        const res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: JSON.stringify({
                model: this.model,
                messages,
                temperature: opts.temp ?? 0.7,
                max_completion_tokens: opts.maxTokens || 2048,
                ...(opts.extra || {}),
            }),
            signal: AbortSignal.timeout(opts.timeout || 30000),
        });

        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            throw new Error(`${this.name} API Error: ${res.status} - ${errData.error?.message || res.statusText}`);
        }

        const data = await res.json();
        console.log(`[PHI] ${data.choices[0].message.content}`);
        return data.choices[0].message.content;
    }

    async assessInfo(sysPrompts, conversation, scoutBriefing, portfolio, buyingPower, openAccountOrders) {
        const BullSysPrompt = `Role: "Phi", Lead Growth Catalyst.
Mission: Identify the single best Alpha opportunity from the Scout's briefing. We must grow and maintain the portfolio and increase capital from ${buyingPower} in the shortest time if possible. No additional capital will be given.

OPERATIONAL DIRECTIVES:
1. Scout Priority: Your ONLY valid target is the exact ticker flagged in the Scout's Briefing.
   Do NOT substitute a different ticker. If no ticker is clear, respond: TARGET: NONE
2. TARGET format (ticker selection step ONLY): respond with a single line:
   TARGET: [TICKER]
   No other text. No explanation. Just that one line.
3. Bull Thesis (analysis step): Build an aggressive, data-backed case.
   Reference the specific price, RSI, and catalyst from the Scout's briefing.
4. Momentum: If Scout flags a breakout, argue for aggressive entry.
5. Deployment Logic:
   - Buying power >50% of total value → argue 5-7% portfolio allocation
   - Buying power <20% of total value → suggest 1-2% scalp only
6. Risk as Opportunity: Use specific VIX data to argue volatility = discount.
   Do not use vague sentiment — cite numbers.`;

        // ── KEY FIX: params injected as a user-turn message ──────────────────
        // Previously these were only referenced in the system prompt, which means
        // the model saw them as instructions but couldn't ground its output on them.
        // Putting them in the user turn gives the model actual data to respond to.
        const dataUserMsg = [
            `=== SCOUT BRIEFING ===`,
            scoutBriefing || '(none provided)',
            ``,
            `=== ACCOUNT STATE ===`,
            `Portfolio: ${portfolio || '(none)'}`,
            `Buying Power: ${buyingPower ?? '(unknown)'} USD`,
            `Open Account Orders ${openAccountOrders}`,
            ``,
            `=== YOUR TASK ===`,
            sysPrompts,
        ].join('\n');

        // Merge: existing conversation turns + the new data user message
        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            const res = await this.complete(BullSysPrompt, fullConversation, { maxTokens: 4096 });
            return res;
        } catch (err) {
            console.error("[RedLine] Phi failed to assess market data:", err.message);
            throw err;
        }
    }
}
