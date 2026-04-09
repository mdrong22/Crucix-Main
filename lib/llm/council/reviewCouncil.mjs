/**
 * reviewCouncil.mjs — RedLine Phase 3: Strategic Review Council
 *
 * Orchestrates the daily performance review cycle:
 *   1. Reads resolved decisions from runs/decisions.json
 *   2. Computes structured performance stats
 *   3. Writes runs/lastReview.json — machine-readable context injected into future Debate sessions
 *   4. Triggers generateReviewReport() — produces the HTML + DOCX reports for the dashboard
 *   5. Returns { stats, reportFile, lastReview } for Telegram notification in server.mjs
 *
 * Called by: server.mjs → scheduleReviewMode()
 * Reads:     runs/decisions.json
 * Writes:    runs/lastReview.json
 * Delegates: generateReviewReport.mjs (HTML + DOCX output)
 */

import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadDecisions } from './utils/decisionLogger.mjs';
import { computeStats, generateReviewReport } from './utils/generateReviewReport.mjs';

const __dirname       = dirname(fileURLToPath(import.meta.url));
const ROOT            = join(__dirname, '../../../');
const LAST_REVIEW_PATH = join(ROOT, 'runs', 'lastReview.json');

// ─── Narrative builder ────────────────────────────────────────────────────────
// Generates a compact narrative summary string from computed stats.
// This is injected into Scout and Gregor contexts — concise, actionable language only.

function buildNarrativeSummary(stats) {
  const lines = [];

  // Overall snapshot
  const wrPct = (stats.winRate * 100).toFixed(0);
  const pfStr = stats.profitFactor === 999 ? 'Infinity (no losses)' : stats.profitFactor.toFixed(2);
  lines.push(
    `Overall council win rate: ${wrPct}% across ${stats.resolved} resolved decisions. ` +
    `Profit factor: ${pfStr}. Average win: +${stats.avgWinPct.toFixed(1)}%, average loss: ${stats.avgLossPct.toFixed(1)}%.`
  );

  // Horizon breakdown
  const horizonLines = [];
  for (const [h, s] of Object.entries(stats.byHorizon || {})) {
    const wr = (s.winRate * 100).toFixed(0);
    const flag = s.winRate >= 0.60 ? '✅ STRONG' : s.winRate < 0.45 ? '⚠ WEAK' : '〜 NEUTRAL';
    horizonLines.push(`${h}: ${wr}% win rate (${s.decisions} trades, avg P&L ${s.avgPnlPct.toFixed(2)}%) — ${flag}`);
  }
  if (horizonLines.length) lines.push(horizonLines.join('. ') + '.');

  // Signal insights
  const cluster = stats.bySignal?.congressionalCluster;
  if (cluster?.decisions > 0 && cluster.winRate != null) {
    const cwr = (cluster.winRate * 100).toFixed(0);
    const tag = cluster.winRate >= 0.70 ? 'PRIORITIZE' : cluster.winRate < 0.50 ? 'REVIEW SIGNAL QUALITY' : 'PROCEED WITH CAUTION';
    lines.push(`Congressional Cluster signal: ${cwr}% win rate over ${cluster.decisions} trades — ${tag}.`);
  }

  const highVix = stats.bySignal?.highVix;
  if (highVix?.decisions >= 3 && highVix.winRate != null) {
    const hvWr = (highVix.winRate * 100).toFixed(0);
    lines.push(`High-VIX trades (VIX ≥ 25): ${hvWr}% win rate — ${highVix.winRate < 0.45 ? 'elevated risk, size down' : 'performing acceptably'}.`);
  }

  // Top movers
  if (stats.topWins?.length) {
    lines.push(`Top winners: ${stats.topWins.map(d => d.ticker).join(', ')}.`);
  }
  if (stats.topLosses?.length) {
    lines.push(`Underperformers: ${stats.topLosses.map(d => d.ticker).join(', ')}.`);
  }

  // Lead recommendation
  if (stats.recommendations?.length) {
    lines.push(`Priority recommendation: ${stats.recommendations[0]}`);
  }

  return lines.join(' ');
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the full strategic review cycle.
 *
 * @returns {{ stats: object, reportFile: string|null, lastReview: object } | null}
 *   Returns null if there are no resolved decisions to review.
 */
export async function runReviewCouncil() {
  const decisions = loadDecisions();
  const resolved  = decisions.filter(d => d.resolved);

  if (resolved.length === 0) {
    console.log('[ReviewCouncil] No resolved decisions found — review skipped.');
    return null;
  }

  // ── Compute structured stats ───────────────────────────────────────────────
  const stats = computeStats(decisions);
  if (!stats) {
    console.log('[ReviewCouncil] Stats computation returned null — review skipped.');
    return null;
  }

  console.log(
    `[ReviewCouncil] Stats computed — ` +
    `winRate: ${(stats.winRate * 100).toFixed(1)}%, ` +
    `profitFactor: ${stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2)}, ` +
    `resolved: ${stats.resolved}/${stats.totalDecisions}`
  );

  // ── Build narrativeSummary ─────────────────────────────────────────────────
  const narrativeSummary = buildNarrativeSummary(stats);

  // ── Write lastReview.json (machine-readable council context) ───────────────
  const lastReview = {
    generatedAt:   new Date().toISOString(),
    totalDecisions: stats.totalDecisions,
    resolved:       stats.resolved,
    open:           stats.open,
    winRate:        stats.winRate,
    avgWinPct:      stats.avgWinPct,
    avgLossPct:     stats.avgLossPct,
    profitFactor:   stats.profitFactor,
    byHorizon:      stats.byHorizon,
    bySignal:       stats.bySignal,
    topWinners:     (stats.topWins   || []).map(d => d.ticker),
    topLosers:      (stats.topLosses || []).map(d => d.ticker),
    gregorWaitRate: stats.gregorWaitRate,
    recommendations: stats.recommendations,
    narrativeSummary,
  };

  try {
    writeFileSync(LAST_REVIEW_PATH, JSON.stringify(lastReview, null, 2), 'utf8');
    console.log('[ReviewCouncil] runs/lastReview.json written — council context updated.');
  } catch (err) {
    console.error('[ReviewCouncil] Failed to write lastReview.json:', err.message);
    // Non-fatal — continue to report generation
  }

  // ── Generate HTML + DOCX report (dedup-aware) ─────────────────────────────
  const reportFile = await generateReviewReport(stats);

  if (reportFile) {
    console.log(`[ReviewCouncil] Performance report saved: ${reportFile}`);
  } else {
    console.log('[ReviewCouncil] Report generation skipped (no new resolved decisions since last review).');
  }

  return { stats, reportFile, lastReview };
}
