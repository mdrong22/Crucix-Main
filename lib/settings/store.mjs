/**
 * store.mjs — Runtime user settings for the RedLine page.
 *
 * Persisted to runs/settings.json so the sweep loop and the dashboard share one source of truth.
 *
 *   autoTrade        — when true, the agent's proposals are executed IMMEDIATELY without
 *                      the Accept/Deny step (hard stop-losses always apply regardless).
 *   investmentTypes  — which horizons the agent may propose: INTRADAY | SWING | LONG.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR   = join(__dirname, '../../runs');
const PATH       = join(RUNS_DIR, 'settings.json');

const ALL_HORIZONS = ['INTRADAY', 'SWING', 'LONG'];

const DEFAULTS = {
  autoTrade: false,                                  // safe default: nothing executes without approval
  investmentTypes: ['INTRADAY', 'SWING', 'LONG'],    // all horizons allowed by default
};

function ensureDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

/** Read current settings, merged over defaults (tolerant of a missing/corrupt file). */
export function getSettings() {
  ensureDir();
  if (!existsSync(PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(PATH, 'utf8'));
    return {
      autoTrade: typeof raw.autoTrade === 'boolean' ? raw.autoTrade : DEFAULTS.autoTrade,
      investmentTypes: Array.isArray(raw.investmentTypes) && raw.investmentTypes.length
        ? raw.investmentTypes.filter(h => ALL_HORIZONS.includes(h))
        : [...DEFAULTS.investmentTypes],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Merge a partial patch and persist. Returns the new full settings. Validates/sanitizes input. */
export function updateSettings(patch = {}) {
  const cur = getSettings();
  const next = { ...cur };
  if (typeof patch.autoTrade === 'boolean') next.autoTrade = patch.autoTrade;
  if (Array.isArray(patch.investmentTypes)) {
    const cleaned = [...new Set(patch.investmentTypes.filter(h => ALL_HORIZONS.includes(h)))];
    // Never allow an empty set — that would silence the agent entirely. Fall back to all.
    next.investmentTypes = cleaned.length ? cleaned : [...ALL_HORIZONS];
  }
  ensureDir();
  writeFileSync(PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export { ALL_HORIZONS };
