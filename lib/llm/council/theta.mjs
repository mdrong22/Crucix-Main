/**
 * theta.mjs — Theta, Lead Risk Architect (Bear)
 *
 * FALLBACK CHAIN (in order):
 *  1. Primary model (THETA_MODEL — Qwen3/QwQ via Groq or OpenRouter)
 *  2. NVIDIA NIM    (meta/llama-3.3-70b-instruct — 40 RPM, free credits)
 *  3. Cerebras      (llama-3.3-70b-instruct — 30 RPM / 1M TPD, free)
 */

import { CouncilAgent } from './councilAgent.mjs';
import { callProvider, isRateLimit } from './utils/providers.mjs';

export class ThetaLLM extends CouncilAgent {
    constructor(config) {
        super("Theta", config);
        this.model   = config.model;
        this.apiKey  = config.apiKey;
        this.baseUrl = config.baseUrl;

        // Free-tier provider pool (passed in from crucix.config providers block)
        this.nvidia   = config.providers?.nvidia   || null;
        this.cerebras = config.providers?.cerebras || null;
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
            messages.push({ role: 'user', content: 'Please review the briefing and provide your risk assessment.' });
        }
        return messages;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const messages = this._buildMessages(systemPrompt, userMessage);

        // QwQ-32b / Qwen3 does not support temperature parameter
        const isQwQ = this.model?.includes('qwq') || this.model?.includes('qwen3');

        // ── Tier 1: Primary model (Qwen3 via Groq/OpenRouter) ────────────────
        console.log(`[THETA] Thinking (${this.model})...`);
        try {
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
                throw new Error(`THETA ${res.status} — ${errData.error?.message || res.statusText}`);
            }

