// analyst.mjs — The single Claude agent (replaces the Scout/Phi/Theta/Gregor council).
//
// Each sweep it reviews the enriched Crucix data + the live portfolio and emits AT MOST ONE
// trade proposal — NEW_BUY or MAINTENANCE — for the user to Accept/Deny, or NO_ACTION. It does
// NOT execute; execution happens only on Accept (server.mjs). The old council's intelligence
// (forward-pacing funnel, dislocation/earned-discount, R/R + sizing, PDT rules, exit logic) is
// distilled into this one prompt.
//
// Reuses the provider.complete(system, user, {maxTokens}) → {text, usage} + fenced-JSON parse
// pattern from lib/llm/thesis.mjs, and compactSweepForLLM from lib/llm/ideas.mjs.

import { compactSweepForLLM } from './ideas.mjs';
import { DataCleaner } from './council/utils/cleaner.mjs';

const SYSTEM_PROMPT = `You are the sole trading analyst for a personal portfolio. Each cycle you review live market
intelligence + the user's portfolio and produce AT MOST ONE actionable proposal for the user to Accept or Deny.
You do NOT execute — you recommend. Quality over quantity: most cycles should be NO_ACTION.

PRIORITY ORDER (stop at the first that applies):
 1. URGENT MAINTENANCE — a held position needs action NOW (thesis broken, stop level breached, take profit on a
    big winner, or trim overexposure). Propose MAINTENANCE (usually side SELL).
 2. NEW_BUY — the single highest-conviction new entry. Reason top-down:
    STEP 0 FORWARD-PACE: is a HIGH/MED-inevitability megatrend's unpriced rung setting up now? (see THESES)
    STEP 1 CATALYST: policy / congressional / geopolitical — what changed? (see the digest)
    STEP 2 SECTOR → STEP 3 STOCK: prefer the second-order / under-owned beneficiary, confirmed by technicals.
    A sharp sell-off is a BUY only if it's an EARNED discount (oversold + below 200MA + intact thesis) — a big
    drop alone is often a falling knife.
 3. NO_ACTION — nothing clears the bar this cycle.

RULES:
 - R/R must be ≥ 1.5:1 for SWING, ≥ 2:1 for LONG. State the entry/target/stop logic in desc.
 - Respect PDT: if DAY_TRADES_REMAINING is 0, only SWING/LONG (overnight) — no intraday round-trips.
 - Never propose a ticker that already has an open account order, or one already covered by a PENDING proposal.
 - Sizing: scale to buying power; when data is thin, size at the minimum.
 - Fractional units require time_in_force "Day"; whole units may use "GTC".
 - horizon: INTRADAY | SWING | LONG — sets the stop-loss band the system enforces automatically.
 - stopLoss: REQUIRED for every NEW_BUY — a concrete price. The system enforces this as a HARD stop
   that auto-sells WITHOUT approval if breached, so place it where the thesis is truly invalidated
   (below structural support), not arbitrarily. It must be below the entry for a BUY.
 - title: ≤ 8 words. desc: 2-4 sentences — the thesis, the R/R, and the ONE risk. Plain English, no jargon dump.
 - expiresInMinutes: how long the offer stays valid (30-120 for intraday/swing catalysts, up to 480 for structural).
 - confidence: an integer 0-100 — your conviction in this specific trade (higher = stronger edge/setup). Be honest; reserve 85+ for high-conviction, well-confirmed setups.

Output ONLY one valid JSON object (no prose, no markdown fence):
{"action":"NEW_BUY|MAINTENANCE|NO_ACTION","title":"","desc":"","ticker":"","side":"BUY|SELL","order_type":"Limit|Market","price":0,"units":0,"notional_value":null,"time_in_force":"Day|GTC","horizon":"INTRADAY|SWING|LONG","stopLoss":0,"confidence":75,"expiresInMinutes":60}
For NO_ACTION, only {"action":"NO_ACTION","desc":"<one line why>"} is required.`;

/** Build the analyst's user-context string from the enriched sweep + account state. */
export function buildAnalystContext(currentData, portfolio, openOrders, buyingPower, remaining, priorPending = [], allowedHorizons = ['INTRADAY', 'SWING', 'LONG'], budget = null) {
  let sweep = '';
  try { sweep = compactSweepForLLM(currentData, currentData.delta || null, currentData.ideas || []); }
  catch { sweep = ''; }

  const theses = (currentData.theses || []).slice(0, 4)
    .map(t => `${t.trend} (${t.inevitability}) → bottleneck: ${t.chain?.bottleneck || '?'} → rung: ${(t.targetTickers || []).join(', ')}`)
    .join('\n  ');

  const portStr = DataCleaner.stringifyPortfolio(portfolio) || 'No active holdings.';
  const ordStr  = DataCleaner.stringifyOpenOrders(openOrders) || 'NONE';
  const pending = priorPending.length
    ? priorPending.map(p => `${p.ticker}[${p.action}] (expires ${p.expiresAt})`).join(' | ')
    : 'none';

  return [
    `=== MARKET INTELLIGENCE ===`,
    sweep || '(no sweep digest)',
    theses ? `\n=== FORWARD-PACING THESES ===\n  ${theses}` : '',
    `\n=== PORTFOLIO ===\n${portStr}`,
    `\n=== OPEN ACCOUNT ORDERS ===\n${ordStr}`,
    `\n=== ACCOUNT ===\nBuying Power: $${buyingPower ?? '?'} | Day Trades Remaining: ${remaining}/3`,
    `\n=== ALLOWED INVESTMENT HORIZONS (user setting) ===\nA NEW_BUY may ONLY use one of: ${allowedHorizons.join(', ')}. If the best idea is outside these horizons, output NO_ACTION. (MAINTENANCE of existing positions is always allowed.)`,
    (budget && budget.dailyCap > 0)
      ? `\n=== DAILY NEW-BUY BUDGET ===\n${budget.buysToday}/${budget.dailyCap} new buys already surfaced today; ${budget.buysLeft} left. Overtrading destroys returns — only propose a NEW_BUY if it is clearly among the best you'd expect all day. When the budget is low or spent, hold out for A+ setups and prefer NO_ACTION. (MAINTENANCE is never budget-limited.)`
      : '',
    `\n=== ALREADY-PENDING PROPOSALS (do NOT repeat these tickers) ===\n${pending}`,
  ].filter(Boolean).join('\n');
}

