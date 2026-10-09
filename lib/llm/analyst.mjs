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

const SYSTEM_PROMPT = `Sole trading analyst for one personal portfolio. Each cycle, review the context and emit AT MOST ONE proposal to Accept/Deny. You recommend, never execute. Quality over quantity — most cycles are NO_ACTION.

THINK FIRST (fill "reasoning" before deciding):
 - What changed; which thesis/signal it maps to; the base rate (how often this setup works + typical move); whether YOUR TRACK RECORD says this trade type pays off for you. Reason in probabilities.
 - "bearCase": the single strongest reason you're wrong + what would invalidate it. If it beats the bull case → NO_ACTION.
 - Let TRACK RECORD override instinct: downweight losing horizons/signals, lean into winners, fix flagged leaks (e.g. cutting winners short).

PRIORITY (stop at first that applies):
 1. URGENT MAINTENANCE — a held position needs action now (thesis broken, stop breached, take profit on a big winner, trim overexposure) → MAINTENANCE, usually SELL.
 2. NEW_BUY — the single highest-conviction entry, top-down: forward-pace a HIGH/MED-inevitability megatrend's unpriced rung (see THESES) → catalyst (policy/congress/geo) → sector → the second-order/under-owned stock, confirmed by technicals. A sell-off is a BUY only if it's an EARNED discount (oversold + below 200MA + intact thesis); a big drop alone is a falling knife.
 3. NO_ACTION.

RULES:
 - R/R ≥ 1.5:1 SWING, ≥ 2:1 LONG; state entry/target/stop in desc.
 - PDT: if DAY_TRADES_REMAINING=0, only SWING/LONG (no intraday round-trips).
 - Never propose a ticker with an open account order or a PENDING proposal.
 - Size to buying power; thin data → minimum size. Fractional units → time_in_force "Day"; whole → "GTC".
 - SMALL SIZE IS FINE: with thin buying power, deploy what you have as a small/fractional position when a setup is strong — do NOT dismiss a good setup just because the dollar size is small. A small, high-conviction flip beats sitting in cash. Prefer quick INTRADAY/SWING setups you can flip for a gain when capital is limited, so it can be redeployed. R/R and stop rules still apply; never force a trade without a real edge.
 - horizon = holding window + system-enforced risk band (pick the one that matches your actual plan, and set stopLoss consistent with it):
    • INTRADAY: close the same day. ~-2% hard stop, starts trailing at +1%; auto-converts to SWING if down at EOD. Needs DAY_TRADES_REMAINING > 0.
    • SWING: hold days to weeks (auto-reviewed ~10d). ~-5% hard stop, trails from +3%. R/R ≥ 1.5:1.
    • LONG: hold weeks to months (auto-reviewed ~30d). ~-12% hard stop, trails from +8%. R/R ≥ 2:1.
 - stopLoss REQUIRED for every NEW_BUY: a concrete price below entry, placed where the thesis is invalidated (structural support). Enforced as a HARD stop that auto-sells without approval.
 - title ≤ 8 words. desc 2-4 sentences: thesis, R/R, the ONE risk. Plain English.
 - expiresInMinutes: 30-120 for intraday/swing catalysts, up to 480 structural.
 - confidence 0-100 (honest; 85+ only for high-conviction confirmed setups).
 - sources: 1-2 short strings quoting the SPECIFIC signal that drove this (e.g. "CONGRESS_CLUSTER_BUYS: NVDA (4 members)"), never generic. Required for NEW_BUY/MAINTENANCE.

STANCE BOOK (your cross-cycle memory, see "YOUR STANCE BOOK" in context): emit "stanceUpdates" — stances to create/revise this cycle. stance = WATCH|ACCUMULATE|HOLD|TRIM|EXIT|AVOID. thesis = one line why; plan = concrete ENTRY trigger ("buy <$30"); exit = WHEN TO SELL — take-profit target + what invalidates the thesis ("sell $42 target or thesis-break <$27"); confidence 0-100; close:true drops a dead thesis. This is a plan, not an order — to trade you must ALSO emit the proposal. Only touch stocks whose view changed; held positions stay tracked automatically. EXCEPTION: every stance must have an exit — if the book shows a stance with "exit: ⚠ MISSING", add a sensible one this cycle (via a stanceUpdate that keeps its current stance/thesis) even if nothing else changed.

Output ONE JSON object, no prose/fence, "reasoning" first:
{"reasoning":"","bearCase":"","action":"NEW_BUY|MAINTENANCE|NO_ACTION","title":"","desc":"","ticker":"","side":"BUY|SELL","order_type":"Limit|Market","price":0,"units":0,"notional_value":null,"time_in_force":"Day|GTC","horizon":"INTRADAY|SWING|LONG","stopLoss":0,"confidence":75,"expiresInMinutes":60,"sources":[""],"stanceUpdates":[{"ticker":"","stance":"WATCH","thesis":"","plan":"","exit":"","confidence":0,"close":false}]}
NO_ACTION needs only: {"reasoning":"","action":"NO_ACTION","desc":"","stanceUpdates":[]}`;

