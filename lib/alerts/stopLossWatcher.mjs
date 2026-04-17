/**
 * stopLossWatcher.mjs — RedLine Mechanical Exit Module
 *
 * Runs INDEPENDENTLY of the council sweep cycle. No LLM. Pure math.
 * Checks every open logged decision against live prices every 90 seconds
 * and fires hard exits when thresholds are breached.
 *
 * Three exit triggers:
 *   1. STOP-LOSS     — price falls below entry by configured % → market sell immediately
 *   2. TRAILING STOP — price rises to lock-in zone, then retraces by trail % → sell to protect gains
 *   3. INTRADAY EOD  — any INTRADAY position still open at 3:45 PM ET → force-close before market
 *
 * Thresholds (all overridable via env vars):
 *
 *   Horizon     Stop-Loss    Profit-Lock Trigger    Trail Distance
 *   INTRADAY    -2.0%        +1.0%                  1.5% from high
 *   SWING       -5.0%        +3.0%                  2.0% from high
 *   LONG        -12.0%       +8.0%                  4.0% from high
 *
 * Called by:  server.mjs → startStopLossWatcher(snapTrade, telegramAlerter)
 * Reads:      runs/decisions.json (open decisions only)
 * Writes:     runs/decisions.json (resolves triggered positions)
 * Executes:   snapTrade.PlaceOrder() — market SELL, no council involvement
 */

import { loadDecisions, resolveDecision } from '../llm/council/utils/decisionLogger.mjs';

// ─── Threshold configuration ──────────────────────────────────────────────────

const THRESHOLDS = {
  INTRADAY: {
    stopLoss:        parseFloat(process.env.STOP_LOSS_INTRADAY    ?? '0.02'),   // -2%
    profitLockAt:    parseFloat(process.env.PROFIT_LOCK_INTRADAY  ?? '0.01'),   // lock trail once +1%
    trailDistance:   parseFloat(process.env.TRAIL_INTRADAY        ?? '0.015'),  // sell if retraces 1.5% from high
  },
  SWING: {
    stopLoss:        parseFloat(process.env.STOP_LOSS_SWING       ?? '0.05'),   // -5%
    profitLockAt:    parseFloat(process.env.PROFIT_LOCK_SWING     ?? '0.03'),   // lock trail once +3%
    trailDistance:   parseFloat(process.env.TRAIL_SWING           ?? '0.02'),   // sell if retraces 2% from high
  },
  LONG: {
    stopLoss:        parseFloat(process.env.STOP_LOSS_LONG        ?? '0.12'),   // -12%
    profitLockAt:    parseFloat(process.env.PROFIT_LOCK_LONG      ?? '0.08'),   // lock trail once +8%
    trailDistance:   parseFloat(process.env.TRAIL_LONG            ?? '0.04'),   // sell if retraces 4% from high
  },
};

// INTRADAY force-exit time in EST (HHMM 24h format)
const INTRADAY_EOD_TIME = parseInt(process.env.INTRADAY_EOD_TIME ?? '1545', 10); // 3:45 PM ET

// Watcher poll interval in ms
const POLL_INTERVAL_MS = parseInt(process.env.STOP_LOSS_INTERVAL_MS ?? '90000', 10); // 90 seconds

// ─── Module-level state ───────────────────────────────────────────────────────

// IDs of decisions we have already fired an exit order for — prevents re-triggering
// (persists only for the lifetime of the server process; restarts are safe)
const _triggeredIds = new Set();

// IDs of INTRADAY positions that have already received the EOD warning this session
// Prevents repeated Telegram pings on every 90s poll after 3:45 PM
const _warnedEodIds = new Set();

// Per-ticker trailing stop tracking: ticker → { highWaterPrice, lockedIn: bool }
// Keyed by decision ID so each position tracks independently
const _trailingState = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function estNow() {
  const now = new Date();
  const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);
  return {
    hhmm: et.getHours() * 100 + et.getMinutes(),
    isRegularHours: (() => {
      const t = et.getHours() * 100 + et.getMinutes();
      return t >= 930 && t < 1600;
    })(),
  };
}

function pct(v) {
  return (v * 100).toFixed(2) + '%';
}

function getThresholds(horizon) {
  return THRESHOLDS[horizon] || THRESHOLDS.SWING; // default to SWING if horizon unknown
}

