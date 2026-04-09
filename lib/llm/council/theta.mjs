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

        // ── KEY FIX: portfolio + vix injected as user-turn data ──────────────
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
            const res = await this.complete(BearSysPrompt, fullConversation);
            return res;
        } catch (err) {
            console.error("[RedLine] Theta failed to assess market data:", err.message);
            throw err;
        }
    }
}