// Strategy-mode modifiers — tune the base philosophy toward the user's chosen aggression.
// Risk discipline (hard stop, real edge, R/R floors) is NEVER waived; these shift the bar for ACTING.
const STRATEGY_MODIFIERS = {
  CONSERVATIVE: 'CONSERVATIVE — capital preservation first. Only A+ setups: confidence ≥ 80, R/R ≥ 2:1, confirmed by multiple signals. Bias heavily toward NO_ACTION; size small; favor SWING/LONG over intraday. When in doubt, pass.',
  BALANCED:     'BALANCED — follow the base rules as written: quality over quantity, act on clearly strong setups, most cycles NO_ACTION.',
  AGGRESSIVE:   'AGGRESSIVE — prioritize capturing profit. Lower the bar to ACT: take strong setups at moderate conviction (≥ 60), accept slightly tighter R/R (≥ 1.3:1), and chase CONFIRMED momentum rather than waiting for a perfect entry. Use more of your buying power on your best idea. A real edge and a hard stop are still required — do not force trades with no edge.',
  SCALPER:      'SCALPER — hunt quick, high-probability flips. Favor INTRADAY/SWING on liquid movers with a defined small risk; take profit fast and redeploy. Tighter targets, quicker exits, more frequent proposals. Avoid LONG unless exceptional. Edge + hard stop still required.',
};

/**
 * AUTO strategy selector — picks a concrete mode from current market conditions.
 *   High fear (VIX ≥ 27) → CONSERVATIVE (protect capital in turbulence)
 *   Calm + risk-on (VIX ≤ 16 & risk-on) → AGGRESSIVE (press when conditions favor it)
 *   Heavy dislocation (≥ 8 big movers) without systemic fear → SCALPER (flip the churn)
 *   Otherwise → BALANCED
 */
export function resolveAutoStrategy({ vix = null, direction = null, moverCount = 0 } = {}) {
  if (vix != null && vix >= 27) return 'CONSERVATIVE';
  if (vix != null && vix <= 16 && direction === 'risk-on') return 'AGGRESSIVE';
  if (moverCount >= 8 && (vix == null || vix < 25)) return 'SCALPER';
  return 'BALANCED';
}

/** Build the analyst's user-context string from the enriched sweep + account state. */
export function buildAnalystContext(currentData, portfolio, openOrders, buyingPower, remaining, priorPending = [], allowedHorizons = ['INTRADAY', 'SWING', 'LONG'], budget = null, stanceDigest = 'none yet', trackRecord = 'no track record yet', directives = 'none') {
  let sweep = '';
  try { sweep = compactSweepForLLM(currentData, currentData.delta || null, currentData.ideas || []); }
  catch { sweep = ''; }
  // Analyst-only trim: drop raw-OSINT detection counts that don't map to a specific trade and are
  // already distilled into the THESES below. (The free ideas/thesis pass still sees the full digest.)
  if (sweep) sweep = sweep.split('\n').filter(l => !/^(THERMAL|AIR_ACTIVITY):/.test(l)).join('\n');

  const theses = (currentData.theses || []).slice(0, 4)
    .map(t => `${t.trend} (${t.inevitability}) → bottleneck: ${t.chain?.bottleneck || '?'} → rung: ${(t.targetTickers || []).join(', ')}`)
    .join('\n  ');

  const portStr = DataCleaner.stringifyPortfolio(portfolio) || 'No active holdings.';
  const ordStr  = DataCleaner.stringifyOpenOrders(openOrders) || 'NONE';
  // Ticker + action is all the agent needs to avoid re-proposing an open offer; the exact
  // expiry timestamp is dead weight in the prompt.
  const pending = priorPending.length
    ? priorPending.map(p => `${p.ticker}[${p.action}]`).join(' | ')
    : 'none';

  const mode = (budget && STRATEGY_MODIFIERS[budget.strategyMode]) ? budget.strategyMode : 'BALANCED';
  const modeLabel = (budget && budget.strategyAuto) ? `${mode} (AUTO-selected from current market conditions)` : mode;

  return [
    `=== STRATEGY MODE: ${modeLabel} (tune your bar for ACTING; risk discipline stays) ===\n${STRATEGY_MODIFIERS[mode]}`,
    `\n=== MARKET INTELLIGENCE ===`,
    sweep || '(no sweep digest)',
    theses ? `\n=== FORWARD-PACING THESES ===\n  ${theses}` : '',
    `\n=== PORTFOLIO ===\n${portStr}`,
    `\n=== OPEN ACCOUNT ORDERS ===\n${ordStr}`,
    `\n=== ACCOUNT ===\nBuying Power: $${buyingPower ?? '?'} | Day Trades Remaining: ${remaining}/3`,
    (budget && budget.bpBelowFloor)
      ? `\n=== BUYING-POWER FLOOR (user setting) ===\nBuying power is BELOW the user's $${budget.minBuyingPower} floor. Do NOT propose a NEW_BUY — output NO_ACTION or a MAINTENANCE action only. (Managing existing positions is always allowed.)`
      : (budget && budget.minBuyingPower > 0)
        ? `\n=== BUYING-POWER FLOOR (user setting) ===\nUser's minimum is $${budget.minBuyingPower}; stay above it — a NEW_BUY must leave buying power at or above this floor.`
        : '',
    `\n=== ALLOWED INVESTMENT HORIZONS (user setting) ===\nA NEW_BUY may ONLY use one of: ${allowedHorizons.join(', ')}. If the best idea is outside these horizons, output NO_ACTION. (MAINTENANCE of existing positions is always allowed.)`,
    (budget && budget.dailyCap > 0)
      ? `\n=== DAILY NEW-BUY BUDGET ===\n${budget.buysToday}/${budget.dailyCap} new buys already surfaced today; ${budget.buysLeft} left. Overtrading destroys returns — only propose a NEW_BUY if it is clearly among the best you'd expect all day. When the budget is low or spent, hold out for A+ setups and prefer NO_ACTION. (MAINTENANCE is never budget-limited.)`
      : '',
    `\n=== ALREADY-PENDING PROPOSALS (do NOT repeat these tickers) ===\n${pending}`,
    `\n=== YOUR STANCE BOOK (your plan per stock — revise via stanceUpdates; ★ = you hold it) ===\n  ${stanceDigest || 'none yet'}`,
    `\n=== YOUR TRACK RECORD (learn from it — calibrate to what has actually worked) ===\n  ${trackRecord || 'no track record yet'}`,
    (directives && directives !== 'none')
      ? `\n=== STANDING DIRECTIVES (the user's instructions — follow these when deciding) ===\n  ${directives}`
      : '',
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
  const stanceUpdates = parseStanceUpdates(obj.stanceUpdates);
  const action = String(obj.action || '').toUpperCase();
  if (action === 'NO_ACTION') return { action: 'NO_ACTION', desc: String(obj.desc || '').slice(0, 200), reasoning: String(obj.reasoning || '').slice(0, 600), stanceUpdates };
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
    sources:      parseSources(obj.sources),
    reasoning:    String(obj.reasoning || '').slice(0, 600),
    bearCase:     String(obj.bearCase || '').slice(0, 300),
    stanceUpdates,
  };
}

