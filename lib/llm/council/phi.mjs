/**
 * phi.mjs — Phi, Lead Growth Catalyst (Bull)
 *
 * FALLBACK CHAIN (in order):
 *  1. Primary Groq model   (GROQ_MODEL)
 *  2. Groq fallback model  (PHI_FALLBACK_MODEL / llama-3.3-70b-versatile)
 *  3. Cerebras             (llama-3.3-70b-instruct — 30 RPM / 1M TPD, free)
 *  4. SambaNova            (Meta-Llama-3.3-70B-Instruct — 20 RPM, free)
 */

import { CouncilAgent } from './councilAgent.mjs';
import { callProvider, isRateLimit } from './utils/providers.mjs';

export class PhiLLM extends CouncilAgent {
    constructor(config) {
        super("Phi", config);
        this.model         = config.model;
        this.fallbackModel = config.fallbackModel || 'llama-3.3-70b-versatile';
        this.apiKey        = config.apiKey;
        this.baseUrl       = config.baseUrl;

        // Free-tier provider pool (passed in from crucix.config providers block)
        this.cerebras  = config.providers?.cerebras  || null;
        this.sambanova = config.providers?.sambanova || null;
    }

    // ── Build standardised messages array ────────────────────────────────────
    _buildMessages(systemPrompt, userMessage) {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(userMessage)
                ? userMessage.filter(m => m.role !== 'system')
                : [{ role: 'user', content: String(userMessage) }])
        ];
        if (!messages.some(m => m.role === 'user')) {
            messages.push({ role: 'user', content: 'Please review the briefing and respond.' });
        }
        return messages;
    }

    // ── Tier 1 & 2: Groq (primary or fallback model) ─────────────────────────
    async _tryGroq(model, systemPrompt, userMessage, opts = {}) {
        const messages = this._buildMessages(systemPrompt, userMessage);
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
            throw new Error(`PHI Groq ${res.status} — ${errData.error?.message || res.statusText}`);
        }
        const data = await res.json();
        return data.choices[0].message.content;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const messages = this._buildMessages(systemPrompt, userMessage);

        // ── Tier 1: Primary Groq ─────────────────────────────────────────────
        console.log(`[PHI] Thinking (${this.model})...`);
        try {
            const text = await this._tryGroq(this.model, systemPrompt, userMessage, opts);
            console.log(`[PHI] ✓ Primary`);
            return text;
        } catch (err) {
            if (!isRateLimit(err.message)) throw err;
            console.warn(`[PHI] ⚠ Primary Groq rate-limited: ${err.message}`);
        }

        // ── Tier 2: Groq fallback model ──────────────────────────────────────
        if (this.fallbackModel && this.fallbackModel !== this.model) {
            console.warn(`[PHI] Trying Groq fallback: ${this.fallbackModel}`);
            try {
                const text = await this._tryGroq(this.fallbackModel, systemPrompt, userMessage, opts);
                console.log(`[PHI] ✓ Groq fallback`);
                return text;
            } catch (err2) {
                if (!isRateLimit(err2.message)) throw err2;
                console.warn(`[PHI] ⚠ Groq fallback also exhausted: ${err2.message}`);
            }
        }

        // ── Tier 3: Cerebras (free, 30 RPM, 1M TPD) ─────────────────────────
        if (this.cerebras?.apiKey) {
            console.warn(`[PHI] Switching to Cerebras (${this.cerebras.model})...`);
            try {
                const text = await callProvider(
                    this.cerebras.baseUrl, this.cerebras.apiKey, this.cerebras.model,
                    messages, { temperature: 0.7, maxTokens: opts.maxTokens || 2048 }
                );
                console.log(`[PHI] ✓ Cerebras`);
                return text;
            } catch (err3) {
                if (!isRateLimit(err3.message)) throw err3;
                console.warn(`[PHI] ⚠ Cerebras also rate-limited: ${err3.message}`);
            }
        } else {
            console.warn('[PHI] CEREBRAS_API_KEY not set — skipping tier 3');
        }

        // ── Tier 4: SambaNova (free, 20 RPM) ─────────────────────────────────
        if (this.sambanova?.apiKey) {
            console.warn(`[PHI] Switching to SambaNova (${this.sambanova.model})...`);
            const text = await callProvider(
                this.sambanova.baseUrl, this.sambanova.apiKey, this.sambanova.model,
                messages, { temperature: 0.7, maxTokens: opts.maxTokens || 2048 }
            );
            console.log(`[PHI] ✓ SambaNova`);
            return text;
        }

        throw new Error('[PHI] All tiers exhausted — add CEREBRAS_API_KEY or SAMBANOVA_API_KEY to .env');
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

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            return await this.complete(BullSysPrompt, fullConversation, { maxTokens: 4096 });
        } catch (err) {
            console.error('[RedLine] Phi failed to assess market data:', err.message);
            throw err;
        }
    }
}
