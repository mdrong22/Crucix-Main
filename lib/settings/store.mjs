/**
 * store.mjs — Runtime user settings for the RedLine page.
 *
 * Persisted to runs/settings.json so the sweep loop and the dashboard share one source of truth.
 *
 *   autoTrade        — when true, the agent's proposals are executed IMMEDIATELY without
 *                      the Accept/Deny step (hard stop-losses always apply regardless).
 *   investmentTypes  — which horizons the agent may propose: INTRADAY | SWING | LONG.
 *   hideStancePlan     — UI-only: hide the Stance Book / Living Plan panel (default false = shown).
 *   hideDecisionCycle  — UI-only: hide the Decision Cycle panel (default false = shown).
 *   minBuyingPower     — agent won't propose a NEW_BUY when buying power is below this ($). 0 = no floor.
 *   strategyMode       — tunes the agent's philosophy: AUTO | CONSERVATIVE | BALANCED | AGGRESSIVE | SCALPER.
 *   maxDailyLossPct    — circuit breaker: halt NEW_BUYS if account is down this % on the ET day. 0 = off.
 *   maxDrawdownPct     — circuit breaker: halt NEW_BUYS if account is down this % from its tracked peak. 0 = off.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BUILTIN_MODE_IDS, sanitizeCustomMode } from '../llm/modes.mjs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR   = join(__dirname, '../../runs');
const PATH       = join(RUNS_DIR, 'settings.json');

const ALL_HORIZONS = ['INTRADAY', 'SWING', 'LONG'];
// Built-in strategy mode ids come from the single source of truth in lib/llm/modes.mjs; custom modes
// (stored in `customModes` below) extend the set of selectable modes at runtime.
const STRATEGY_MODES = BUILTIN_MODE_IDS;
const MAX_CUSTOM_MODES = 20;

/** Clean an array of custom-mode objects, dropping invalid ones and de-duping by id. */
function sanitizeCustomModes(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of arr) {
    const m = sanitizeCustomMode(raw);
    if (m && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    if (out.length >= MAX_CUSTOM_MODES) break;
  }
  return out;
}

const DEFAULTS = {
  autoTrade: false,                                  // safe default: nothing executes without approval
  investmentTypes: ['INTRADAY', 'SWING', 'LONG'],    // all horizons allowed by default
  hideStancePlan: false,                             // living-plan panel shown by default
  hideDecisionCycle: false,                          // decision-cycle panel shown by default
  minBuyingPower: 0,                                 // no buying-power floor by default
  strategyMode: 'BALANCED',                          // default philosophy (built-in or a custom: id)
  customModes: [],                                   // user-created modes ({id,name,prompt,horizons})
  maxDailyLossPct: 0,                                // circuit breaker off by default
  maxDrawdownPct: 0,                                 // circuit breaker off by default
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
    const customModes = sanitizeCustomModes(raw.customModes);
    // A valid strategyMode is a built-in id OR one of the stored custom modes; else fall back.
    const validModeIds = new Set([...STRATEGY_MODES, ...customModes.map(m => m.id)]);
    return {
      autoTrade: typeof raw.autoTrade === 'boolean' ? raw.autoTrade : DEFAULTS.autoTrade,
      investmentTypes: Array.isArray(raw.investmentTypes) && raw.investmentTypes.length
        ? raw.investmentTypes.filter(h => ALL_HORIZONS.includes(h))
        : [...DEFAULTS.investmentTypes],
      hideStancePlan: typeof raw.hideStancePlan === 'boolean' ? raw.hideStancePlan : DEFAULTS.hideStancePlan,
      hideDecisionCycle: typeof raw.hideDecisionCycle === 'boolean' ? raw.hideDecisionCycle : DEFAULTS.hideDecisionCycle,
      minBuyingPower: Number.isFinite(raw.minBuyingPower) && raw.minBuyingPower >= 0 ? raw.minBuyingPower : DEFAULTS.minBuyingPower,
      strategyMode: validModeIds.has(raw.strategyMode) ? raw.strategyMode : DEFAULTS.strategyMode,
      customModes,
      maxDailyLossPct: Number.isFinite(raw.maxDailyLossPct) && raw.maxDailyLossPct >= 0 ? raw.maxDailyLossPct : DEFAULTS.maxDailyLossPct,
      maxDrawdownPct: Number.isFinite(raw.maxDrawdownPct) && raw.maxDrawdownPct >= 0 ? raw.maxDrawdownPct : DEFAULTS.maxDrawdownPct,
    };
  } catch {
    return { ...DEFAULTS, customModes: [] };
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
  if (typeof patch.hideStancePlan === 'boolean') next.hideStancePlan = patch.hideStancePlan;
  if (typeof patch.hideDecisionCycle === 'boolean') next.hideDecisionCycle = patch.hideDecisionCycle;
  if (patch.minBuyingPower !== undefined) {
    const n = Number(patch.minBuyingPower);
    next.minBuyingPower = Number.isFinite(n) && n >= 0 ? n : 0;
  }
  // Process customModes BEFORE strategyMode so a mode created in the same patch can be selected.
  if (Array.isArray(patch.customModes)) next.customModes = sanitizeCustomModes(patch.customModes);
  if (typeof patch.strategyMode === 'string') {
    const validModeIds = new Set([...STRATEGY_MODES, ...next.customModes.map(m => m.id)]);
    if (validModeIds.has(patch.strategyMode)) next.strategyMode = patch.strategyMode;
  }
  for (const k of ['maxDailyLossPct', 'maxDrawdownPct']) {
    if (patch[k] !== undefined) {
      const n = Number(patch[k]);
      next[k] = Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 0;
    }
  }
  ensureDir();
  writeFileSync(PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

export { ALL_HORIZONS, STRATEGY_MODES };