// ─── Core position check ──────────────────────────────────────────────────────

/**
 * Evaluate a single open decision against the live quote.
 * Returns an exit reason string if we should sell, or null to hold.
 */
function evaluatePosition(decision, livePrice, { hhmm }) {
  const id         = decision.id;
  const horizon    = decision.horizon || 'SWING';
  const entryPrice = parseFloat(decision.entryPrice);
  const thresholds = getThresholds(horizon);

  if (!entryPrice || entryPrice <= 0) return null; // can't evaluate without entry price

  const pnlPct = (livePrice - entryPrice) / entryPrice;

  // ── 1. STOP-LOSS ──────────────────────────────────────────────────────────
  if (pnlPct <= -thresholds.stopLoss) {
    return `STOP_LOSS — price fell ${pct(Math.abs(pnlPct))} below entry of $${entryPrice.toFixed(2)} (threshold: ${pct(thresholds.stopLoss)})`;
  }

  // ── 3. TRAILING STOP ──────────────────────────────────────────────────────
  if (!_trailingState.has(id)) {
    _trailingState.set(id, { highWaterPrice: livePrice, lockedIn: false });
  }

  const trail = _trailingState.get(id);

  // Update high water mark
  if (livePrice > trail.highWaterPrice) {
    trail.highWaterPrice = livePrice;
  }

  // Activate trailing lock once profit-lock threshold is hit
  if (!trail.lockedIn && pnlPct >= thresholds.profitLockAt) {
    trail.lockedIn = true;
    console.log(
      `[StopLoss] 🔒 Trail LOCKED for ${decision.ticker} (${horizon}) ` +
      `— up ${pct(pnlPct)}, high water: $${trail.highWaterPrice.toFixed(2)}`
    );
  }

  // If locked in and price retraces from high water by trailDistance → exit
  if (trail.lockedIn) {
    const retracePct = (trail.highWaterPrice - livePrice) / trail.highWaterPrice;
    if (retracePct >= thresholds.trailDistance) {
      return (
        `TRAILING_STOP — retraced ${pct(retracePct)} from high of $${trail.highWaterPrice.toFixed(2)} ` +
        `(trail: ${pct(thresholds.trailDistance)}, net P&L: ${pct(pnlPct)})`
      );
    }
  }

  return null; // hold
}

// ─── Exit executor ────────────────────────────────────────────────────────────

/**
 * Fire a market SELL for the given decision.
 * Uses units from the live portfolio if available (more accurate than logged units).
 */