// Normalize confidence to an integer 0-100. Accepts a raw number (0-100 or a 0-1 fraction)
// or a legacy HIGH/MEDIUM/LOW word. Defaults to 60 when missing/unparseable.
function normalizeConfidence(raw) {
  if (typeof raw === 'string') {
    const w = raw.trim().toUpperCase();
    if (w === 'HIGH') return 85;
    if (w === 'MEDIUM') return 60;
    if (w === 'LOW') return 35;
  }
  let n = Number(raw);
  if (!Number.isFinite(n)) return 60;
  if (n > 0 && n <= 1) n *= 100;            // 0-1 fraction → percent
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseProposal(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let obj;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { obj = JSON.parse(m[0]); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const action = String(obj.action || '').toUpperCase();
  if (action === 'NO_ACTION') return { action: 'NO_ACTION', desc: String(obj.desc || '').slice(0, 200) };
  if (action !== 'NEW_BUY' && action !== 'MAINTENANCE') return null;

  const ticker = String(obj.ticker || '').toUpperCase().trim();
  if (!/^[A-Z]{1,5}$/.test(ticker)) return null;
  const side = String(obj.side || '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  return {
    action,
    title:        String(obj.title || `${side} ${ticker}`).slice(0, 80),
    desc:         String(obj.desc || '').slice(0, 600),
    ticker,
    side,
    order_type:   ['Limit', 'Market'].includes(obj.order_type) ? obj.order_type : 'Limit',
    price:        Number.isFinite(obj.price) && obj.price > 0 ? obj.price : null,
    units:        Number.isFinite(obj.units) && obj.units > 0 ? obj.units : null,
    notional_value: Number.isFinite(obj.notional_value) && obj.notional_value > 0 ? obj.notional_value : null,
    time_in_force: ['Day', 'GTC'].includes(obj.time_in_force) ? obj.time_in_force : 'Day',
    horizon:      ['INTRADAY', 'SWING', 'LONG'].includes(String(obj.horizon || '').toUpperCase()) ? String(obj.horizon).toUpperCase() : 'SWING',
    // Hard stop price — only kept for BUYs and only if below entry (a stop above entry is nonsensical).
    stopLoss:     (action === 'NEW_BUY' && side === 'BUY' && Number.isFinite(obj.stopLoss) && obj.stopLoss > 0
                    && (!Number.isFinite(obj.price) || obj.stopLoss < obj.price)) ? obj.stopLoss : null,
    // Numeric conviction 0-100. Accepts a raw number or a legacy HIGH/MEDIUM/LOW word.
    confidence:   normalizeConfidence(obj.confidence),
    expiresInMinutes: Number.isFinite(obj.expiresInMinutes) && obj.expiresInMinutes > 0 ? obj.expiresInMinutes : 60,
  };
}

/**
 * Generate at most one proposal. Returns the parsed proposal object (incl. NO_ACTION) or null on failure.
 */
export async function generateProposal(provider, currentData, portfolio, openOrders, buyingPower, remaining, priorPending = [], fallbackProvider = null, allowedHorizons = ['INTRADAY', 'SWING', 'LONG'], budget = null) {
  if (!provider?.isConfigured) return null;
  const context = buildAnalystContext(currentData, portfolio, openOrders, buyingPower, remaining, priorPending, allowedHorizons, budget);
  console.log(`[Analyst] Reviewing sweep (~${Math.round(context.length / 4)} tok) → ${provider.name || 'agent'}/${provider.model}`);

  try {
    const res = await provider.complete(SYSTEM_PROMPT, context, { maxTokens: 900, timeout: 60000, temperature: 0.3 });
    const p = parseProposal(res.text);
    if (p) return p;
    console.warn('[Analyst] Primary returned no parseable proposal — trying fallback.');
  } catch (err) {
    console.warn(`[Analyst] Primary failed: ${err.message} — trying fallback.`);
  }

  if (fallbackProvider?.isConfigured) {
    try {
      const res = await fallbackProvider.complete(SYSTEM_PROMPT, context, { maxTokens: 900, timeout: 45000 });
      const p = parseProposal(res.text);
      if (p) return p;
    } catch (err) {
      console.error(`[Analyst] Fallback also failed: ${err.message}`);
    }
  }
  return null;
}
