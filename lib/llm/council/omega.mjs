/**
 * omega.mjs — Gregor, Master Macro Decider
 *
 * FALLBACK CHAIN (in order, all free-tier):
 *  1. SambaNova   — Meta-Llama-3.3-70B-Instruct  (20 RPM)
 *  2. Cerebras    — llama-3.3-70b-instruct        (30 RPM / 1M TPD)
 *  3. NVIDIA NIM  — meta/llama-3.3-70b-instruct   (40 RPM)
 *  4. OpenRouter  — deepseek/deepseek-r1:free      (20 RPM / 200 RPD, reasoning model)
 *  5. Anthropic   — claude-sonnet-4-6              (absolute last resort, user has premium)
 *
 * HeyPuter removed — was returning undefined and blocking execution.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AnthropicProvider } from '../anthropic.mjs';
import { callProvider, isRateLimit } from './utils/providers.mjs';
import { DataCleaner } from './utils/cleaner.mjs';

const _gregorDir      = dirname(fileURLToPath(import.meta.url));
const _gregLastReview = join(_gregorDir, '../../../runs/lastReview.json');

function loadGregorReview() {
    if (!existsSync(_gregLastReview)) return null;
    try { return JSON.parse(readFileSync(_gregLastReview, 'utf8')); }
    catch { return null; }
}

function buildGregorSizingContext(review) {
    if (!review) return null;
    const pct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'N/A';
    const bh  = review.byHorizon || {};
    const bs  = review.bySignal  || {};

    const lines = [
        `=== PERFORMANCE CONTEXT (from review: ${review.generatedAt?.slice(0, 10) || 'unknown'}) ===`,
        `Win Rate: ${pct(review.winRate)} | Profit Factor: ${review.profitFactor === 999 ? '∞' : review.profitFactor?.toFixed(2)} | ${review.resolved} resolved decisions`,
        ``,
        `SIZING MODIFIERS (apply to POSITION SIZING FORMULA):`,
    ];

    for (const [h, s] of Object.entries(bh)) {
        if (s.winRate >= 0.65)      lines.push(`  ${h}: Win rate ${pct(s.winRate)} — apply +15% to standard ${h} sizing.`);
        else if (s.winRate < 0.40)  lines.push(`  ${h}: Win rate ${pct(s.winRate)} — apply -30% to standard ${h} sizing. Reduce conviction.`);
    }

    const clusterWr = bs.congressionalCluster?.winRate;
    if (clusterWr != null && (bs.congressionalCluster?.decisions || 0) >= 3) {
        if (clusterWr >= 0.70)      lines.push(`  Congressional Cluster: ${pct(clusterWr)} win rate — apply +20% sizing when cluster signal confirmed.`);
        else if (clusterWr < 0.50)  lines.push(`  Congressional Cluster: ${pct(clusterWr)} win rate — size at minimum tier until rate recovers.`);
    }

    const highVixWr = bs.highVix?.winRate;
    if (highVixWr != null && highVixWr < 0.45 && (bs.highVix?.decisions || 0) >= 3) {
        lines.push(`  High-VIX: ${pct(highVixWr)} win rate — reduce sizing to minimum tier on VIX ≥ 25 setups.`);
    }

    if (review.recommendations?.length) {
        lines.push(``, `Priority council directive: ${review.recommendations[0]}`);
    }

    return lines.join('\n');
}

// ── Strip reasoning tags and return clean text ────────────────────────────────
// debate.mjs._extractVerdict() handles JSON parsing — omega must return a STRING.
// Returning a parsed object here causes [object Object] in the debate log.
function cleanResponse(raw) {
    if (!raw) return '';
    // Remove DeepSeek R1 / Qwen3 thinking blocks
    return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export class GregorLLM extends AnthropicProvider {
    constructor(config) {
        // Pass Anthropic fallback creds to super so this.complete() routes to Anthropic
        super({ apiKey: config.fallback?.apiKey || null, model: config.fallback?.model || 'claude-sonnet-4-6' });
        this.name = 'gregor';

        // Free-tier provider pool (passed from crucix.config providers block)
        this.sambanova  = config.providers?.sambanova  || null;
        this.cerebras   = config.providers?.cerebras   || null;
        this.nvidia     = config.providers?.nvidia     || null;
        this.openrouter = config.providers?.openrouter || null;
    }

    // ── Core decision call — chains all free providers before Anthropic ───────
    async _callChain(systemPrompt, userMessage) {
        console.log('[GREGOR] Thinking...');

        const messages = [
            { role: 'system', content: systemPrompt },
            ...(Array.isArray(userMessage)
                ? userMessage
                : [{ role: 'user', content: String(userMessage) }])
        ];
        if (!messages.some(m => m.role === 'user')) {
            messages.push({ role: 'user', content: 'Please review the briefing and issue your verdict.' });
        }

        const opts = { temperature: 0.1, maxTokens: 4096 };

        // ── Tier 1: SambaNova ─────────────────────────────────────────────────
        if (this.sambanova?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 1 — SambaNova (${this.sambanova.model})`);
                const raw = await callProvider(this.sambanova.baseUrl, this.sambanova.apiKey, this.sambanova.model, messages, opts);
                console.log('[GREGOR] ✓ SambaNova');
                return cleanResponse(raw);
            } catch (err) {
                console.warn(`[GREGOR] ⚠ SambaNova failed: ${err.message}`);
                if (!isRateLimit(err.message)) throw err;
            }
        } else {
            console.warn('[GREGOR] SAMBANOVA_API_KEY not set — skipping tier 1');
        }

        // ── Tier 2: Cerebras ──────────────────────────────────────────────────
        if (this.cerebras?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 2 — Cerebras (${this.cerebras.model})`);
                const raw = await callProvider(this.cerebras.baseUrl, this.cerebras.apiKey, this.cerebras.model, messages, opts);
                console.log('[GREGOR] ✓ Cerebras');
                return cleanResponse(raw);
            } catch (err) {
                console.warn(`[GREGOR] ⚠ Cerebras failed: ${err.message}`);
                if (!isRateLimit(err.message)) throw err;
            }
        } else {
            console.warn('[GREGOR] CEREBRAS_API_KEY not set — skipping tier 2');
        }

        // ── Tier 3: NVIDIA NIM ────────────────────────────────────────────────
        if (this.nvidia?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 3 — NVIDIA NIM (${this.nvidia.model})`);
                const raw = await callProvider(this.nvidia.baseUrl, this.nvidia.apiKey, this.nvidia.model, messages, opts);
                console.log('[GREGOR] ✓ NVIDIA NIM');
                return cleanResponse(raw);
            } catch (err) {
                console.warn(`[GREGOR] ⚠ NVIDIA NIM failed: ${err.message}`);
                if (!isRateLimit(err.message)) throw err;
            }
        } else {
            console.warn('[GREGOR] NVIDIA_API_KEY not set — skipping tier 3');
        }

        // ── Tier 4: OpenRouter DeepSeek R1 (reasoning model — great for JSON) ─
        if (this.openrouter?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 4 — OpenRouter (${this.openrouter.model})`);
                const raw = await callProvider(this.openrouter.baseUrl, this.openrouter.apiKey, this.openrouter.model, messages, opts);
                console.log('[GREGOR] ✓ OpenRouter');
                return cleanResponse(raw);
            } catch (err) {
                console.warn(`[GREGOR] ⚠ OpenRouter failed: ${err.message}`);
                if (!isRateLimit(err.message)) throw err;
            }
        } else {
            console.warn('[GREGOR] OPENROUTER_API_KEY not set — skipping tier 4');
        }

        // ── Tier 5: Anthropic (premium account — absolute last resort) ────────
        console.warn('[GREGOR] All free tiers exhausted — falling back to Anthropic...');
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await this.complete(systemPrompt, userMessage, { maxTokens: 4096, temperature: 0.1 });
                console.log('[GREGOR] ✓ Anthropic');
                return cleanResponse(res?.text ?? res);
            } catch (err) {
                const is429 = isRateLimit(err.message);
                if (is429 && attempt < 3) {
                    console.warn(`[GREGOR] Anthropic 429 (attempt ${attempt}/3) — waiting 30s...`);
                    await new Promise(r => setTimeout(r, 30000));
                } else {
                    throw err;
                }
            }
        }
    }

    async assessInfo(sysPrompts, conversation, buyingPowerRaw, totalValueRaw, orders24h, vix = 'N/A', openAccountOrders, GetPortfolio, remainingTrades) {
        // Sanitize to real numbers — hallucination prevention: never let "undefined" or null reach the prompt
        const buyingPower = parseFloat(buyingPowerRaw) || 0;
        const totalValue  = parseFloat(totalValueRaw)  || 0;
        const now          = new Date();
        const estString    = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
        const estDate      = new Date(estString);
        const currentTimeValue = estDate.getHours() * 100 + estDate.getMinutes();
        const isRegularHours   = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus     = isRegularHours ? 'REGULAR_MARKET_OPEN' : 'EXTENDED_HOURS_RESTRICTED';

        const port      = await GetPortfolio();
        const portfolio = DataCleaner.stringifyPortfolio(port);

        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider & Strategic Commander.
Mission: Synthesize Phi's alpha case and Theta's risk prosecution into the FINAL EXECUTABLE COMMAND.
You are not just executing today's trade — you are stewarding a portfolio with a strategic vision.
Every decision must reflect HORIZON AWARENESS: Intraday, Swing, or Long. Each has different rules.

═══════════════════════════════════════════════════
SECTION 1 — HORIZON-BASED EXECUTION RULES
═══════════════════════════════════════════════════
The Scout has classified the opportunity with a HORIZON. Your verdict MUST respect it:

  INTRADAY (same-day):
    → "time_in_force": "Day" | "trading_session": "REGULAR" only.
    → PDT STRICTLY applies. If Remaining Trades = 0: FORBIDDEN. Pivot to WAIT.
    → Prefer "order_type": "Market" for speed (REGULAR hours only).
    → Smaller size: do NOT overcommit to a same-day trade.

  SWING (2-10 days):
    → "time_in_force": "Day" or "GTC" depending on urgency.
    → PDT does NOT apply to the HOLD — this is an overnight position.
    → Use "order_type": "Limit" for precision entry. Set price near current ask or support.
    → If EXTENDED hours: MUST use "order_type": "Limit" + "trading_session": "EXTENDED".
    → Medium size: 5-10% portfolio allocation typical.

  LONG (weeks/months):
    → "time_in_force": "GTC" — order stays open until filled at your target price.
    → PDT is IRRELEVANT for the hold. This is a position, not a trade.
    → ALWAYS "order_type": "Limit". Set price at a key support or consolidation zone.
    → "trading_session": "REGULAR" preferred (better fills, tighter spreads).
    → Size: 8-15% allocation. If congressional cluster confirmed → lean toward larger.
    → Congressional Cluster Buys: treat as structural signal. These members are positioning
      AHEAD of policy moves. Gregor gives extra weight to multi-member accumulation.

═══════════════════════════════════════════════════
SECTION 2 — STRATEGIC PORTFOLIO MANAGEMENT
═══════════════════════════════════════════════════
Before issuing a verdict, assess the portfolio strategically:
  Portfolio: ${portfolio}
  Buying Power: ${buyingPower} | Total Value: [from context]

  STRATEGIC RULES:
  a) CONCENTRATION CHECK: If one sector > 40% of portfolio → no new adds to that sector.
  b) LONG POSITION MANAGEMENT: Review existing LONGs. If thesis broken (stock -15%+ below entry
     with no catalyst change), consider SELL even if no day-trade triggered it.
  c) CASH DEPLOYMENT: If Buying Power > 30% of total value → capital is idle. LONG/SWING buys
     are especially justified. Idle cash is a drag.
  d) ROTATION DISCIPLINE: When rotating, ALWAYS execute SELL before BUY (output as array, SELL first).

═══════════════════════════════════════════════════
SECTION 3 — PDT SAFETY PROTOCOL (CRITICAL)
═══════════════════════════════════════════════════
  Remaining Day Trades: ${remainingTrades}/3
  Verified Fills (24h): ${orders24h}

  IF ${remainingTrades} === 0:
    - FORBIDDEN from executing a Round Trip (BUY + SELL same ticker same day).
    - Check Verified Fills. Ticker bought today = LOCKED (cannot sell). Ticker sold today = LOCKED (cannot buy back).
    - SWING or LONG entries are PERMITTED (buy today, hold overnight+).
    - This is an opportunity: force a higher-quality SWING/LONG entry instead of gambling an INTRADAY.

  IF ${remainingTrades} > 0:
    - INTRADAY permitted. Still prefer SWING/LONG if the signal warrants it.
    - Don't burn day trades on marginal INTRADAY setups when a cleaner SWING is available.

═══════════════════════════════════════════════════
SECTION 4 — OPEN ORDER DEFENSE
═══════════════════════════════════════════════════
  Scan: ${openAccountOrders}
  - If target ticker already has "ACCEPTED" or "WORKING" order → output "action": "WAIT". Prevents duplicate fills.
  - If a LONG GTC order has been sitting unfilled for >3 days → consider revising price in the Logic section (flag for user).

═══════════════════════════════════════════════════
SECTION 5 — EXECUTION MECHANICS
═══════════════════════════════════════════════════
  Market Status: ${marketStatus}

  EXTENDED HOURS (pre/post market):
    - MUST use "order_type": "Limit", "time_in_force": "GTC", "trading_session": "EXTENDED".
    - NO "notional_value" for Limit orders — calculate "units" from price.
    - Wide spreads in extended hours — set limit price conservatively (ask + $0.10 for buys).

  REGULAR HOURS:
    - INTRADAY/urgent: "order_type": "Market", "time_in_force": "Day" permitted.
    - SWING/LONG: "order_type": "Limit" preferred. Better fills.
    - "notional_value" allowed ONLY for Market orders (no "units" needed).

  LIMIT ORDER PRICE RULES (CRITICAL — violations create unfillable orders):
    BUY  Limit → price MUST be ≤ current market price. You are bidding to buy at a discount.
                 Set at S1 from candle data, or current price if no S1 is available.
                 NEVER set a BUY limit ABOVE market — it will fill immediately at market (use Market order)
                 or worse, sit as an overpay limit that executes at a worse price.
    SELL Limit → price MUST be ≥ current market price. You are asking to sell at a premium.
                 Set at R1 from candle data. NEVER set a SELL limit BELOW market.
    Market order → no "price" field needed. Use for INTRADAY urgency in REGULAR hours only.

  STOP-LOSS REQUIREMENT:
    Every BUY verdict MUST include a stop-loss level in the Logic section.
    For LONG:  stop = S2 if available, else S1 - (1 × ATR). State the dollar level explicitly.
    For SWING: stop = S1 - (0.5 × ATR). State the dollar level explicitly.
    For INTRADAY: stop = entry - ATR. State the dollar level explicitly.
    If S1/S2 data is missing from technical data: state "STOP: undefined — position size reduced 50%"
    and halve the normal sizing tier for that horizon.

  POSITION SIZING (pre-computed — use these exact dollar amounts, do not recalculate):
    Buying Power: $${buyingPower.toFixed(2)} | Total Value: $${totalValue.toFixed(2)} | Reserve floor: $${(buyingPower * 0.10).toFixed(2)} (10% — never go below)
    - INTRADAY : $${(buyingPower * 0.03).toFixed(2)} – $${(buyingPower * 0.05).toFixed(2)}
    - SWING    : $${Math.min(buyingPower * 0.08, totalValue * 0.07).toFixed(2)}
    - LONG     : $${Math.min(buyingPower * 0.12, totalValue * 0.10).toFixed(2)}
    - Congressional Cluster → scale LONG by +20%: $${(Math.min(buyingPower * 0.12, totalValue * 0.10) * 1.20).toFixed(2)}
    Use S1 from candle data as the BUY limit price. Use R1 as the SELL limit price.

═══════════════════════════════════════════════════
SECTION 6 — OPEN POSITION CAP
═══════════════════════════════════════════════════
  OPEN POSITIONS RIGHT NOW: (see portfolio above)
  0-2 open → standard threshold ≥ 4 pts
  3-4 open → elevated threshold ≥ 6 pts or rotation SELL only
  5+ open  → CONSOLIDATION MODE — ≥ 8 pts or rotation only

MANDATORY OUTPUT FORMAT:
TARGET: [TICKER]
Horizon: [INTRADAY | SWING | LONG]
Logic:
  Bull Case: Cite the actual catalyst, price level, or data point that makes this entry valid.
  Bear Response: Address Theta's SPECIFIC concern by name — do not summarize generically.
  Stop-Loss: State the exact dollar stop level and which support (S1/S2/ATR) it is anchored to.
             If no support data: "STOP: undefined — sizing halved per missing-data rule."
  PDT Check: State day trades remaining and whether this verdict consumes one.
  Portfolio: Buying power utilization, sector concentration, cash idle status.
  Sizing: Which formula tier applies, the exact notional, and how units were calculated from price.
  Limit Price: Confirm BUY price ≤ market (targeting S1) or SELL price ≥ market (targeting R1).
  Conviction: Single sentence — the decisive reason this verdict is correct.
VERDICT: JSON_ARRAY_ONLY_NO_OTHER_TEXT
[{"symbol":"TICKER","action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER_OR_NULL,"notional_value":NUMBER_OR_NULL,"trading_session":"REGULAR"|"EXTENDED"}]
// Nothing after the closing ].`;

        const gregReview    = loadGregorReview();
        const sizingContext = buildGregorSizingContext(gregReview);

        const dataUserMsg = [
            `=== ACCOUNT STATE ===`,
            `Buying Power: $${buyingPower.toFixed(2)} USD`,
            `Total Value:  $${totalValue.toFixed(2)} USD`,
            `Live VIX:     ${vix}`,
            `Remaining Day Trades: ${remainingTrades}/3`,
            ``,
            `=== VERIFIED FILLS (LAST 24H) ===`,
            `${orders24h || '(no recent orders)'}`,
            ``,
            `=== PORTFOLIO & OPEN ORDERS ===`,
            `Current Holdings: ${portfolio}`,
            `Pending Orders: ${openAccountOrders || 'NONE'}`,
            ``,
            ...(sizingContext ? [`${sizingContext}`, ``] : []),
            `=== SCOUT & COUNCIL INPUT ===`,
            `${sysPrompts}`,
            ``,
            `=== FINAL INSTRUCTION ===`,
            `If Remaining Trades is 0, ensure the VERDICT does not create a same-day round trip.`,
        ].join('\n');

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            const result = await this._callChain(GregorSysPrompt, fullConversation);
            return result;
        } catch (err) {
            console.error('[RedLine] Gregor total failure — all providers exhausted:', err.message);
            throw err;
        }
    }
}
