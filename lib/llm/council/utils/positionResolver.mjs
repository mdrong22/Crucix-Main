/**
 * positionResolver.mjs — RedLine Phase 2: Position Reconciliation
 *
 * Reconciles every unresolved entry in runs/decisions.json against the live
 * SnapTrade portfolio. Fills in exit prices, P&L, and resolution status so
 * Phase 3 (reviewCouncil) has meaningful statistics to compute.
 *
 * Three outcomes per unresolved decision:
 *   STILL OPEN   — position exists in portfolio → update unrealizedPnl, leave resolved: false
 *   CLOSED       — position gone from portfolio → resolve with exit price from live quote
 *   OVERDUE      — past evaluationDue AND still open → force snapshot resolve at current price
 *
 * Called by: server.mjs Review Mode trigger (once daily)
 * Reads:     runs/decisions.json  (via decisionLogger helpers)
 * Writes:    runs/decisions.json  (via resolveDecision / direct patch)
 * Requires:  snapTradeInstance with GetLiveQuote() and FetchUserTrades()
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDecisions, resolveDecision, getOpenDecisions, getOverdueDecisions } from './decisionLogger.mjs';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const DECISIONS_PATH = join(__dirname, '../../../../runs/decisions.json');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parsePct(str) {
  if (str == null) return null;
  return parseFloat(String(str).replace('%', '')) / 100;
}

function parsePrice(str) {
  if (str == null) return null;
  return parseFloat(str);
}

function calcPnl(entryPrice, exitPrice, action = 'BUY') {
  if (!entryPrice || !exitPrice) return { pnlPct: null, pnlDollar: null };
  const direction = action === 'SELL' ? -1 : 1;
  const pnlPct    = ((exitPrice - entryPrice) / entryPrice) * direction;
  // dollar P&L per share — caller multiplies by units
  return { pnlPct, pnlDollar: null }; // dollar filled after units known
}

function outcome(pnlPct) {
  if (pnlPct == null) return 'unknown';
  if (pnlPct > 0.002)  return 'win';
  if (pnlPct < -0.002) return 'loss';
  return 'breakeven';
}

// Patch a decision in-place without going through resolveDecision
// Used for partial updates (unrealized P&L) that don't mark resolved.
function patchDecision(id, fields) {
  const entries = loadDecisions();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  entries[idx] = { ...entries[idx], ...fields };
  writeFileSync(DECISIONS_PATH, JSON.stringify(entries, null, 2), 'utf8');
}

// ─── Portfolio index ──────────────────────────────────────────────────────────
// Build a Map<ticker, position> from cleanPortfolio array for O(1) lookup.

function indexPortfolio(portfolio) {
  const map = new Map();
  if (!Array.isArray(portfolio)) return map;
  for (const pos of portfolio) {
    const sym = (pos.symbol || '').toUpperCase();
    if (sym && sym !== 'UNKNOWN') {
      map.set(sym, {
        symbol:     sym,
        units:      parseFloat(pos.units   || 0),
        price:      parseFloat(pos.price   || 0),   // current market price
        avgCost:    parseFloat(pos.avg_cost || 0),   // average purchase price
        pnlPct:     parsePct(pos.pnl_pct),
        value:      parseFloat(pos.value   || 0),
      });
    }
  }
  return map;
}

// ─── Live quote with fallback ─────────────────────────────────────────────────

async function safeQuote(snapTrade, ticker) {
  try {
    const q = await snapTrade.GetLiveQuote(ticker);
    return q?.price ?? null;
  } catch (e) {
    console.warn(`[Resolver] Could not fetch live quote for ${ticker}: ${e.message}`);
    return null;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Reconcile all open decisions against live portfolio state.
 *
 * @param {object} snapTradeInstance — live SnapTrade instance from server.mjs
 * @returns {object} summary of what was processed
 */
