/**
 * stopLossWatcher.mjs — Hard Mechanical Stop-Loss (bypasses Accept/Deny)
 *
 * Runs INDEPENDENTLY of the sweep/proposal cycle. No LLM, no approval. Pure math.
 * Checks every open logged decision + every live portfolio position against live prices
 * on a fast timer and fires HARD exits when thresholds are breached — even at a loss.
 * This is the deliberate exception to "nothing executes without my approval": a stop-loss
 * that needs approval is not a stop-loss.
 *
 * Exit triggers:
 *   1. HARD STOP     — explicit stop price (from the accepted proposal) OR a horizon %-floor is
 *                      breached → MARKET SELL immediately, regardless of P&L sign.
 *   2. TRAILING STOP — once in profit, price retraces from its high by the trail distance → SELL to lock gains.
 *   3. INTRADAY EOD  — intraday positions still open near close: warn if up, convert to SWING if down.
 *
 * Thresholds (all overridable via env vars):
 *   Horizon     Hard Stop    Profit-Lock    Trail Distance
 *   INTRADAY    -2.0%        +1.0%          1.5% from high
 *   SWING       -5.0%        +3.0%          2.0% from high
 *   LONG        -12.0%       +8.0%          4.0% from high
 *
 * Reads:    runs/decisions.json (open decisions; incl. optional per-position stopLossPrice)
 * Executes: snapTrade.PlaceOrder() — market SELL, no approval
 */

import { loadDecisions, resolveDecision, updateDecision } from '../llm/council/utils/decisionLogger.mjs';

const THRESHOLDS = {
  INTRADAY: {
    stopLoss:      parseFloat(process.env.STOP_LOSS_INTRADAY   ?? '0.02'),
    profitLockAt:  parseFloat(process.env.PROFIT_LOCK_INTRADAY ?? '0.01'),
    trailDistance: parseFloat(process.env.TRAIL_INTRADAY       ?? '0.015'),
  },
  SWING: {
    stopLoss:      parseFloat(process.env.STOP_LOSS_SWING      ?? '0.05'),
    profitLockAt:  parseFloat(process.env.PROFIT_LOCK_SWING    ?? '0.03'),
    trailDistance: parseFloat(process.env.TRAIL_SWING          ?? '0.02'),
  },
  LONG: {
    stopLoss:      parseFloat(process.env.STOP_LOSS_LONG       ?? '0.12'),
    profitLockAt:  parseFloat(process.env.PROFIT_LOCK_LONG     ?? '0.08'),
    trailDistance: parseFloat(process.env.TRAIL_LONG           ?? '0.04'),
  },
};

const INTRADAY_EOD_TIME = parseInt(process.env.INTRADAY_EOD_TIME ?? '1545', 10);
const POLL_INTERVAL_MS  = parseInt(process.env.STOP_LOSS_INTERVAL_MS ?? '90000', 10);

const _triggeredIds    = new Set(); // exited this session — never re-fire
const _warnedEodIds    = new Set();
const _convertedToSwing = new Set();
const _trailingState   = new Map();  // id → { highWaterPrice, lockedIn }

function estNow() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { hhmm: et.getHours() * 100 + et.getMinutes() };
}
function pct(v) { return (v * 100).toFixed(2) + '%'; }
function getThresholds(h) { return THRESHOLDS[h] || THRESHOLDS.SWING; }

/**
 * Decide whether to exit. Returns an exit-reason string, or null to hold.
 * HARD STOP fires even when underwater — this is the point of a hard stop.
 */
