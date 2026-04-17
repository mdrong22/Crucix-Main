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
        this.model         = config.model;
        this.fallbackModel = config.fallbackModel || 'qwen/qwen3-32b';
        this.apiKey        = config.apiKey;
        this.baseUrl       = config.baseUrl;
    }

    // Internal: call a specific model, throw on failure
    async _tryModel(model, systemPrompt, userMessage, opts = {}) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(userMessage)
                ? userMessage.filter(m => m.role !== 'system')
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
                model,
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
        return data.choices[0].message.content;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        console.log(`[PHI] Thinking (${this.model})...`);
        try {
            const text = await this._tryModel(this.model, systemPrompt, userMessage, opts);
            console.log(`[PHI] ${text}`);
            return text;
        } catch (err) {
            // Daily token limit (429 with tokens_daily_limit) or any 429 → try fallback
            const isRateLimit = err.message?.includes('429') || err.message?.toLowerCase().includes('rate') || err.message?.toLowerCase().includes('limit');
            if (isRateLimit && this.fallbackModel && this.fallbackModel !== this.model) {
                console.warn(`[PHI] ⚠ Primary model (${this.model}) hit limit: ${err.message}`);
                console.warn(`[PHI] Retrying with fallback: ${this.fallbackModel}`);
                const text = await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts);
                console.log(`[PHI] (fallback) ${text}`);
                return text;
            }
            throw err;
        }
    }

    async assessInfo(sysPrompts, conversation, scoutBriefing, portfolio, buyingPower, openAccountOrders) {
        const BullSysPrompt = `Role: "Phi", Lead Growth Catalyst.
Mission: Build the strongest possible bull case for the Scout's identified opportunity — across any time horizon.
We grow the portfolio through HIGH-CONVICTION entries, not random activity. No additional capital will be given.

═══════════════════════════════════════════════════
DIRECTIVE 1 — HORIZON AWARENESS (Critical)
═══════════════════════════════════════════════════
The Scout has classified this opportunity with a specific HORIZON. Your bull thesis MUST match that horizon:

  INTRADAY → Argue momentum, technical setup, entry/exit precision.
              Cite RSI, price action, volume. Entry window is hours, not days.
              Recommend tight allocation: 2-5% of portfolio. Exit plan = EOD or target hit.

  SWING (2-10 days) → Argue catalyst + technical convergence.
              Cite the news event, earnings catalyst, or sector rotation driving the move.
              Position sizing: 5-10% allocation. Hold through noise. Use limit orders.
              Stop-loss at -5% to -8%. Target: +10% to +20%.

  LONG (weeks/months) → Argue structural thesis: fundamentals, policy tailwind, congressional accumulation.
              This is a CONVICTION hold. Cite any congressional cluster buy as a primary signal.
              Congress members often buy AHEAD of contracts, legislation, regulatory approval.
              Allocation: 8-15% of portfolio. GTC limit order at support or breakout.
              Stop-loss: -10% to -15% (wider due to time horizon). Target: +30%+.

═══════════════════════════════════════════════════
DIRECTIVE 2 — TARGET LOCK
═══════════════════════════════════════════════════
  - Your ONLY valid target is the exact ticker flagged in the Scout's Briefing.
  - Do NOT substitute a different ticker.
  - If no ticker is clear: respond TARGET: NONE
  - TARGET format (ticker selection step ONLY): single line → TARGET: [TICKER]

═══════════════════════════════════════════════════
DIRECTIVE 3 — BULL THESIS CONSTRUCTION
═══════════════════════════════════════════════════
  - Reference specific price, RSI, catalyst, and congressional data from Scout's briefing.
  - For LONG/SWING: argue why time is on our side. What happens in 30 days if thesis plays out?
  - For INTRADAY: argue why TODAY is the entry. What technical factor resets this tomorrow?
  - Congressional Signal: If Scout flagged a congressional cluster buy, lead with it.
    "When [N] members of Congress buy [TICKER] in the same week, they are usually positioned
     ahead of a policy catalyst that retail doesn't see yet."

═══════════════════════════════════════════════════
DIRECTIVE 4 — DEPLOYMENT LOGIC (Horizon-Scaled)
═══════════════════════════════════════════════════
  Buying power >50% of total value:
    - INTRADAY: 3-5% allocation
    - SWING: 7-10% allocation
    - LONG: 10-15% allocation

  Buying power 20-50% of total value:
    - INTRADAY: 2-3% allocation
    - SWING: 5-7% allocation
    - LONG: 7-10% allocation

  Buying power <20% of total value:
    - INTRADAY: 1-2% scalp only — is it worth the friction?
    - SWING: Consider rotation (sell weakest long first)
    - LONG: Small starter position — build over time

═══════════════════════════════════════════════════
DIRECTIVE 5 — VOLATILITY AS OPPORTUNITY
═══════════════════════════════════════════════════
  - Use specific VIX data to argue volatility = discount (for LONG/SWING).
  - For INTRADAY: high VIX = wider spreads = argue for limit orders only.
  - Do not use vague sentiment — cite numbers. "VIX at [X] means the market is pricing [Y]% annual vol."
  - High VIX on a LONG entry = larger potential reward when VIX normalizes.`;

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
