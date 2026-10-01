/**
 * trackRecord.mjs — The agent's own scorecard, fed back into every decision.
 *
 * The analyst is otherwise blind to whether its past calls worked. This closes the loop:
 * it distills runs/decisions.json (resolved P&L per trade) into a compact "YOUR TRACK RECORD"
 * block so the agent can CALIBRATE — lean into signals/horizons that have actually paid off,
 * downweight the ones that haven't, and correct its own behavioral leaks (e.g. cutting winners
 * short). This is the single biggest lever on decision quality: reaction → learning.
 *
 * Reuses computeStats() (the same stats the daily review uses) — one source of truth.
 */

import { loadDecisions } from './council/utils/decisionLogger.mjs';
import { computeStats } from './council/utils/generateReviewReport.mjs';

// Need a minimum sample before the record means anything — don't let the agent over-fit 1-2 trades.
const MIN_RESOLVED = parseInt(process.env.TRACK_RECORD_MIN ?? '3', 10);

const pct = (v) => `${(v * 100).toFixed(0)}%`;

function horizonFlag(wr) {
  return wr >= 0.60 ? 'STRONG — lean in' : wr < 0.45 ? 'WEAK — be selective' : 'neutral';
}

/**
 * Derive behavioral tendencies the agent should correct — the high-value, non-obvious part.
 * These are patterns in ITS OWN history, phrased as actionable self-corrections.
 */
function behavioralInsights(s) {
  const out = [];
  const avgWin = s.avgWinPct;          // already ×100 (positive)
  const avgLoss = Math.abs(s.avgLossPct); // already ×100 (make positive)

  // Cutting winners short / letting losers run — the most common retail leak.
  if (s.wins >= 2 && s.losses >= 2 && avgWin > 0 && avgLoss > 0 && avgWin < avgLoss) {
    out.push(`Your average win (+${avgWin.toFixed(1)}%) is SMALLER than your average loss (−${avgLoss.toFixed(1)}%) — you cut winners too early and/or let losers run. Give winners more room; honor stops faster.`);
  }
  // High hit-rate but poor payoff — winning often, earning little.
  if (s.winRate >= 0.55 && s.profitFactor < 1.3 && s.profitFactor !== 999) {
    out.push(`You win often (${pct(s.winRate)}) but profit factor is only ${s.profitFactor.toFixed(2)} — your size/targets aren't capturing the edge. Press high-conviction setups harder.`);
  }
  // Net-negative system — stop and reassess.
  if (s.profitFactor < 1.0 && s.resolved >= 5) {
    out.push(`Profit factor ${s.profitFactor.toFixed(2)} (< 1.0) — the system is net-negative. Raise your bar: prefer NO_ACTION unless the setup is A+.`);
  }
  // High-VIX underperformance.
  const hv = s.bySignal?.highVix;
  if (hv?.decisions >= 3 && hv.winRate != null && hv.winRate < 0.45) {
    out.push(`High-VIX entries (VIX ≥ 25) win only ${pct(hv.winRate)} — size down or wait for calmer tape in volatile conditions.`);
  }
  return out;
}

/**
 * Build the compact track-record block for the analyst context.
 * Returns a short multi-line string, or a neutral placeholder until enough trades resolve.
 */
export function buildTrackRecord() {
  let decisions = [];
  try { decisions = loadDecisions(); } catch { return 'no track record yet'; }

  const stats = computeStats(decisions);
  if (!stats || stats.resolved < MIN_RESOLVED) {
    return `insufficient history (${stats?.resolved ?? 0} resolved; need ${MIN_RESOLVED}) — trade conservatively until a record builds`;
  }

  const lines = [];
  const pf = stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2);
  lines.push(`Overall: ${pct(stats.winRate)} win rate, profit factor ${pf}, over ${stats.resolved} resolved trades. Avg win +${stats.avgWinPct.toFixed(1)}% / avg loss ${stats.avgLossPct.toFixed(1)}%.`);

  // By horizon — tells it which timeframes actually pay off for it.
  const hLines = [];
  for (const [h, hs] of Object.entries(stats.byHorizon || {})) {
    if (h === 'UNKNOWN' || !hs.decisions) continue;
    hLines.push(`${h} ${pct(hs.winRate)} (${hs.decisions}t) — ${horizonFlag(hs.winRate)}`);
  }
  if (hLines.length) lines.push(`By horizon: ${hLines.join(' | ')}`);

  // By signal — which triggers are predictive FOR IT.
  const sigLines = [];
  const cl = stats.bySignal?.congressionalCluster;
  if (cl?.decisions > 0 && cl.winRate != null) sigLines.push(`Congressional-cluster ${pct(cl.winRate)} (${cl.decisions}t)`);
  const hs = stats.bySignal?.highScore;
  if (hs?.decisions > 0 && hs.winRate != null) sigLines.push(`High-score(≥8) ${pct(hs.winRate)} (${hs.decisions}t)`);
  if (sigLines.length) lines.push(`By signal: ${sigLines.join(' | ')}`);

  // Recent movers — concrete names.
  if (stats.topWins?.length)   lines.push(`Recent winners: ${stats.topWins.slice(0, 3).map(d => d.ticker).join(', ')}.`);
  if (stats.topLosses?.length) lines.push(`Recent losers: ${stats.topLosses.slice(0, 3).map(d => d.ticker).join(', ')}.`);

  // Behavioral self-corrections — the actionable part.
  const insights = behavioralInsights(stats);
  if (insights.length) lines.push(`⚠ Correct these: ${insights.join(' ')}`);

  return lines.join('\n  ');
}
