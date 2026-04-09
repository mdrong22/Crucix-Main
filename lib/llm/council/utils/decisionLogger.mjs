/**
 * decisionLogger.mjs — RedLine Phase 1: Decision Persistence
 *
 * Captures every non-WAIT council verdict with full signal context at
 * the moment of decision. This is the data foundation for Phase 2
 * (positionResolver) and Phase 3 (reviewCouncil).
 *
 * Output: runs/decisions.json  — append-only log, one entry per trade
 *
 * Schema per entry: see logDecisions() jsdoc below.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR   = join(__dirname, '../../../../runs');
const LOG_PATH   = join(RUNS_DIR, 'decisions.json');

// ─── File I/O ─────────────────────────────────────────────────────────────────

function ensureRunsDir() {
  if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
}

export function loadDecisions() {
  ensureRunsDir();
  if (!existsSync(LOG_PATH)) return [];
  try {
    return JSON.parse(readFileSync(LOG_PATH, 'utf8'));
  } catch (e) {
    console.error('[DecisionLogger] Failed to parse decisions.json:', e.message);
    return [];
  }
}

function saveDecisions(entries) {
  ensureRunsDir();
  writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// ─── Signal Extraction ────────────────────────────────────────────────────────
// Parse structured fields out of Scout's output text.
// Scout's prompt guarantees these labeled lines in its output.

function extractSignals(briefingText = '', liveVix = 'N/A') {
  const text = briefingText;

  // **Horizon:** [INTRADAY | SWING | LONG] — ...
  const horizonMatch = text.match(/\*{0,2}Horizon:\*{0,2}\s*(INTRADAY|SWING|LONG)/i);
  const horizon = horizonMatch?.[1]?.toUpperCase() || 'UNKNOWN';

  // **Signal Score:** [X/10 ...]
  const scoreMatch = text.match(/\*{0,2}Signal\s*Score:\*{0,2}\s*(\d+)/i);
  const signalScore = scoreMatch ? parseInt(scoreMatch[1], 10) : null;

  // **Congressional Signal:** [Cluster | Single | None] — ...
  const conMatch = text.match(/\*{0,2}Congressional\s*Signal:\*{0,2}\s*(Cluster|Single|None)/i);
  const congressionalSignal = conMatch?.[1] || 'None';
  const congressionalCluster = congressionalSignal.toLowerCase() === 'cluster';

  // Extract any tickers mentioned on the Congressional Signal line
  const conLine = text.match(/\*{0,2}Congressional\s*Signal:\*{0,2}.*$/im)?.[0] || '';
  const conTickers = [...conLine.matchAll(/\b([A-Z]{1,5})\b/g)]
    .map(m => m[1])
    .filter(t => t !== 'CLUSTER' && t !== 'SINGLE' && t !== 'NONE' && t !== 'LONG' && t !== 'SWING');

  // **Trigger:** ...
  const triggerMatch = text.match(/\*{0,2}Trigger:\*{0,2}\s*(.+)/i);
  const trigger = triggerMatch?.[1]?.replace(/\**/g, '').trim() || null;

  // VIX — passed directly from debate context
  const vix = parseFloat(liveVix) || null;

  return {
    horizon,
    signalScore,
    congressionalCluster,
    congressionalSignal,
    congressionalTickers: conTickers,
    trigger,
    vix,
  };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Log all actionable trades from a completed council debate.
 *
 * @param {Array}  finalTrades      - Sorted trade array from debate.mjs (non-WAIT only)
 * @param {string} briefingText     - Raw Scout output text (contains Horizon, Signal Score, etc.)
 * @param {string|number} liveVix   - VIX value at decision time
 * @param {number} remainingTrades  - PDT day trades remaining at decision time
 *
 * Entry schema written to decisions.json:
 * {
 *   id:                  string   — UUID
 *   timestamp:           string   — ISO 8601 UTC
 *   ticker:              string   — primary symbol
 *   action:              string   — BUY | SELL
 *   horizon:             string   — INTRADAY | SWING | LONG | UNKNOWN
 *   orderType:           string   — Market | Limit | etc.
 *   timeInForce:         string   — DAY | GTC | etc.
 *   entryPrice:          number   — Gregor's stated price (may differ from fill)
 *   units:               number   — share count (null if notional used)
 *   notionalValue:       number   — dollar amount (null if units used)
 *   signals: {
 *     signalScore:             number   — Scout's 0-10 score
 *     congressionalCluster:    boolean
 *     congressionalSignal:     string   — Cluster | Single | None
 *     congressionalTickers:    string[]
 *     trigger:                 string   — Scout's trigger label
 *     vix:                     number
 *   }
 *   pdtRemaining:        number   — day trades left at time of decision
 *   outcome:             null     — filled by positionResolver
 *   exitPrice:           null     — filled by positionResolver
 *   exitTimestamp:       null     — filled by positionResolver
 *   pnlPct:              null     — filled by positionResolver
 *   pnlDollar:           null     — filled by positionResolver
 *   resolved:            boolean  — false until positionResolver confirms closed
 *   evaluationDue:       string   — ISO date after which forced eval occurs
 * }
 */