// Keep 1-2 short, non-empty source citations; tolerate a single string or a comma-joined list.
function parseSources(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === 'string' && raw.trim()) arr = raw.split(/\s*[|;]\s*/);
  return arr.map(s => String(s || '').trim()).filter(Boolean).slice(0, 2).map(s => s.slice(0, 120));
}

// Light-touch parse of the agent's stanceUpdates[]; the store does the strict validation.
function parseStanceUpdates(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 15).map(u => (u && typeof u === 'object') ? u : null).filter(Boolean);
}

/**
 * Generate at most one proposal. Returns the parsed proposal object (incl. NO_ACTION) or null on failure.
 */
const MAX_OUTPUT_TOKENS = 2000; // proposal + reasoning/bearCase + stanceUpdates[] — reasoning needs headroom

export async function generateProposal(provider, currentData, portfolio, openOrders, buyingPower, remaining, priorPending = [], fallbackProvider = null, allowedHorizons = ['INTRADAY', 'SWING', 'LONG'], budget = null, stanceDigest = 'none yet', trackRecord = 'no track record yet', directives = 'none') {
  if (!provider?.isConfigured) return null;
  const context = buildAnalystContext(currentData, portfolio, openOrders, buyingPower, remaining, priorPending, allowedHorizons, budget, stanceDigest, trackRecord, directives);
  console.log(`[Analyst] Reviewing sweep (~${Math.round(context.length / 4)} tok) → ${provider.name || 'agent'}/${provider.model}`);

  // Try the primary, then the fallback (Gemini). Same call, so a transient primary failure
  // (e.g. a usage-limit window) still yields a proposal.
  const chain = [provider, fallbackProvider].filter(p => p?.isConfigured);
  for (let i = 0; i < chain.length; i++) {
    const isFallback = i > 0;
    try {
      const res = await chain[i].complete(SYSTEM_PROMPT, context, {
        maxTokens: MAX_OUTPUT_TOKENS, timeout: isFallback ? 45000 : 60000, temperature: 0.3,
      });
      const p = parseProposal(res.text);
      if (p) {
        // Stamp which provider/model produced this proposal so the card + report can show it.
        p.provider = chain[i].name || 'agent';
        p.model    = res.model || chain[i].model || 'unknown';
        return p;
      }
      console.warn(`[Analyst] ${isFallback ? 'Fallback' : 'Primary'} returned no parseable proposal${isFallback ? '.' : ' — trying fallback.'}`);
    } catch (err) {
      console.warn(`[Analyst] ${isFallback ? 'Fallback' : 'Primary'} failed: ${err.message}${isFallback ? '' : ' — trying fallback.'}`);
    }
  }
  return null;
}
