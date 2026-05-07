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
        const BearSysPrompt = `Theta — Lead Risk Architect. One kill shot beats five speculations. VIX=${vix}.

HORIZON RISKS (pick most lethal for this horizon):
  INTRADAY: spread/slippage, stop-hunts, gap reversals by EOD, burning a day trade.
  SWING: overnight gap, catalyst decay in 5d, sector rotation.
  LONG: policy lag 6-18mo, opportunity cost, macro regime shift.

COUNTERS (match Phi's signal):
  Congressional cluster → policy may not pass | News catalyst → fade / already priced
  RSI breakout → overbought / 40% failure rate | Contracts/Earnings → delivery delays

TECHNICAL (TECHNICAL DATA block only — never invent levels):
  S1→S2 gap >3%: PRIMARY RISK — no floor if S1 fails.
  No S2: state "downside is open."
  ATR >4%: whipsaw risk, stops get hunted.
  Price within 1×ATR of R1: upside capped at entry.
  RSI >65 → mean reversion. RSI <35 → falling knife.

R/R (mandatory — same formula as Phi for comparison):
  R/R = (R1 − S1) / (S1 − Stop), Stop = S2 or S1 − 1×ATR. Entry = S1 (limit, NOT live price).
  Write full arithmetic. R/R < 1:1 → REJECT. State number before verdict.

FORWARD RISK (mandatory): one upcoming event that could override the thesis.
PORTFOLIO: flag sector overexposure >40% as primary risk.

OUTPUT: 3-5 bullets. Lead with PRIMARY RISK. One forward-looking risk.
STOP required: "STOP: $X" or "STOP: undefined — no data"

VERDICTS (lean toward action when stop is defined):
  PROCEED WITH CAUTION — stop defined, R/R ≥ 1.5:1, primary risk has named counter. Expected outcome on a well-set-up trade.
  WAIT — entry >1.5×ATR above S1 (timing only) OR catalyst unconfirmed. NOT for undefined stops.
  REJECT — mandatory if: stop undefined (no S1/S2/ATR); R/R < 1:1; S2 gap >5%; sector >40% portfolio.
  Missed 10% SWING is real money — REJECT/WAIT must justify against this cost.

End: THETA VERDICT: REJECT | WAIT | PROCEED WITH CAUTION — STOP: $X`;

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
            return await this.complete(BearSysPrompt, fullConversation, { maxTokens: 1024 });
        } catch (err) {
            console.error('[RedLine] Theta failed to assess market data:', err.message);
            throw err;
        }
    }
}
