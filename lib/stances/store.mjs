/**
 * store.mjs — Per-Ticker Stance Book (the agent's "living plan")
 *
 * The Analyst is otherwise stateless: it re-decides from scratch each sweep. This store gives it
 * continuity of REASONING (not of obligation). For each stock it cares about, it keeps a short,
 * revisable stance — what it thinks and what would make it act — and rewrites it every sweep.
 *
 *   SLV → WATCH · "silver squeeze, real rates rolling over"
 *          plan: "accumulate on a pullback < $30; abort if it loses $27"
 *
 * Because the plan is overwritten against fresh data each cycle, there is NO anchoring: a stale
 * plan gets replaced, never blindly executed. A stance is a reminder to re-check, not a standing order.
 *
 * Output: runs/stances.json (keyed by ticker; full current book, closed stances pruned).
 *
 * Stance vocabulary: WATCH | ACCUMULATE | HOLD | TRIM | EXIT | AVOID
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR    = join(__dirname, '../../runs');
const STORE_PATH  = join(RUNS_DIR, 'stances.json');

// How many non-held tickers the book may track (held positions are ALWAYS kept, uncapped).
const MAX_WATCH   = parseInt(process.env.STANCE_MAX_WATCH || '10', 10);
// A stance not touched in this many days is considered rotten and pruned.
const STALE_DAYS  = parseInt(process.env.STANCE_STALE_DAYS || '5', 10);

const VALID_STANCES = ['WATCH', 'ACCUMULATE', 'HOLD', 'TRIM', 'EXIT', 'AVOID'];

function ensureDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Load the raw book as an object keyed by ticker. */
export function loadStances() {
  ensureDir();
  if (!existsSync(STORE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    console.error('[Stances] Failed to parse stances.json:', e.message);
    return {};
  }
}

function save(book) {
  ensureDir();
  writeFileSync(STORE_PATH, JSON.stringify(book, null, 2), 'utf8');
}

/** Current book as a sorted array (held first, then most-recently-updated). */
export function getStances() {
  const book = loadStances();
  return Object.values(book).sort((a, b) => {
    if (!!b.held !== !!a.held) return (b.held ? 1 : 0) - (a.held ? 1 : 0);
    return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0);
  });
}

function normalizeStance(word) {
  const w = String(word || '').toUpperCase().trim();
  return VALID_STANCES.includes(w) ? w : null;
}

// Confidence → integer 0-100; a 0-1 fraction is scaled up. null if unparseable.
function normalizeConf(raw) {
  let n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) n *= 100;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Apply the agent's stance updates for this sweep. Each update:
 *   { ticker, stance, thesis, plan, confidence, close? }
 * `close: true` (or stance EXIT that the caller no longer holds) removes the entry.
 * Silently ignores malformed rows. Returns the updated book array.
 *
 * @param {Array} updates  stanceUpdates[] emitted by the analyst
 * @param {string[]} heldTickers  current portfolio tickers — always retained + flagged held
 */
export function applyStanceUpdates(updates = [], heldTickers = []) {
  const book = loadStances();
  const now  = new Date().toISOString();
  const held = new Set((heldTickers || []).map(t => String(t).toUpperCase()));

  for (const u of Array.isArray(updates) ? updates : []) {
    const ticker = String(u?.ticker || '').toUpperCase().trim();
    if (!/^[A-Z]{1,5}$/.test(ticker)) continue;
    if (u?.close === true) { delete book[ticker]; continue; }
    const stance = normalizeStance(u?.stance);
    if (!stance) continue;
    const prev = book[ticker] || {};
    book[ticker] = {
      ticker,
      stance,
      thesis:     String(u.thesis || prev.thesis || '').slice(0, 240),
      plan:       String(u.plan   || prev.plan   || '').slice(0, 240),
      confidence: normalizeConf(u.confidence) ?? (prev.confidence ?? null),
      held:       held.has(ticker),
      openedAt:   prev.openedAt || now,
      updatedAt:  now,
    };
  }

  reconcile(book, held);
  save(book);
  return getStances();
}

/**
 * Housekeeping run every sweep regardless of updates:
 *  - flag/unflag `held` from the live portfolio,
 *  - prune stale non-held stances (untouched > STALE_DAYS),
 *  - cap the number of non-held (WATCH-list) stances to MAX_WATCH (drop the oldest).
 * Held positions are never pruned — you always keep a stance on what you own.
 */
export function reconcile(book = null, heldSet = null) {
  const b = book || loadStances();
  const held = heldSet || new Set();
  const now  = Date.now();
  const staleMs = STALE_DAYS * 24 * 60 * 60 * 1000;
  const external = book === null; // called standalone → we must persist

  for (const [t, s] of Object.entries(b)) {
    s.held = held.has(t);
    if (!s.held && s.updatedAt && (now - new Date(s.updatedAt).getTime() > staleMs)) delete b[t];
  }

  // Cap the watch-list (non-held) portion.
  const watch = Object.values(b).filter(s => !s.held)
    .sort((a, c) => new Date(a.updatedAt || 0) - new Date(c.updatedAt || 0)); // oldest first
  const overflow = watch.length - MAX_WATCH;
  for (let i = 0; i < overflow; i++) delete b[watch[i].ticker];

  if (external) save(b);
  return b;
}

/** Compact one-line-per-ticker digest for the analyst context (token-lean). */
export function formatStancesForLLM() {
  const list = getStances();
  if (!list.length) return 'none yet';
  return list.map(s => {
    const c = s.confidence != null ? ` ${s.confidence}%` : '';
    const flag = s.held ? '★' : ' ';
    const plan = s.plan ? ` — plan: ${s.plan}` : '';
    return `${flag}${s.ticker} [${s.stance}${c}] ${s.thesis}${plan}`;
  }).join('\n  ');
}
