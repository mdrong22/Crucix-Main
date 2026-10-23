// moratorium.mjs — after a stop-loss, put the ticker on a cooldown ("moratorium") and log the failed
// thesis. Two jobs:
//   1. Prevent immediate re-entry into a name that just stopped you out (revenge/churn buys into a
//      falling knife) — new buys on it are blocked until the cooldown expires.
//   2. Build a failure record the agent reads each cycle, so a thesis that just failed informs the next
//      decision instead of being silently repeated.
// Persisted to runs/moratoriums.json. Cooldown default MORATORIUM_HOURS (48h); expired entries auto-prune.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR  = join(__dirname, '../../runs');
const PATH      = join(RUNS_DIR, 'moratoriums.json');
const DEFAULT_HOURS = (() => { const h = parseFloat(process.env.MORATORIUM_HOURS ?? '48'); return Number.isFinite(h) && h >= 0 ? h : 48; })();

function load() { try { return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}; } catch { return {}; } }
function save(m) {
  try { if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true }); writeFileSync(PATH, JSON.stringify(m, null, 2), 'utf8'); }
  catch (e) { console.warn('[Moratorium] save failed:', e.message); }
}

/**
 * Put a ticker on a post-stop cooldown and log why it failed.
 * @param {string} ticker
 * @param {object} [o] { reason, thesis, pnlPct (percent), hours }
 */
export function addMoratorium(ticker, o = {}) {
  const t = String(ticker || '').toUpperCase().trim();
  if (!/^[A-Z]{1,5}$/.test(t)) return null;
  if ((o.hours ?? DEFAULT_HOURS) <= 0) return null; // disabled
  const m = load();
  const now = Date.now();
  m[t] = {
    ticker:    t,
    reason:    String(o.reason || 'stop-loss hit').slice(0, 200),
    thesis:    String(o.thesis || '').slice(0, 240),
    pnlPct:    Number.isFinite(o.pnlPct) ? Number(o.pnlPct) : null,
    createdAt: new Date(now).toISOString(),
    until:     new Date(now + (o.hours ?? DEFAULT_HOURS) * 3600 * 1000).toISOString(),
  };
  save(m);
  console.log(`[Moratorium] 🚫 ${t} on cooldown until ${m[t].until} — ${m[t].reason}${m[t].pnlPct != null ? ` (${m[t].pnlPct.toFixed(1)}%)` : ''}`);
  return m[t];
}

/** Active (non-expired) moratoriums, pruning expired ones on read. */
export function getActiveMoratoriums() {
  const m = load();
  const now = Date.now();
  let changed = false;
  for (const [t, e] of Object.entries(m)) {
    if (!e.until || new Date(e.until).getTime() <= now) { delete m[t]; changed = true; }
  }
  if (changed) save(m);
  return Object.values(m);
}

export function isUnderMoratorium(ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  return getActiveMoratoriums().some(e => e.ticker === t);
}
export function getMoratorium(ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  return getActiveMoratoriums().find(e => e.ticker === t) || null;
}
/** Allow the user to lift a cooldown early. */
export function clearMoratorium(ticker) {
  const t = String(ticker || '').toUpperCase().trim();
  const m = load();
  if (!m[t]) return false;
  delete m[t]; save(m); return true;
}

/** Compact one-line digest for the agent context. */
export function formatMoratoriumsForLLM() {
  const list = getActiveMoratoriums();
  if (!list.length) return '';
  return list.slice(0, 10).map(e => {
    const pl    = e.pnlPct != null ? ` (${e.pnlPct >= 0 ? '+' : ''}${e.pnlPct.toFixed(1)}%)` : '';
    const until = e.until ? e.until.slice(5, 16).replace('T', ' ') : '?';
    return `${e.ticker}${pl} — stopped out: ${e.reason}; no re-entry until ${until}`;
  }).join(' | ');
}
