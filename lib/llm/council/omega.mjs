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

        const gregReview    = loadGregorReview();
        const sizingContext = buildGregorSizingContext(gregReview);

        // Pre-compute modifier-adjusted sizing so Gregor never has to do the math.
        // LLM arithmetic on "apply -30%" is unreliable and produces near-zero notionals.
        const bh = gregReview?.byHorizon || {};
        const getModifier = (horizon) => {
            const wr = bh[horizon]?.winRate;
            if (wr == null) return 1.0;
            if (wr >= 0.65) return 1.15;
            if (wr < 0.40)  return 0.70;
            return 1.0;
        };
        const MIN_NOTIONAL = 5.00; // never go below $5 regardless of modifier
        const swingBase    = Math.min(buyingPower * 0.08, totalValue * 0.07);
        const longBase     = Math.min(buyingPower * 0.12, totalValue * 0.10);
        const intradayLow  = buyingPower * 0.03;
        const swingAdj     = Math.max(swingBase  * getModifier('SWING'),  MIN_NOTIONAL);
        const longAdj      = Math.max(longBase   * getModifier('LONG'),   MIN_NOTIONAL);
        const intradayAdj  = Math.max(intradayLow * getModifier('INTRADAY'), MIN_NOTIONAL);

        const GregorSysPrompt = `Gregor — Final decision authority. Synthesize Phi/Theta into one executable order.
Session: ${marketStatus} | PDT left: ${remainingTrades}/3 | Portfolio: ${portfolio}
Open orders: ${openAccountOrders} | Fills 24h: ${orders24h}

HORIZON RULES
INTRADAY: order_type=Market, tif=Day, session=REGULAR. PDT=0 → FORBIDDEN.
SWING:    order_type=Limit@S1, tif=Day|GTC. Overnight hold, PDT irrelevant. Stop=S1−0.5×ATR.
LONG:     order_type=Limit@S1, tif=GTC, session=REGULAR. Stop=S2 or S1−1×ATR. Congressional cluster → +20% size.
EXTENDED: Limit+GTC+EXTENDED only. No notional_value — compute units from price.

LIMIT PRICE LAW: BUY limit ≤ market (target S1). SELL limit ≥ market (target R1). Never reversed.

ENTRY TIMING (BUY): gap=price−S1.
  gap<0.5×ATR → Day@S1. gap 0.5–1.5×ATR → GTC@S1. gap>1.5×ATR → shade to price−0.3×ATR or WAIT.
  Momentum↓ → Day@S1. Flat → GTC@S1+0.3×ATR. Momentum↑ → Day@price−0.3×ATR or WAIT.
  Pre-10:30ET: Day@S1. 10:30–14:30: GTC@S1+0.2×ATR. >14:30: GTC.
  Pre-catalyst (<5d away): Day urgency, binary risk → size conservatively.
  Post-catalyst: wait for pullback to S1, not current spike.

EXIT TIMING (SELL): gap=R1−price.
  gap<0.5×ATR → Day@R1. gap 0.5–1.5×ATR → GTC@R1. gap>1.5×ATR → GTC@price+0.5×ATR.
  Momentum↑ → GTC@R1. Flat → GTC@R1−0.3×ATR. Momentum↓ → Day@price+0.2×ATR.

SIZING (pre-computed, modifiers baked in — use as-is):
  BP=$${buyingPower.toFixed(2)} | TV=$${totalValue.toFixed(2)} | Reserve=$${(buyingPower*0.10).toFixed(2)}
  INTRADAY=$${intradayAdj.toFixed(2)} | SWING=$${swingAdj.toFixed(2)} | LONG=$${longAdj.toFixed(2)} | LONG+Cluster=$${(longAdj*1.20).toFixed(2)}
  Floor=$${MIN_NOTIONAL.toFixed(2)}. units = notional ÷ limit_price, round down to 0.01.

STOP-LOSS (mandatory every BUY): LONG=S2|S1−ATR. SWING=S1−0.5×ATR. INTRADAY=entry−ATR.
  No S1/S2 data → halve sizing, state "STOP: undefined."

PORTFOLIO RULES: sector>40% → no new adds. BP>30% TV → deploy. Rotation: SELL array first.
OPEN POSITIONS: 0-2→≥4pts | 3-4→≥6pts | 5+→≥8pts or rotation only.
OPEN ORDERS: ticker with ACCEPTED/WORKING order → WAIT.

THETA OVERRIDE: Quote Theta's primary risk. Give a specific concrete counter — not "bull case wins."
  BAD: "outweighs Theta's concerns." GOOD: "Theta flagged X. Counter: Y. Stop at $Z."
  No concrete counter → output WAIT.

HUMAN ERROR: Name the most tempting mistake on this trade and how you avoid it.
  (spike-buy, premature exit, panic-sell at S1, no stop, oversizing)

OUTPUT FORMAT:
TARGET: TICKER | Horizon: INTRADAY|SWING|LONG
Logic:
  Bull: [catalyst + price level]
  Catalyst: [pre/post-catalyst, timeline, range: bull=$X base=$Y floor=$Z]
  Human Error: [mistake + avoidance]
  Theta: [quoted concern] | Counter: [specific rebuttal or WAIT]
  Entry/Exit: [gap=$ Yx ATR, momentum, fill window, limit=$Z reason]
  Stop: [$level anchored to S1/S2/ATR]
  PDT: [trades left, consumes one?]
  Sizing: [tier, notional, units calc]
  Conviction: [one sentence]
VERDICT: JSON array only, nothing after ]
[{"symbol":"...","action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":N|null,"units":N|null,"notional_value":N|null,"trading_session":"REGULAR"|"EXTENDED"}]`;

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