            const data = await res.json();
            const text = data.choices[0].message.content;
            console.log(`[THETA] ✓ Primary`);
            return text;

        } catch (err) {
            if (!isRateLimit(err.message)) throw err;
            console.warn(`[THETA] ⚠ Primary model (${this.model}) rate-limited: ${err.message}`);
        }

        // ── Tier 2: NVIDIA NIM (free, 40 RPM, strong reasoning models) ───────
        if (this.nvidia?.apiKey) {
            console.warn(`[THETA] Switching to NVIDIA NIM (${this.nvidia.model})...`);
            try {
                const text = await callProvider(
                    this.nvidia.baseUrl, this.nvidia.apiKey, this.nvidia.model,
                    messages, { temperature: 0.7, maxTokens: opts.maxTokens || 2048 }
                );
                console.log(`[THETA] ✓ NVIDIA NIM`);
                return text;
            } catch (err2) {
                if (!isRateLimit(err2.message)) throw err2;
                console.warn(`[THETA] ⚠ NVIDIA NIM also exhausted: ${err2.message}`);
            }
        } else {
            console.warn('[THETA] NVIDIA_API_KEY not set — skipping tier 2');
        }

        // ── Tier 3: Cerebras (free, 30 RPM, 1M TPD) ─────────────────────────
        if (this.cerebras?.apiKey) {
            console.warn(`[THETA] Switching to Cerebras (${this.cerebras.model})...`);
            const text = await callProvider(
                this.cerebras.baseUrl, this.cerebras.apiKey, this.cerebras.model,
                messages, { temperature: 0.7, maxTokens: opts.maxTokens || 2048 }
            );
            console.log(`[THETA] ✓ Cerebras`);
            return text;
        }

        throw new Error('[THETA] All tiers exhausted — add NVIDIA_API_KEY or CEREBRAS_API_KEY to .env');
    }

    async assessInfo(sysPrompts, conversation, userPortfolio, vix = 'N/A', openAccountOrders) {
        const BearSysPrompt = `Role: "Theta", Lead Risk Architect.
Mission: Protect the portfolio by identifying the SINGLE POINT OF FAILURE in this trade — across any time horizon.
Risk does not shrink because a trade is labeled "Long." It changes shape. Your job is to find it.

═══════════════════════════════════════════════════
DIRECTIVE 1 — HORIZON-MATCHED RISK FRAMEWORK
═══════════════════════════════════════════════════
The Scout has assigned a HORIZON. Your risk prosecution MUST address that horizon specifically:

  INTRADAY RISK (if horizon = INTRADAY):
    → Execution risk: spread, slippage, gap risk at open/close.
    → VIX at ${vix} — high vol means stop-hunts are common intraday.
    → Momentum fades: news-driven gaps often reverse 60%+ by EOD.
    → Concentration risk: using 1 of 3 day trades on a marginal setup.
    → Primary question: Is this catalyst durable for 6+ hours?

  SWING RISK (if horizon = SWING):
    → Holding overnight exposes to gap risk, earnings surprises, macro prints.
    → VIX at ${vix} — swing positions face multi-day drawdowns before recovering.
    → Catalyst decay: does the news driver still matter in 5 days?
    → Sector rotation could reverse the move before the target is hit.
    → Primary question: Is the entry tight enough to survive 3 bad days?

  LONG RISK (if horizon = LONG):
    → Congressional buys are NOT guaranteed alpha — members lose money too.
    → Policy catalysts can take 6-18 months to materialize. Can we hold through pain?
    → Opportunity cost: capital locked in a LONG cannot respond to better setups.
    → Macro regime risk: rate changes, recession risk, or geopolitical shock.
    → Fundamental deterioration: is the underlying business sound, or is it a policy bet?
    → Primary question: What is the maximum drawdown we'd tolerate, and is our sizing right?

═══════════════════════════════════════════════════
DIRECTIVE 2 — THE PROSECUTOR
═══════════════════════════════════════════════════
  - Assume every rally is a trap. Every thesis has a fatal flaw.
  - Your job is to find the ONE reason this trade should be REJECTED or DELAYED.
  - Concentrate on a SINGLE primary risk — the one that, if it hits, ends the trade.
  - Do not scatter fire. One kill shot is more persuasive than five speculative risks.

═══════════════════════════════════════════════════
DIRECTIVE 3 — STRUCTURAL COUNTERS
═══════════════════════════════════════════════════
  - If Phi cites "Congressional Cluster Buy" → cite "Policy risk: the bill may not pass, or contracts awarded to competitors"
  - If Phi cites "News Catalyst" → cite "Liquidity risk and news fade — price already baked in"
  - If Phi cites "RSI Breakout" → cite "Divergence and overbought exhaustion — breakouts fail 40% of the time"
  - If Phi cites "Momentum" → cite "Momentum reversal: high VIX environments punish late entries"
  - If Phi cites "Contracts/Earnings" → cite "Execution risk: delivery delays, guidance cuts, or consensus disappointment"

═══════════════════════════════════════════════════
DIRECTIVE 4 — PORTFOLIO CONTEXT
═══════════════════════════════════════════════════
  - If portfolio is already heavy in this sector → flag OVEREXPOSURE as primary risk.
  - VIX at ${vix}: apply 2x normal margin of safety. Name the stop-loss level explicitly.
  - Demand position sizing proportional to conviction AND horizon — LONGs get wider stops.

OUTPUT: Cold, calculated Bear Thesis in 3-5 bullet points.
Lead with the SINGLE PRIMARY RISK. Support with 2-3 secondary concerns.
End with: THETA VERDICT: REJECT | WAIT | PROCEED WITH CAUTION (and your condition for each).`;

        const dataUserMsg = [
            `=== PORTFOLIO STATE ===`,
            `${userPortfolio || '(none provided)'}`,
            `Open Account Orders: ${openAccountOrders}`,
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
            return await this.complete(BearSysPrompt, fullConversation);
        } catch (err) {
            console.error('[RedLine] Theta failed to assess market data:', err.message);
            throw err;
        }
    }
}
