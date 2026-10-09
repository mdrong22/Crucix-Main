/**
 * circuitBreaker.mjs — Account-level deterministic risk breaker.
 *
 * Independent of the LLM: if the account is down more than maxDailyLossPct on the ET day, OR more
 * than maxDrawdownPct from its tracked peak, NEW_BUY proposals are halted (maintenance/exits still
 * run, and the hard stop-loss watcher is untouched). This is the "survives > looks profitable"
 * safety net — a loss limit the model can never argue its way past.
 *
 * It does NOT auto-flatten positions (that's the stop-loss watcher's job); it only pauses new risk.
 *
 * State persisted to runs/breaker.json: { etDay, dayStartValue, peakValue, lastAlertDay }.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR  = join(__dirname, '../../runs');
const PATH      = join(RUNS_DIR, 'breaker.json');

function ensureDir() { if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true }); }
function etDay() { return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' }); }

function load() {
  ensureDir();
  if (!existsSync(PATH)) return {};
  try { return JSON.parse(readFileSync(PATH, 'utf8')) || {}; }
  catch { return {}; }
}
function save(state) {
  ensureDir();
  try { writeFileSync(PATH, JSON.stringify(state, null, 2), 'utf8'); } catch (e) { console.error('[Breaker] save failed:', e.message); }
}

/**
 * Update tracked day-start / peak values from the live account value and evaluate the breaker.
 * @param {number} accountValue  current total account value ($)
 * @param {object} settings      { maxDailyLossPct, maxDrawdownPct }  (percent, 0 = disabled)
 * @returns {{tripped, reasons, dailyLossPct, drawdownPct, dayStartValue, peakValue, justTripped, accountValue}}
 */
export function evaluateBreaker(accountValue, settings = {}) {
  const maxDaily = Number(settings.maxDailyLossPct) || 0;
  const maxDD    = Number(settings.maxDrawdownPct) || 0;
  const v = Number(accountValue);
  const state = load();
  const today = etDay();

  // Can't evaluate without a real account value — pass through, don't trip.
  if (!Number.isFinite(v) || v <= 0) {
    return { tripped: false, reasons: [], dailyLossPct: 0, drawdownPct: 0, dayStartValue: state.dayStartValue ?? null, peakValue: state.peakValue ?? null, justTripped: false, accountValue: v };
  }

  // New ET day → reset the day's starting value.
  if (state.etDay !== today) { state.etDay = today; state.dayStartValue = v; }
  if (state.dayStartValue == null || state.dayStartValue <= 0) state.dayStartValue = v;
  // Peak is a running all-time high of account value.
  state.peakValue = Math.max(Number(state.peakValue) || 0, v);

  const dailyLossPct = state.dayStartValue > 0 ? ((state.dayStartValue - v) / state.dayStartValue) * 100 : 0;
  const drawdownPct  = state.peakValue > 0 ? ((state.peakValue - v) / state.peakValue) * 100 : 0;

  const reasons = [];
  if (maxDaily > 0 && dailyLossPct >= maxDaily) reasons.push(`daily loss ${dailyLossPct.toFixed(1)}% ≥ ${maxDaily}%`);
  if (maxDD > 0 && drawdownPct >= maxDD)        reasons.push(`drawdown ${drawdownPct.toFixed(1)}% ≥ ${maxDD}%`);
  const tripped = reasons.length > 0;

  // Alert only once per ET day when it first trips.
  const justTripped = tripped && state.lastAlertDay !== today;
  if (justTripped) state.lastAlertDay = today;

  save(state);
  return {
    tripped, reasons,
    dailyLossPct, drawdownPct,
    dayStartValue: state.dayStartValue, peakValue: state.peakValue,
    justTripped, accountValue: v,
  };
}

/** Read the last persisted state without mutating it (for status display). */
export function getBreakerState() { return load(); }