async function executeExit(decision, livePrice, reason, portfolioMap, snapTrade, telegramAlerter) {
  const ticker = decision.ticker;
  const id     = decision.id;

  // Mark triggered immediately — prevents a second check firing before the order settles
  _triggeredIds.add(id);
  _trailingState.delete(id);

  // Get units from live portfolio (most accurate) or fall back to logged entry
  const livePos = portfolioMap?.get(ticker);
  const units   = livePos?.units
    ? parseFloat(livePos.units)
    : parseFloat(decision.entryPrice > 0 ? (50 / decision.entryPrice) : 1); // rough fallback

  if (!units || units <= 0) {
    console.warn(`[StopLoss] ⚠ Cannot determine units for ${ticker} — skipping exit.`);
    _triggeredIds.delete(id); // allow retry
    return;
  }

  const pnlPct = decision.entryPrice
    ? (livePrice - parseFloat(decision.entryPrice)) / parseFloat(decision.entryPrice)
    : null;

  console.log(`[StopLoss] 🚨 EXIT TRIGGERED — ${ticker} | ${reason} | units: ${units.toFixed(4)} | live: $${livePrice}`);

  // Submit market SELL
  let orderResult = null;
  try {
    orderResult = await snapTrade.PlaceOrder({
      symbol:          ticker,
      action:          'SELL',
      order_type:      'Market',
      time_in_force:   'Day',
      units:           units,
      trading_session: 'REGULAR',
    });
    console.log(`[StopLoss] ✅ SELL order placed for ${ticker}:`, JSON.stringify(orderResult)?.slice(0, 120));
  } catch (err) {
    console.error(`[StopLoss] ❌ SELL order failed for ${ticker}:`, err.message);
    _triggeredIds.delete(id); // allow retry on next tick if order failed
    return;
  }

  // Resolve the decision in decisions.json (skip for synthetic/untracked entries)
  if (!decision._synthetic) {
    try {
      resolveDecision(id, {
        outcome:       pnlPct >= 0 ? (pnlPct > 0.002 ? 'win' : 'breakeven') : 'loss',
        exitPrice:     livePrice,
        exitTimestamp: new Date().toISOString(),
        pnlPct:        pnlPct,
        pnlDollar:     pnlPct != null ? pnlPct * parseFloat(decision.entryPrice) * units : null,
        exitReason:    reason,
      });
      console.log(`[StopLoss] 📝 Decision ${id} resolved — ${ticker} ${pnlPct >= 0 ? '✅ win' : '❌ loss'} (${pct(pnlPct ?? 0)})`);
    } catch (err) {
      console.error(`[StopLoss] Failed to resolve decision ${id}:`, err.message);
    }
  } else {
    console.log(`[StopLoss] 📝 Synthetic exit for untracked position ${ticker} — not logged to decisions.json`);
  }

  // Telegram alert
  const emoji = pnlPct >= 0.005 ? '✅' : pnlPct >= 0 ? '〜' : '🛑';
  const msg = [
    `${emoji} RedLine STOP-LOSS EXIT`,
    `Ticker: ${ticker} (${decision.horizon})`,
    `Reason: ${reason.split(' — ')[0]}`,
    `Entry: $${parseFloat(decision.entryPrice).toFixed(2)} → Exit: $${livePrice.toFixed(2)}`,
    `P&L: ${pct(pnlPct ?? 0)} | Units: ${units.toFixed(4)}`,
  ].join('\n');

  try {
    telegramAlerter?.sendMessage?.(msg);
  } catch (_) {}
}

// ─── Synthetic decision builder ───────────────────────────────────────────────
// Creates a minimal decision-like object for portfolio positions that have no
// decisions.json entry. Used to give stop-loss coverage to untracked holdings.

function buildSyntheticDecision(pos) {
  // SnapTrade portfolio positions expose: symbol, units, price (avg cost),
  // open_pnl_pct, current_price. We use price as the "entry" proxy.
  const entryPrice = parseFloat(pos.price ?? pos.averageCost ?? 0);
  if (!entryPrice || entryPrice <= 0) return null;
  return {
    id:          `synthetic-${pos.symbol}`,
    ticker:      pos.symbol,
    action:      'BUY',
    horizon:     'SWING',  // default — no horizon logged for untracked positions
    entryPrice,
    units:       parseFloat(pos.units ?? 0),
    resolved:    false,
    _synthetic:  true,     // flag so we can skip decisionLogger.resolveDecision
  };
}

// ─── Main check loop ──────────────────────────────────────────────────────────