function evaluatePosition(decision, livePrice) {
  const horizon    = decision.horizon || 'SWING';
  const entryPrice = parseFloat(decision.entryPrice);
  const t          = getThresholds(horizon);
  if (!entryPrice || entryPrice <= 0) return null;

  const pnlPct = (livePrice - entryPrice) / entryPrice;

  // 1. HARD STOP — explicit stop price (from the proposal) takes precedence; else horizon %-floor.
  const explicitStop = parseFloat(decision.stopLossPrice);
  if (explicitStop > 0 && livePrice <= explicitStop) {
    return `HARD_STOP — $${livePrice.toFixed(2)} ≤ stop $${explicitStop.toFixed(2)} (P&L ${pct(pnlPct)})`;
  }
  if (pnlPct <= -t.stopLoss) {
    return `HARD_STOP — down ${pct(Math.abs(pnlPct))} ≥ ${pct(t.stopLoss)} ${horizon} floor (P&L ${pct(pnlPct)})`;
  }

  // 2. TRAILING STOP — protect gains once in profit.
  if (pnlPct >= 0) {
    if (!_trailingState.has(decision.id)) _trailingState.set(decision.id, { highWaterPrice: livePrice, lockedIn: false });
    const trail = _trailingState.get(decision.id);
    if (livePrice > trail.highWaterPrice) trail.highWaterPrice = livePrice;
    if (!trail.lockedIn && pnlPct >= t.profitLockAt) {
      trail.lockedIn = true;
      console.log(`[StopLoss] 🔒 Trail LOCKED ${decision.ticker} (${horizon}) — up ${pct(pnlPct)}, high $${trail.highWaterPrice.toFixed(2)}`);
    }
    if (trail.lockedIn) {
      const retracePct = (trail.highWaterPrice - livePrice) / trail.highWaterPrice;
      if (retracePct >= t.trailDistance) {
        return `TRAILING_STOP — retraced ${pct(retracePct)} from high $${trail.highWaterPrice.toFixed(2)} (P&L ${pct(pnlPct)})`;
      }
    }
  }
  return null;
}

async function executeExit(decision, livePrice, reason, portfolioMap, snapTrade, telegramAlerter) {
  const ticker = decision.ticker;
  const id     = decision.id;
  _triggeredIds.add(id);
  _trailingState.delete(id);

  const livePos = portfolioMap?.get(ticker);
  const units   = livePos?.units ? parseFloat(livePos.units)
                : (decision.units ? parseFloat(decision.units) : null);
  if (!units || units <= 0) {
    console.warn(`[StopLoss] ⚠ Cannot determine units for ${ticker} — skipping exit.`);
    _triggeredIds.delete(id);
    return;
  }

  const pnlPct = decision.entryPrice ? (livePrice - parseFloat(decision.entryPrice)) / parseFloat(decision.entryPrice) : null;
  // Fractional positions must use Day orders (SnapTrade rule).
  const tif = Number.isInteger(units) ? 'Day' : 'Day';

  console.log(`[StopLoss] 🚨 HARD EXIT — ${ticker} | ${reason} | units ${units} | live $${livePrice}`);
  let orderResult = null;
  try {
    orderResult = await snapTrade.PlaceOrder({
      symbol: ticker, action: 'SELL', order_type: 'Market',
      time_in_force: tif, units, trading_session: 'REGULAR',
    });
    console.log(`[StopLoss] ✅ SELL placed for ${ticker}:`, JSON.stringify(orderResult)?.slice(0, 120));
  } catch (err) {
    console.error(`[StopLoss] ❌ SELL failed for ${ticker}:`, err.message);
    _triggeredIds.delete(id);
    return;
  }

  if (!decision._synthetic) {
    try {
      resolveDecision(id, {
        outcome:       pnlPct >= 0 ? (pnlPct > 0.002 ? 'win' : 'breakeven') : 'loss',
        exitPrice:     livePrice,
        exitTimestamp: new Date().toISOString(),
        pnlPct,
        pnlDollar:     pnlPct != null ? pnlPct * parseFloat(decision.entryPrice) * units : null,
        exitReason:    reason,
      });
    } catch (err) { console.error(`[StopLoss] resolve failed ${id}:`, err.message); }
  }

  const emoji = pnlPct >= 0.005 ? '✅' : pnlPct >= 0 ? '〜' : '🛑';
  try {
    telegramAlerter?.sendMessage?.([
      `${emoji} *HARD STOP-LOSS — auto-exit (no approval)*`,
      `${ticker} (${decision.horizon || 'SWING'})`,
      reason.split(' — ')[0],
      `Entry: $${parseFloat(decision.entryPrice).toFixed(2)} → Exit: $${livePrice.toFixed(2)}`,
      `P&L: ${pct(pnlPct ?? 0)} | Units: ${units}`,
    ].join('\n'));
  } catch (_) {}
}

