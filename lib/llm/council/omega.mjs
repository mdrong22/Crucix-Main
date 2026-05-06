/**
 * omega.mjs — Gregor, Master Macro Decider
 *
 * FALLBACK CHAIN (in order, all free-tier):
 *  1. SambaNova   — Meta-Llama-3.3-70B-Instruct  (20 RPM)
 *  2. Groq        — llama-3.3-70b-versatile       (shared key with Phi — high throughput)
 *  3. Cerebras    — llama-3.3-70b                 (30 RPM / 1M TPD)
 *  4. NVIDIA NIM  — meta/llama-3.3-70b-instruct   (40 RPM)
 *  5. OpenRouter  — deepseek/deepseek-r1:free      (20 RPM / 200 RPD, reasoning model)
 *  6. Anthropic   — claude-sonnet-4-6              (absolute last resort, user has premium)
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
        // Groq — shared key with Phi; high throughput fallback between SambaNova and Cerebras
        this.groq = config.groq?.apiKey
            ? { apiKey: config.groq.apiKey, baseUrl: config.groq.baseUrl, model: config.groq.model || 'llama-3.3-70b-versatile' }
            : null;
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

        // ── Tier 2: Groq (high throughput — same key as Phi, no extra credentials) ─
        if (this.groq?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 2 — Groq (${this.groq.model})`);
                const raw = await callProvider(this.groq.baseUrl, this.groq.apiKey, this.groq.model, messages, opts);
                console.log('[GREGOR] ✓ Groq');
                return cleanResponse(raw);
            } catch (err) {
                console.warn(`[GREGOR] ⚠ Groq failed: ${err.message}`);
                if (!isRateLimit(err.message)) throw err;
            }
        } else {
            console.warn('[GREGOR] GROQ_API_KEY not set — skipping tier 2');
        }

        // ── Tier 3: Cerebras ──────────────────────────────────────────────────
        if (this.cerebras?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 3 — Cerebras (${this.cerebras.model})`);
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

        // ── Tier 4: NVIDIA NIM ────────────────────────────────────────────────
        if (this.nvidia?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 4 — NVIDIA NIM (${this.nvidia.model})`);
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

        // ── Tier 5: OpenRouter DeepSeek R1 (reasoning model — great for JSON) ─
        if (this.openrouter?.apiKey) {
            try {
                console.log(`[GREGOR] Tier 5 — OpenRouter (${this.openrouter.model})`);
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

        // ── Tier 6: Anthropic (premium account — absolute last resort) ────────
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

       const GregorSysPrompt = `Gregor—Final Authority. Synthesize Phi/Theta. Priority: Capital Preservation > Execution.
Session: ${marketStatus} | PDT: ${remainingTrades}/3 | Port: ${portfolio} | Open: ${openAccountOrders}
RULES: Fractional=DAY. Limit BUY ≤ market (S1). Limit SELL ≥ market (R1). 

R&R LAW: Calculate R/R = (Target-Price)/(Price-Stop). 
- R/R < 1.5: FORBIDDEN. Output WAIT + NEXT_TRIGGER. 
- NO S1/S2/ATR DATA: FORBIDDEN. Output WAIT + DATA_FETCH_REQUIRED. 
- Do NOT halve size to justify poor R/R. A bad R/R is a bad trade at any size.

ENTRY_DEBATE_SELL_FORBIDDEN:
- This debate was triggered by a BUY signal. You may NOT output a SELL verdict.
- Missing candle data → output BUY at MINIMUM tier, or WAIT if R/R is structurally unknowable.
- "Reducing exposure" by selling existing holdings is NOT a valid response to data gaps — use WAIT.
- TAKE-PROFIT lines in the candle block are reference levels for sizing math only, NOT sell orders.
- If you feel a SELL is warranted, output WAIT and note that an exit-debate should be opened separately.

HORIZON & TIMING:
- INTRADAY: Market, Day, REGULAR. PDT=0? FORBIDDEN. Stop=Price-ATR.
- SWING: Limit@S1, Day|GTC. Stop=S1-0.5*ATR.
- LONG: Limit@S1, GTC, REGULAR. Stop=S2 or S1-ATR. Cluster=+20% size.
- ENTRY: Gap=(Price-S1). Gap <0.5*ATR: Day@S1. Gap 0.5-1.5*ATR: GTC@S1. Gap >1.5*ATR: WAIT.
- MOMENTUM: ↓: Day@S1. ↑: Day@Price-0.3*ATR. Flat: GTC@S1+0.3*ATR.

SIZING: BP=$${buyingPower.toFixed(2)} | TV=$${totalValue.toFixed(2)}
- INTRA=$${intradayAdj.toFixed(2)} | SWING=$${swingAdj.toFixed(2)} | LONG=$${longAdj.toFixed(2)}
- Min=$${MIN_NOTIONAL.toFixed(2)}. Units=Notional/Limit, Floor 0.01.

THETA VETO: Theta REJECT is a Hard-Lock if based on R/R or Data Gaps.
- To override: Must provide specific quantitative rebuttal (e.g., "Theta cited R/R 1.2, but using S2 target makes it 1.8"). 
- No "Bull case wins" or "Catalyst is too strong" overrides.

PORTFOLIO: Sector >40%: NO ADD. Pos: 0-2 (>=4pt), 3-4 (>=6pt), 5+ (>=8pt/Rotation).

HUMAN ERROR: ID most tempting mistake (Spike-buy, Panic-sell, R/R-denial).

OUTPUT:
TARGET: TICKER | Horizon: [H] | R/R: [Ratio]
Logic: [Bull Case] | Catalyst: [Timeline/Range]
Error: [Mistake+Avoidance]
Theta: [Concern] | Counter: [Math-based rebuttal or WAIT]
Entry/Stop: [Limit$ reason, Stop$ anchor]
PDT/Sizing: [PDT status, Units/Notional]
Verdict: [JSON ONLY]
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