export async function resolvePositions(snapTradeInstance) {
  const open     = getOpenDecisions();
  const overdue  = getOverdueDecisions();  // subset of open past evaluationDue

  if (open.length === 0) {
    console.log('[Resolver] No open decisions to reconcile.');
    return { checked: 0, resolved: 0, updated: 0, overdue: 0 };
  }

  console.log(`[Resolver] Reconciling ${open.length} open decision(s) — ${overdue.length} overdue`);

  // ── 1. Fetch current portfolio ────────────────────────────────────────────
  let portfolio = [];
  try {
    portfolio = await snapTradeInstance.FetchUserTrades();
  } catch (e) {
    console.error('[Resolver] FetchUserTrades failed:', e.message);
    // Non-fatal — we can still attempt live quotes for overdue positions
  }
  const posMap = indexPortfolio(portfolio);

  // ── 2. Collect unique tickers not in portfolio (need live quotes for closure) ──
  const missingTickers = [...new Set(
    open
      .filter(d => d.action === 'BUY' && !posMap.has(d.ticker))
      .map(d => d.ticker)
  )];

  // Fetch live quotes for missing tickers in parallel
  const liveQuotes = {};
  await Promise.all(missingTickers.map(async ticker => {
    liveQuotes[ticker] = await safeQuote(snapTradeInstance, ticker);
  }));

  // ── 3. Process each open decision ─────────────────────────────────────────
  let resolved = 0;
  let updated  = 0;

  for (const decision of open) {
    const { id, ticker, action, entryPrice, units, horizon } = decision;
    const isOverdue = overdue.some(o => o.id === id);
    const pos       = posMap.get(ticker);

    // ── BUY decisions ──────────────────────────────────────────────────────
    if (action === 'BUY') {

      if (pos) {
        // Position still open — update unrealized P&L snapshot, don't resolve
        const unrealizedPnlPct = entryPrice
          ? (pos.price - entryPrice) / entryPrice
          : pos.pnlPct;
        const unrealizedPnlDollar = units && pos.price && entryPrice
          ? (pos.price - entryPrice) * units
          : null;

        patchDecision(id, {
          unrealizedPnlPct:   unrealizedPnlPct,
          unrealizedPnlDollar: unrealizedPnlDollar,
          lastChecked:         new Date().toISOString(),
          currentPrice:        pos.price,
        });

        updated++;
        console.log(
          `[Resolver] OPEN  ${ticker} (${horizon}) — current: $${pos.price.toFixed(2)}, ` +
          `unrealized: ${unrealizedPnlPct != null ? (unrealizedPnlPct * 100).toFixed(2) + '%' : 'N/A'}`
          + (isOverdue ? ' ⚠ OVERDUE' : '')
        );

        // Force snapshot resolve if overdue (position held past horizon window)
        if (isOverdue) {
          const { pnlPct } = calcPnl(entryPrice, pos.price);
          const pnlDollar  = units && pnlPct != null ? pnlPct * entryPrice * units : null;
          resolveDecision(id, {
            outcome:       outcome(pnlPct),
            exitPrice:     pos.price,
            exitTimestamp: new Date().toISOString(),
            pnlPct,
            pnlDollar,
          });
          resolved++;
          console.log(`[Resolver] FORCE-RESOLVED ${ticker} — overdue ${horizon} snapshot @ $${pos.price.toFixed(2)}`);
        }

      } else {
        // Position gone from portfolio — closed or never filled
        const exitPrice = liveQuotes[ticker] ?? null;
        const { pnlPct } = calcPnl(entryPrice, exitPrice);
        const pnlDollar  = units && pnlPct != null ? pnlPct * entryPrice * units : null;

        resolveDecision(id, {
          outcome:       pnlPct != null ? outcome(pnlPct) : 'closed-untracked',
          exitPrice,
          exitTimestamp: new Date().toISOString(),
          pnlPct,
          pnlDollar,
        });
        resolved++;
        console.log(
          `[Resolver] CLOSED ${ticker} (${horizon}) — exit: ${exitPrice ? '$' + exitPrice.toFixed(2) : 'unknown'}` +
          `, P&L: ${pnlPct != null ? (pnlPct * 100).toFixed(2) + '%' : 'N/A'}`
        );
      }
    }

    // ── SELL decisions (short-side / rotation sells) ───────────────────────
    else if (action === 'SELL') {
      if (!pos) {
        // Position no longer held — sell executed successfully
        // For sells, profit = entry was the sell price, so P&L is always 0 on execution
        // Mark resolved with neutral outcome
        resolveDecision(id, {
          outcome:       'win',   // sell executed as intended
          exitPrice:     entryPrice,
          exitTimestamp: new Date().toISOString(),
          pnlPct:        0,
          pnlDollar:     0,
        });
        resolved++;
        console.log(`[Resolver] SELL executed: ${ticker} — marked resolved`);
      } else {
        // Still holding — SELL order may be pending or not filled yet
        patchDecision(id, { lastChecked: new Date().toISOString() });
        updated++;
        console.log(`[Resolver] SELL pending: ${ticker} still in portfolio`);
      }
    }
  }

  const summary = { checked: open.length, resolved, updated, overdue: overdue.length };
  console.log(`[Resolver] Done — checked: ${summary.checked}, resolved: ${resolved}, updated (unrealized): ${updated}`);
  return summary;
}
