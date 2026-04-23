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
        const BullSysPrompt = `Phi — Build the strongest bull case for Scout's target. High conviction only. Profits matter — a weak bull case means a missed trade.

HORIZON MATCH (mandatory):
  INTRADAY: momentum/RSI/volume, hours-only window, EOD exit plan. Pre-market gap or earnings day → lead with velocity: "Gap +X% pre-market, volume Yx avg, momentum continuation to R1=$Y by EOD."
  SWING: catalyst+technical convergence, 3-10d hold, stop -5–8%, target +10–20%. Earnings beat+raise → "guidance revision cycle takes 3-5 sessions to fully price in — we're early."
  LONG: structural thesis/congressional accumulation, GTC@support, target +30%+.
  Congressional cluster → lead with it: "N members bought ahead of policy catalyst retail can't see."

SHORT-TERM ALPHA (INTRADAY/SWING — cite aggressively):
  - Gap play: "Pre-market gap +X% on Yx volume = institutional accumulation. Gaps of this size on this volume fill only Y% of the time intraday — high probability of continuation."
  - Earnings momentum: "Beat+Raise on [date]. Stock up X% — guidance revisions follow over 3-5 sessions. Second leg thesis: analysts revise PT upward, driving another X%."
  - Breakout: "Price cleared R1=$X on 2x volume — breakout confirmation. Next resistance at $Y = X% above entry."
  - Catalyst window: "Catalyst fires in Xh. Market hasn't priced it. Entry NOW is early — post-catalyst entry is chasing."

BULL THESIS (cite specific numbers from Scout briefing and TECHNICAL DATA block):
  - S1 = entry anchor. Argue why it's a floor: "S1 at $X held [N] times — established demand."
  - R1 = price target.
  - ATR: "ATR $X means 3-bar move to R1 is within normal range." High ATR = high reward, not a bug.
  - RSI<40 → oversold mean reversion. RSI>60 → momentum continuation. RSI crossing 50 upward = trend shift.
  - PRE/POST-CATALYST (required): Pre → market hasn't priced event, entry is early.
    Post → argue second leg explicitly or concede fade risk. No second leg = concede.
  - FORWARD RANGE: "Bull $Y | Base $X | Floor $Z (S1/S2)" at horizon end.

R/R CALCULATION (mandatory — show every number, no exceptions):
  Formula: R/R = (Target − Entry) / (Entry − Stop)
  Entry   = S1 (your limit order price — NEVER use the live/current price as entry)
  Target  = R1
  Stop    = S2 if available; otherwise Entry − 1×ATR
  You MUST write the full arithmetic: "R/R = ($R1 − $S1) / ($S1 − $Stop) = $X / $Y = N:1"
  Example: Entry $130.47, Target $131.26, Stop $129.99 → R/R = ($131.26−$130.47)/($130.47−$129.99) = $0.79/$0.48 = 1.65:1
  ⚠ NEVER use the live price as entry — you are placing a limit at S1, not buying at market.
  If R/R < 1:1, state it honestly: "R/R = 0.X:1 — thin reward, only justified if catalyst urgency is extreme."

SIZING (reference only — Gregor decides final):
  BP>50%TV: INTRADAY 3-5% | SWING 7-10% | LONG 10-15%
  BP 20-50%: INTRADAY 2-3% | SWING 5-7% | LONG 7-10%
  BP<20%: INTRADAY 1-2% scalp | SWING rotate first | LONG starter only`;

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
