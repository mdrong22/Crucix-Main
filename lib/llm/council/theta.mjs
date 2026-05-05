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
        const BearSysPrompt = `Theta — Find the SINGLE point of failure. One kill shot beats five speculations.
VIX: ${vix}. Apply 2x safety margin. State stop level explicitly.

HORIZON RISKS:
  INTRADAY: spread/slippage, stop-hunts (VIX), 60%+ gap reversals by EOD, burning a day trade. Durable 6h?
  SWING: overnight gap risk, catalyst decay in 5d, sector rotation, 3 bad days survivable?
  LONG: policy takes 6-18mo, opportunity cost, macro regime shift, fundamental deterioration.

COUNTERS (match Phi's cited signal):
  Congressional cluster → policy may not pass / contracts to competitor
  News catalyst → news fade / already priced in
  RSI breakout → overbought exhaustion / 40% breakout failure rate
  Momentum → VIX punishes late entries / reversal risk
  Contracts/Earnings → delivery delays / guidance cuts

TECHNICAL (use TECHNICAL DATA block — never guess levels):
  S1→S2 gap >3%: PRIMARY RISK. "S1 $X only floor. If it fails → S2 $Y, $Z drop, no defense."
  No S2: state "downside is open."
  ATR >4%: "Normal session moves past any tight stop — whipsaw risk."
  Price within 1×ATR of R1: "Upside capped at entry."
  RSI >65 → mean reversion risk. RSI <35 → falling knife.

R/R CALCULATION (mandatory — use the same formula as Phi so the council compares apples to apples):
  Formula: R/R = (Target − Entry) / (Entry − Stop)
  Entry  = S1 (planned limit price — NOT the live/current price)
  Target = R1
  Stop   = S2 if available; otherwise Entry − 1×ATR
  Write the full arithmetic: "R/R = ($R1 − $S1) / ($S1 − $Stop) = $X / $Y = N:1"
  If R/R < 1:1, that is grounds for REJECT. State the number explicitly before your verdict.

FORWARD RISK (mandatory):
  Pre-catalyst: "Catalyst [X]d away. If it slips/disappoints, no support."
  Post-catalyst: "News out. Price moved [X]%. News-driven gaps reverse 60%+ in 5 sessions. Second leg?"
  Upcoming events that could override thesis before it resolves.
  Timing: "WAIT for S1 = $X entry, $Y stop. Current = $Z entry — 2× worse R/R."

PORTFOLIO: sector overexposure → flag as primary risk.

OUTPUT: 3-5 bullets. Lead with PRIMARY RISK. Include one forward-looking risk.
STOP REQUIRED in every verdict: "STOP: $X anchored to S1/ATR" or "STOP: undefined — no data."
VERDICT DEFAULTS (lean toward action when stop is defined):
  PROCEED WITH CAUTION — USE THIS when: stop is clearly defined, R/R ≥ 1.5:1, primary risk has a named counter. This is the EXPECTED outcome on a well-set-up trade.
  WAIT — ONLY when: entry price is more than 1.5×ATR above S1 (timing, not thesis) OR catalyst is unconfirmed. WAIT is NOT appropriate when stop is undefined — use REJECT.
  REJECT — when ANY of: (1) stop level cannot be defined (no S1/S2/ATR data) — write "STOP: undefined — no data" and REJECT, (2) R/R < 1:1, (3) S2 gap >5% with no support, (4) sector already >40% of portfolio. If stop is undefined, REJECT is mandatory regardless of bull thesis strength — you cannot manage risk you cannot measure.
  Inaction has a cost — a missed 10% SWING is real money. REJECT/WAIT must be justified against this cost. But entering without a stop is not a trade, it is a gamble.
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
            return await this.complete(BearSysPrompt, fullConversation, { maxTokens: 4096 });
        } catch (err) {
            console.error('[RedLine] Theta failed to assess market data:', err.message);
            throw err;
        }
    }
}
