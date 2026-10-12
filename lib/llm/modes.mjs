// modes.mjs — Strategy modes: the single source of truth for how the agent's "bar for acting" is tuned.
//
// A mode bundles TWO things:
//   • prompt   — a plain-English modifier injected into the analyst prompt. It tunes AGGRESSION and
//                HORIZON PREFERENCE only (the bar for ACTING). It can NEVER waive risk discipline:
//                hard stops, R/R floors, and the account circuit breaker are deterministic code in
//                server.mjs, not prompt-controlled, so no mode (built-in or custom) can remove them.
//   • horizons — optional hard constraint on which investment horizons a NEW_BUY may use.
//                null  → the mode doesn't constrain; the user's own investmentTypes apply.
//                array → the mode FORCES exactly these (e.g. Day Trader = INTRADAY/SWING, LONG off).
//
// Built-in modes live here; user-created custom modes live in settings (runs/settings.json) and are
// sanitized through sanitizeCustomMode before storage. resolveActiveMode() merges both and resolves
// AUTO against live market conditions.

export const ALL_HORIZONS = ['INTRADAY', 'SWING', 'LONG'];

// Base philosophy modifiers. Risk discipline (hard stop, real edge, R/R floors) is NEVER waived —
// these shift only the bar for ACTING.
const PROMPTS = {
  CONSERVATIVE: 'CONSERVATIVE — capital preservation first. Only A+ setups: confidence ≥ 80, R/R ≥ 2:1, confirmed by multiple signals. Bias heavily toward NO_ACTION; size small; favor SWING/LONG over intraday. When in doubt, pass.',
  BALANCED:     'BALANCED — follow the base rules as written: quality over quantity, act on clearly strong setups, most cycles NO_ACTION.',
  AGGRESSIVE:   'AGGRESSIVE — prioritize capturing profit. Lower the bar to ACT: take strong setups at moderate conviction (≥ 60), accept slightly tighter R/R (≥ 1.3:1), and chase CONFIRMED momentum rather than waiting for a perfect entry. Use more of your buying power on your best idea. A real edge and a hard stop are still required — do not force trades with no edge.',
  SCALPER:      'SCALPER — hunt quick, high-probability flips. Favor INTRADAY/SWING on liquid movers with a defined small risk; take profit fast and redeploy. Tighter targets, quicker exits, more frequent proposals. No long-term holds — intraday and short swings only. Edge + hard stop still required.',
  DAYTRADER:    'DAY TRADER — aggressively capture intraday profit with quick flips. Hunt liquid, high-volume movers with clear momentum; enter decisively, take profit fast, and redeploy capital the same session. Favor INTRADAY; allow SWING only when an intraday setup needs one extra day. NEVER hold for the long term. Tighter targets and quick exits over patience. Edge + hard stop still required — speed never waives risk discipline.',
  SWINGTRADER:  'SWING TRADER — capture multi-day to multi-week moves. Enter on confirmed setups with room to run; give the thesis days to play out rather than flipping intraday. Favor SWING; allow LONG for a strong structural thesis. Avoid intraday round-trips. R/R ≥ 1.5:1, hard stop required.',
  LONGTERM:     'LONG-TERM INVESTOR — build positions in high-inevitability megatrends and hold for weeks to months. Prioritize structural theses, earned discounts, and strong fundamentals over short-term noise. Ignore intraday churn. Favor LONG; patience over activity, most cycles NO_ACTION. R/R ≥ 2:1, hard stop required.',
};