function buildSyntheticDecision(pos) {
  const entryPrice = parseFloat(pos.price ?? pos.averageCost ?? 0);
  if (!entryPrice || entryPrice <= 0) return null;
  return {
    id: `synthetic-${pos.symbol}`, ticker: pos.symbol, action: 'BUY',
    horizon: 'SWING', entryPrice, units: parseFloat(pos.units ?? 0),
    stopLossPrice: null, resolved: false, _synthetic: true,
  };
}

async function runStopLossCheck(snapTrade, telegramAlerter) {
  const time = estNow();
  if (time.hhmm < 930 || time.hhmm > 1615) return; // regular hours + short EOD tail

  const allDecisions = loadDecisions();
  const trackedTickers = new Set(allDecisions.filter(d => !d.resolved).map(d => d.ticker));
  const open = allDecisions.filter(d => !d.resolved && !_triggeredIds.has(d.id) && d.entryPrice && d.ticker);

  let portfolioMap = new Map();
  try {
    const portfolio = await snapTrade.FetchUserTrades();
    for (const pos of (portfolio || [])) portfolioMap.set(pos.symbol, pos);
  } catch (err) {
    console.warn('[StopLoss] portfolio fetch failed:', err.message);
  }

  // Untracked holdings get synthetic SWING-level stop coverage.
  for (const [symbol, pos] of portfolioMap) {
    if (trackedTickers.has(symbol) || _triggeredIds.has(`synthetic-${symbol}`)) continue;
    const synthetic = buildSyntheticDecision(pos);
    if (synthetic) open.push(synthetic);
  }
  if (open.length === 0) return;

  for (const decision of open) {
    if (decision.action === 'SELL') continue;
    const ticker = decision.ticker;
    let livePrice;
    try {
      const quote = await snapTrade.GetLiveQuote(ticker);
      livePrice = quote?.price;
    } catch (err) { console.warn(`[StopLoss] quote failed ${ticker}: ${err.message}`); continue; }
    if (!livePrice || livePrice <= 0) continue;

    // INTRADAY EOD: down → convert to SWING (overnight coverage); up → profit warning.
    if (decision.horizon === 'INTRADAY' && time.hhmm >= INTRADAY_EOD_TIME) {
      const pnlPct = (livePrice - parseFloat(decision.entryPrice)) / parseFloat(decision.entryPrice);
      if (pnlPct < 0 && !_convertedToSwing.has(decision.id)) {
        _convertedToSwing.add(decision.id);
        if (!decision._synthetic) updateDecision(decision.id, { horizon: 'SWING' });
        console.log(`[StopLoss] 🔄 INTRADAY→SWING ${ticker} down ${pct(Math.abs(pnlPct))} at EOD — overnight SWING stop coverage.`);
        continue;
      } else if (pnlPct >= 0 && !_warnedEodIds.has(decision.id)) {
        _warnedEodIds.add(decision.id);
        try { telegramAlerter?.sendMessage?.(`⏰ *${ticker}* up ${pct(pnlPct)} near close — consider taking profit (no auto-sell).`); } catch (_) {}
      }
    }

    const exitReason = evaluatePosition(decision, livePrice);
    if (exitReason) {
      await executeExit(decision, livePrice, exitReason, portfolioMap, snapTrade, telegramAlerter);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

export function startStopLossWatcher(snapTrade, telegramAlerter) {
  console.log(
    `[StopLoss] 🛡 HARD stop-loss watcher started — every ${POLL_INTERVAL_MS / 1000}s, bypasses approval\n` +
    `  INTRADAY stop ${pct(THRESHOLDS.INTRADAY.stopLoss)} | SWING stop ${pct(THRESHOLDS.SWING.stopLoss)} | LONG stop ${pct(THRESHOLDS.LONG.stopLoss)}`
  );
  runStopLossCheck(snapTrade, telegramAlerter).catch(err => console.error('[StopLoss] initial check failed:', err.message));
  setInterval(() => {
    runStopLossCheck(snapTrade, telegramAlerter).catch(err => console.error('[StopLoss] check failed:', err.message));
  }, POLL_INTERVAL_MS);
}

export function getWatcherState() {
  return { triggeredCount: _triggeredIds.size, trackedPositions: _trailingState.size, thresholds: THRESHOLDS, pollIntervalMs: POLL_INTERVAL_MS };
}