export function logDecisions(finalTrades, briefingText, liveVix, remainingTrades) {
  if (!Array.isArray(finalTrades) || finalTrades.length === 0) return;

  const signals = extractSignals(briefingText, liveVix);
  const existing = loadDecisions();
  const now = new Date();

  // Evaluation deadline by horizon — when positionResolver should force a read
  const horizonDays = { INTRADAY: 1, SWING: 10, LONG: 30, UNKNOWN: 10 };
  const evalDays = horizonDays[signals.horizon] ?? 10;
  const evaluationDue = new Date(now.getTime() + evalDays * 86_400_000).toISOString();

  const newEntries = finalTrades.map(trade => ({
    id:             randomUUID(),
    timestamp:      now.toISOString(),
    ticker:         trade.symbol,
    action:         trade.action,
    horizon:        signals.horizon,
    orderType:      trade.order_type || trade.orderType || null,
    timeInForce:    trade.time_in_force || trade.timeInForce || null,
    entryPrice:     trade.price ?? null,
    units:          trade.units ?? null,
    notionalValue:  trade.notional_value ?? trade.notionalValue ?? null,
    signals: {
      signalScore:           signals.signalScore,
      congressionalCluster:  signals.congressionalCluster,
      congressionalSignal:   signals.congressionalSignal,
      congressionalTickers:  signals.congressionalTickers,
      trigger:               signals.trigger,
      vix:                   signals.vix,
    },
    pdtRemaining:    remainingTrades ?? null,
    // ── Resolved by positionResolver (Phase 2) ──
    outcome:         null,   // 'win' | 'loss' | 'breakeven'
    exitPrice:       null,
    exitTimestamp:   null,
    pnlPct:          null,
    pnlDollar:       null,
    resolved:        false,
    evaluationDue,
  }));

  saveDecisions([...existing, ...newEntries]);

  for (const e of newEntries) {
    console.log(
      `[DecisionLogger] ✅ Logged: ${e.action} ${e.ticker} | ${e.horizon} | Score: ${e.signals.signalScore ?? 'N/A'} | ` +
      `${e.signals.congressionalCluster ? 'CLUSTER' : e.signals.congressionalSignal} | VIX: ${e.signals.vix ?? 'N/A'}`
    );
  }
}

/**
 * Mark an existing decision as resolved — called by positionResolver (Phase 2).
 * Matches by id and updates outcome fields in-place.
 */
export function resolveDecision(id, { outcome, exitPrice, exitTimestamp, pnlPct, pnlDollar }) {
  const entries = loadDecisions();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) {
    console.warn(`[DecisionLogger] resolveDecision: id ${id} not found`);
    return false;
  }
  entries[idx] = {
    ...entries[idx],
    outcome,
    exitPrice:     exitPrice     ?? null,
    exitTimestamp: exitTimestamp ?? new Date().toISOString(),
    pnlPct:        pnlPct        ?? null,
    pnlDollar:     pnlDollar     ?? null,
    resolved:      true,
  };
  saveDecisions(entries);
  console.log(`[DecisionLogger] Resolved ${entries[idx].ticker} (${id.slice(0, 8)}…): ${outcome} | P&L: ${pnlPct != null ? (pnlPct * 100).toFixed(2) + '%' : 'N/A'}`);
  return true;
}

/**
 * Return all unresolved entries whose evaluationDue date has passed.
 * Used by positionResolver to find stale open positions that need forced evaluation.
 */
export function getOverdueDecisions() {
  const now = Date.now();
  return loadDecisions().filter(e => !e.resolved && new Date(e.evaluationDue).getTime() <= now);
}

/**
 * Return all unresolved decisions, sorted oldest first.
 * Used by positionResolver and reviewCouncil.
 */
export function getOpenDecisions() {
  return loadDecisions()
    .filter(e => !e.resolved)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}