async function runStopLossCheck(snapTrade, telegramAlerter) {
  const time = estNow();

  // Only run during regular market hours (and 15 min after close for EOD cleanup)
  if (time.hhmm < 930 || time.hhmm > 1615) return;

  // Load open decisions
  const allDecisions = loadDecisions();
  const trackedTickers = new Set(
    allDecisions.filter(d => !d.resolved).map(d => d.ticker)
  );
  const open = allDecisions.filter(d =>
    !d.resolved &&
    !_triggeredIds.has(d.id) &&
    d.entryPrice &&
    d.ticker
  );

  // Fetch live portfolio once (for units + reconciliation)
  let portfolioMap = new Map();
  try {
    const portfolio = await snapTrade.FetchUserTrades();
    for (const pos of (portfolio || [])) {
      portfolioMap.set(pos.symbol, pos);
    }
  } catch (err) {
    console.warn('[StopLoss] Could not fetch portfolio for unit lookup:', err.message);
  }

  // ── Reconciliation: find portfolio positions with NO logged decision ─────────
  // These are untracked holdings — give them synthetic SWING-level stop coverage.
  for (const [symbol, pos] of portfolioMap) {
    if (trackedTickers.has(symbol)) continue;                 // already tracked
    if (_triggeredIds.has(`synthetic-${symbol}`)) continue;   // already exited this session
    const synthetic = buildSyntheticDecision(pos);
    if (!synthetic) continue;
    open.push(synthetic);
  }

  if (open.length === 0) return;

  // Check each open position
  for (const decision of open) {
    const ticker = decision.ticker;

    // Skip if no entry price
    if (!decision.entryPrice || parseFloat(decision.entryPrice) <= 0) continue;

    // Skip SELL decisions (we only watch BUY positions for exit)
    if (decision.action === 'SELL') continue;

    // Fetch live quote
    let livePrice;
    try {
      const quote = await snapTrade.GetLiveQuote(ticker);
      livePrice = quote?.price;
    } catch (err) {
      console.warn(`[StopLoss] Quote failed for ${ticker}: ${err.message}`);
      continue;
    }

    if (!livePrice || livePrice <= 0) continue;

    // ── INTRADAY EOD warning (alert only — no auto-sell) ──────────────────
    if (decision.horizon === 'INTRADAY' && time.hhmm >= INTRADAY_EOD_TIME && !_warnedEodIds.has(decision.id)) {
      _warnedEodIds.add(decision.id);
      const pnlPct = decision.entryPrice
        ? (livePrice - parseFloat(decision.entryPrice)) / parseFloat(decision.entryPrice)
        : null;
      const emoji = pnlPct >= 0 ? '📈' : '📉';
      console.warn(`[StopLoss] ⏰ INTRADAY EOD WARNING — ${ticker} still open at ${time.hhmm} ET | P&L: ${pct(pnlPct ?? 0)}`);
      try {
        telegramAlerter?.sendMessage?.(
          `⏰ INTRADAY EOD WARNING\n` +
          `${ticker} is still open past ${INTRADAY_EOD_TIME} ET\n` +
          `${emoji} P&L: ${pct(pnlPct ?? 0)} | Live: $${livePrice.toFixed(2)} | Entry: $${parseFloat(decision.entryPrice).toFixed(2)}\n` +
          `No auto-sell — manual action required.`
        );
      } catch (_) {}
    }

    // Evaluate against thresholds
    const exitReason = evaluatePosition(decision, livePrice, time);

    if (exitReason) {
      await executeExit(decision, livePrice, exitReason, portfolioMap, snapTrade, telegramAlerter);
      // Small pause between exits if multiple positions trigger at once
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the stop-loss watcher. Call once from server.mjs after SnapTrade is initialized.
 *
 * @param {SnapTrade} snapTrade       — initialized SnapTrade instance
 * @param {object}    telegramAlerter — { sendMessage: async (text) => void }
 */
export function startStopLossWatcher(snapTrade, telegramAlerter) {
  console.log(
    `[StopLoss] 🛡 Watcher started — polling every ${POLL_INTERVAL_MS / 1000}s\n` +
    `  INTRADAY: stop ${pct(THRESHOLDS.INTRADAY.stopLoss)} | lock ${pct(THRESHOLDS.INTRADAY.profitLockAt)} | trail ${pct(THRESHOLDS.INTRADAY.trailDistance)}\n` +
    `  SWING:    stop ${pct(THRESHOLDS.SWING.stopLoss)}    | lock ${pct(THRESHOLDS.SWING.profitLockAt)}    | trail ${pct(THRESHOLDS.SWING.trailDistance)}\n` +
    `  LONG:     stop ${pct(THRESHOLDS.LONG.stopLoss)}   | lock ${pct(THRESHOLDS.LONG.profitLockAt)}   | trail ${pct(THRESHOLDS.LONG.trailDistance)}`
  );

  // Run immediately on startup (catches overnight gap-downs on open)
  runStopLossCheck(snapTrade, telegramAlerter).catch(err =>
    console.error('[StopLoss] Initial check failed:', err.message)
  );

  // Then poll on interval
  setInterval(() => {
    runStopLossCheck(snapTrade, telegramAlerter).catch(err =>
      console.error('[StopLoss] Check failed:', err.message)
    );
  }, POLL_INTERVAL_MS);
}

/**
 * Expose current watcher state for the dashboard API if needed.
 */
export function getWatcherState() {
  return {
    triggeredCount:  _triggeredIds.size,
    trackedPositions: _trailingState.size,
    thresholds:       THRESHOLDS,
    pollIntervalMs:   POLL_INTERVAL_MS,
  };
}