// Built-in modes, in menu order. The first few are the "core" dials; the rest surface behind the "+".
export const BUILTIN_MODES = [
  { id: 'AUTO',         name: 'Auto',          prompt: null,               horizons: null, auto: true, core: true,
    desc: 'Picks a concrete mode each cycle from live conditions (VIX, regime, dislocation).' },
  { id: 'CONSERVATIVE', name: 'Conservative',  prompt: PROMPTS.CONSERVATIVE, horizons: null, core: true,
    desc: 'Capital preservation first — only A+ setups, bias to NO_ACTION.' },
  { id: 'BALANCED',     name: 'Balanced',      prompt: PROMPTS.BALANCED,     horizons: null, core: true,
    desc: 'The base rules as written — quality over quantity.' },
  { id: 'AGGRESSIVE',   name: 'Aggressive',    prompt: PROMPTS.AGGRESSIVE,   horizons: null, core: true,
    desc: 'Lower the bar to act; chase confirmed momentum.' },
  { id: 'SCALPER',      name: 'Scalper',       prompt: PROMPTS.SCALPER,      horizons: ['INTRADAY', 'SWING'], core: true,
    desc: 'Quick high-probability flips on liquid movers. Forces LONG off.' },
  { id: 'DAYTRADER',    name: 'Day Trader',    prompt: PROMPTS.DAYTRADER,    horizons: ['INTRADAY', 'SWING'],
    desc: 'Aggressive intraday profit + quick flips. Forces LONG off.' },
  { id: 'SWINGTRADER',  name: 'Swing Trader',  prompt: PROMPTS.SWINGTRADER,  horizons: ['SWING', 'LONG'],
    desc: 'Multi-day to multi-week moves. Forces intraday off.' },
  { id: 'LONGTERM',     name: 'Long-Term',     prompt: PROMPTS.LONGTERM,     horizons: ['LONG'],
    desc: 'Hold megatrends for weeks to months. LONG only.' },
];

export const BUILTIN_MODE_IDS = BUILTIN_MODES.map(m => m.id);
const BUILTIN_BY_ID = new Map(BUILTIN_MODES.map(m => [m.id, m]));
export const DEFAULT_MODE = BUILTIN_BY_ID.get('BALANCED');

/**
 * AUTO strategy selector — picks a concrete mode id from current market conditions.
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

/**
 * Validate + clean a user-created custom mode. Returns a safe mode object or null if unusable.
 * A custom mode is just a named prompt (+ optional horizon constraint). Risk discipline is untouchable
 * regardless of what the prompt says, because stops/R-R/breaker are enforced in code, not the prompt.
 */
export function sanitizeCustomMode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 40);
  const prompt = String(raw.prompt || '').trim().slice(0, 600);
  if (!name || !prompt) return null;
  // id: keep a provided custom id, else slug the name. Always namespaced so it can't collide with a built-in.
  let id = String(raw.id || '').trim();
  if (!/^custom:[a-z0-9-]{1,40}$/.test(id)) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mode';
    id = `custom:${slug}`;
  }
  let horizons = null;
  if (Array.isArray(raw.horizons)) {
    const cleaned = [...new Set(raw.horizons.filter(h => ALL_HORIZONS.includes(h)))];
    if (cleaned.length && cleaned.length < ALL_HORIZONS.length) horizons = cleaned; // all-3 == no constraint
  }
  return { id, name, prompt, horizons, custom: true };
}

/**
 * Resolve the active mode from settings + live market conditions.
 * @param {{strategyMode:string, customModes?:Array}} settings
 * @param {{vix?:number,direction?:string,moverCount?:number}} conditions
 * @returns {{id,name,prompt,horizons,auto,resolvedId,label}}
 */
export function resolveActiveMode(settings = {}, conditions = {}) {
  const wantId = settings.strategyMode || 'BALANCED';
  const customs = Array.isArray(settings.customModes) ? settings.customModes : [];

  // AUTO — resolve to a concrete built-in from conditions; AUTO never forces horizons.
  if (wantId === 'AUTO') {
    const resolvedId = resolveAutoStrategy(conditions);
    const concrete = BUILTIN_BY_ID.get(resolvedId) || DEFAULT_MODE;
    return { id: 'AUTO', name: 'Auto', prompt: concrete.prompt, horizons: null,
             auto: true, resolvedId, label: `${concrete.name} (Auto)` };
  }

  // Built-in
  const builtin = BUILTIN_BY_ID.get(wantId);
  if (builtin) {
    return { id: builtin.id, name: builtin.name, prompt: builtin.prompt, horizons: builtin.horizons || null,
             auto: false, resolvedId: builtin.id, label: builtin.name };
  }

  // Custom
  const custom = customs.find(m => m && m.id === wantId);
  if (custom) {
    const safe = sanitizeCustomMode(custom) || DEFAULT_MODE;
    return { id: safe.id, name: safe.name, prompt: safe.prompt, horizons: safe.horizons || null,
             auto: false, resolvedId: safe.id, label: safe.name, custom: true };
  }

  // Unknown id (e.g. a deleted custom mode) → safe default.
  return { id: DEFAULT_MODE.id, name: DEFAULT_MODE.name, prompt: DEFAULT_MODE.prompt, horizons: null,
           auto: false, resolvedId: DEFAULT_MODE.id, label: DEFAULT_MODE.name };
}
