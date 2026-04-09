/**
 * generateReviewReport.mjs — RedLine Performance Review Generator
 *
 * Computes structured stats from runs/decisions.json, deduplicates against
 * the last review, then writes two files to /reports:
 *   - REVIEW_<date>.html  — rendered inline in the RedLine dashboard modal
 *   - REVIEW_<date>.docx  — formatted Word document for offline reading
 *
 * Deduplication: compares the set of resolved decision IDs against the set
 * included in the last review. If nothing new has resolved, skips generation.
 *
 * Called by: Phase 3 reviewCouncil.mjs  (or directly for testing)
 * Reads:     runs/decisions.json, runs/reviewState.json
 * Writes:    runs/reviewState.json, reports/REVIEW_*.html, reports/REVIEW_*.docx
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const ROOT        = join(__dirname, '../../../../');
const RUNS_DIR    = join(ROOT, 'runs');
const REPORTS_DIR = join(ROOT, 'reports');
const DECISIONS_PATH    = join(RUNS_DIR, 'decisions.json');
const REVIEW_STATE_PATH = join(RUNS_DIR, 'reviewState.json');
const PYTHON_SCRIPT     = join(__dirname, '../../../../scripts/generateReviewDocx.py');

// ─── File helpers ─────────────────────────────────────────────────────────────

function ensureDirs() {
  for (const d of [RUNS_DIR, REPORTS_DIR]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}

function loadJSON(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return fallback; }
}

// ─── Stats computation ────────────────────────────────────────────────────────

export function computeStats(decisions) {
  const resolved = decisions.filter(d => d.resolved);
  const open     = decisions.filter(d => !d.resolved);

  if (resolved.length === 0) return null;

  // ── Overall ──
  const wins       = resolved.filter(d => d.outcome === 'win');
  const losses     = resolved.filter(d => d.outcome === 'loss');
  const breakevens = resolved.filter(d => d.outcome === 'breakeven');
  const winRate    = resolved.length ? wins.length / resolved.length : 0;

  const avgWinPct  = wins.length
    ? wins.reduce((s, d) => s + (d.pnlPct || 0), 0) / wins.length * 100
    : 0;
  const avgLossPct = losses.length
    ? losses.reduce((s, d) => s + (d.pnlPct || 0), 0) / losses.length * 100
    : 0;

  const totalGain = wins.reduce((s, d) => s + Math.abs(d.pnlDollar || 0), 0);
  const totalLoss = losses.reduce((s, d) => s + Math.abs(d.pnlDollar || 0), 0);
  const profitFactor = totalLoss > 0 ? totalGain / totalLoss : totalGain > 0 ? Infinity : 0;

  // ── By Horizon ──
  const horizons = ['INTRADAY', 'SWING', 'LONG', 'UNKNOWN'];
  const byHorizon = {};
  for (const h of horizons) {
    const hDecisions = resolved.filter(d => d.horizon === h);
    if (!hDecisions.length) continue;
    const hWins = hDecisions.filter(d => d.outcome === 'win');
    const avgPnl = hDecisions.reduce((s, d) => s + (d.pnlPct || 0), 0) / hDecisions.length * 100;
    byHorizon[h] = {
      decisions: hDecisions.length,
      wins:      hWins.length,
      winRate:   hDecisions.length ? hWins.length / hDecisions.length : 0,
      avgPnlPct: avgPnl,
    };
  }

  // ── By Signal ──
  const clusterDecisions    = resolved.filter(d => d.signals?.congressionalCluster);
  const clusterWins         = clusterDecisions.filter(d => d.outcome === 'win');
  const nonClusterDecisions = resolved.filter(d => !d.signals?.congressionalCluster);
  const nonClusterWins      = nonClusterDecisions.filter(d => d.outcome === 'win');

  const highScoreDecisions  = resolved.filter(d => (d.signals?.signalScore ?? 0) >= 7);
  const highScoreWins       = highScoreDecisions.filter(d => d.outcome === 'win');
  const lowScoreDecisions   = resolved.filter(d => (d.signals?.signalScore ?? 0) < 7);
  const lowScoreWins        = lowScoreDecisions.filter(d => d.outcome === 'win');

  const highVixDecisions    = resolved.filter(d => (d.signals?.vix ?? 0) >= 25);
  const highVixWins         = highVixDecisions.filter(d => d.outcome === 'win');

  const bySignal = {
    congressionalCluster: {
      decisions: clusterDecisions.length,
      winRate: clusterDecisions.length ? clusterWins.length / clusterDecisions.length : null,
    },
    noCluster: {
      decisions: nonClusterDecisions.length,
      winRate: nonClusterDecisions.length ? nonClusterWins.length / nonClusterDecisions.length : null,
    },
    highSignalScore: {
      decisions: highScoreDecisions.length,
      winRate: highScoreDecisions.length ? highScoreWins.length / highScoreDecisions.length : null,
      label: 'Score ≥ 7',
    },
    lowSignalScore: {
      decisions: lowScoreDecisions.length,
      winRate: lowScoreDecisions.length ? lowScoreWins.length / lowScoreDecisions.length : null,
      label: 'Score < 7',
    },
    highVix: {
      decisions: highVixDecisions.length,
      winRate: highVixDecisions.length ? highVixWins.length / highVixDecisions.length : null,
      label: 'VIX ≥ 25',
    },
  };

  // ── Top winners / losers ──
  const sorted    = [...resolved].filter(d => d.pnlPct !== null).sort((a, b) => b.pnlPct - a.pnlPct);
  const topWins   = sorted.slice(0, 5).filter(d => d.pnlPct >= 0);
  const topLosses = [...sorted].reverse().slice(0, 5).filter(d => d.pnlPct < 0);

  // ── Gregor wait rate ──
  const totalDebates    = decisions.length;
  const waitCount       = open.length;
  const gregorWaitRate  = totalDebates ? waitCount / totalDebates : 0;

  // ── Recommendations ──
  const recommendations = [];
  if (byHorizon.INTRADAY?.winRate < 0.45)
    recommendations.push('INTRADAY win rate below 45% — raise minimum signal score threshold to 8 for same-day trades.');
  if (byHorizon.SWING?.winRate > 0.60)
    recommendations.push('SWING win rate strong — consider increasing allocation tier on high-score SWING setups.');
  if (bySignal.congressionalCluster.winRate > 0.70)
    recommendations.push('Congressional Cluster signal highly predictive — continue prioritizing as LONG trigger.');
  if (bySignal.congressionalCluster.winRate < 0.50 && bySignal.congressionalCluster.decisions >= 4)
    recommendations.push('Congressional Cluster underperforming — verify FMP data freshness and member identity accuracy.');
  if (winRate < 0.40)
    recommendations.push('Overall win rate below 40% — review Scout signal scoring calibration and Gregor sizing logic.');
  if (profitFactor < 1.0 && resolved.length >= 5)
    recommendations.push('Profit factor below 1.0 — system is net-negative. Immediate review of risk management required.');
  if (!recommendations.length)
    recommendations.push('No critical issues detected. Continue current council configuration.');

  return {
    generatedAt: new Date().toISOString(),
    totalDecisions: decisions.length,
    resolved: resolved.length,
    open: open.length,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate,
    avgWinPct,
    avgLossPct,
    profitFactor: isFinite(profitFactor) ? profitFactor : 999,
    totalGainDollar: totalGain,
    totalLossDollar: totalLoss,
    byHorizon,
    bySignal,
    topWins,
    topLosses,
    gregorWaitRate,
    recommendations,
  };
}

// ─── HTML report ─────────────────────────────────────────────────────────────
// Styled to match the RedLine dark dashboard aesthetic.

function pct(n)   { return n == null ? '—' : `${(n * 100).toFixed(1)}%`; }
function num(n,d=2) { return n == null ? '—' : n.toFixed(d); }
function dollar(n) { return n == null ? '—' : `$${Math.abs(n).toFixed(0)}`; }
function colorClass(v, good = true) {
  if (v == null) return '';
  return v >= 0.5 === good ? 'pos' : 'neg';
}

function buildHtml(stats, dateLabel) {
  const hRows = Object.entries(stats.byHorizon).map(([h, s]) => `
    <tr>
      <td>${h}</td>
      <td>${s.decisions}</td>
      <td class="${colorClass(s.winRate)}">${pct(s.winRate)}</td>
      <td class="${s.avgPnlPct >= 0 ? 'pos' : 'neg'}">${s.avgPnlPct.toFixed(2)}%</td>
    </tr>`).join('');

  const sRows = Object.entries(stats.bySignal).map(([key, s]) => {
    const label = s.label || key.replace(/([A-Z])/g, ' $1').trim();
    return `<tr>
      <td>${label}</td>
      <td>${s.decisions}</td>
      <td class="${colorClass(s.winRate)}">${s.winRate != null ? pct(s.winRate) : '—'}</td>
    </tr>`;
  }).join('');

  const winRows = stats.topWins.map(d => `
    <tr>
      <td>${d.ticker}</td>
      <td>${d.horizon}</td>
      <td class="pos">+${(d.pnlPct * 100).toFixed(2)}%</td>
      <td class="pos">${dollar(d.pnlDollar)}</td>
    </tr>`).join('');

  const lossRows = stats.topLosses.map(d => `
    <tr>
      <td>${d.ticker}</td>
      <td>${d.horizon}</td>
      <td class="neg">${(d.pnlPct * 100).toFixed(2)}%</td>
      <td class="neg">-${dollar(d.pnlDollar)}</td>
    </tr>`).join('');

  const recItems = stats.recommendations.map(r => `<li>${r}</li>`).join('');

  const pfColor = stats.profitFactor >= 1.5 ? 'pos' : stats.profitFactor >= 1.0 ? 'neutral' : 'neg';
  const wrColor = stats.winRate  >= 0.55 ? 'pos' : stats.winRate  >= 0.40 ? 'neutral' : 'neg';

  return `<style>
.rl-review { font-family: 'Courier New', monospace; color: #e0e0e0; font-size: 13px; line-height: 1.6; }
.rl-review h1 { color: #ff6b00; font-size: 18px; letter-spacing: 3px; margin: 0 0 4px 0; }
.rl-review h2 { color: #ff6b00; font-size: 13px; letter-spacing: 2px; margin: 20px 0 8px 0; border-bottom: 1px solid #333; padding-bottom: 4px; }
.rl-review .meta { color: #888; font-size: 11px; margin-bottom: 20px; }
.rl-review .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; margin-bottom: 16px; }
.rl-review .kpi { background: #1a1a1a; border: 1px solid #333; padding: 10px; text-align: center; }
.rl-review .kpi-label { color: #888; font-size: 10px; letter-spacing: 1px; margin-bottom: 4px; }
.rl-review .kpi-value { font-size: 20px; font-weight: bold; }
.rl-review table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
.rl-review th { background: #1a1a1a; color: #888; font-size: 10px; letter-spacing: 1px; padding: 6px 10px; text-align: left; border-bottom: 1px solid #333; }
.rl-review td { padding: 6px 10px; border-bottom: 1px solid #1e1e1e; }
.rl-review .pos { color: #00c896; }
.rl-review .neg { color: #ff4444; }
.rl-review .neutral { color: #ffaa00; }
.rl-review ul { margin: 0; padding-left: 18px; }
.rl-review ul li { margin-bottom: 6px; color: #ccc; }
.rl-review .dl-link { display: inline-block; margin-top: 12px; padding: 6px 14px; border: 1px solid #ff6b00; color: #ff6b00; text-decoration: none; font-size: 11px; letter-spacing: 1px; }
.rl-review .dl-link:hover { background: #ff6b00; color: #000; }
</style>
<div class="rl-review">
  <h1>◈ REDLINE COUNCIL — PERFORMANCE REVIEW</h1>
  <div class="meta">Generated: ${dateLabel} &nbsp;|&nbsp; Based on ${stats.resolved} resolved of ${stats.totalDecisions} total decisions</div>

  <h2>EXECUTIVE SUMMARY</h2>
  <div class="kpi-grid">
    <div class="kpi"><div class="kpi-label">WIN RATE</div><div class="kpi-value ${wrColor}">${pct(stats.winRate)}</div></div>
    <div class="kpi"><div class="kpi-label">PROFIT FACTOR</div><div class="kpi-value ${pfColor}">${num(stats.profitFactor)}</div></div>
    <div class="kpi"><div class="kpi-label">AVG WIN</div><div class="kpi-value pos">+${num(stats.avgWinPct)}%</div></div>
    <div class="kpi"><div class="kpi-label">AVG LOSS</div><div class="kpi-value neg">${num(stats.avgLossPct)}%</div></div>
    <div class="kpi"><div class="kpi-label">RESOLVED</div><div class="kpi-value">${stats.resolved}</div></div>
    <div class="kpi"><div class="kpi-label">OPEN</div><div class="kpi-value neutral">${stats.open}</div></div>
  </div>

  <h2>PERFORMANCE BY HORIZON</h2>
  <table>
    <thead><tr><th>HORIZON</th><th>DECISIONS</th><th>WIN RATE</th><th>AVG P&amp;L</th></tr></thead>
    <tbody>${hRows || '<tr><td colspan="4">No resolved decisions yet</td></tr>'}</tbody>
  </table>

  <h2>SIGNAL EFFECTIVENESS</h2>
  <table>
    <thead><tr><th>SIGNAL</th><th>DECISIONS</th><th>WIN RATE</th></tr></thead>
    <tbody>${sRows}</tbody>
  </table>

  <h2>TOP WINNERS</h2>
  <table>
    <thead><tr><th>TICKER</th><th>HORIZON</th><th>P&amp;L %</th><th>P&amp;L $</th></tr></thead>
    <tbody>${winRows || '<tr><td colspan="4">No winners yet</td></tr>'}</tbody>
  </table>

  <h2>TOP LOSERS</h2>
  <table>
    <thead><tr><th>TICKER</th><th>HORIZON</th><th>P&amp;L %</th><th>P&amp;L $</th></tr></thead>
    <tbody>${lossRows || '<tr><td colspan="4">No losses yet</td></tr>'}</tbody>
  </table>

  <h2>STRATEGIC RECOMMENDATIONS</h2>
  <ul>${recItems}</ul>

  <a class="dl-link" href="/api/reports/download/REVIEW_${dateLabel.replace(/[: ]/g,'_').replace(/,/g,'')}.docx">⬇ DOWNLOAD .DOCX</a>
</div>`;
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function loadReviewState() {
  return loadJSON(REVIEW_STATE_PATH, { lastReviewAt: null, resolvedDecisionIds: [] });
}

function saveReviewState(state) {
  writeFileSync(REVIEW_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

function hasNewResolved(decisions, state) {
  const currentResolvedIds = new Set(decisions.filter(d => d.resolved).map(d => d.id));
  const lastReviewedIds    = new Set(state.resolvedDecisionIds);
  for (const id of currentResolvedIds) {
    if (!lastReviewedIds.has(id)) return true;
  }
  return false;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Generate a performance review if new resolved decisions exist since the last run.
 * Returns the filename of the HTML report, or null if skipped (nothing new).
 *
 * @param {object} [injectedStats] - Optional pre-computed stats from reviewCouncil (Phase 3).
 *                                   If omitted, stats are computed from decisions.json directly.
 */
export async function generateReviewReport(injectedStats = null) {
  ensureDirs();

  const decisions = loadJSON(DECISIONS_PATH, []);
  const state     = loadReviewState();

  // ── Deduplication check ───────────────────────────────────────────────────
  if (!hasNewResolved(decisions, state)) {
    console.log('[ReviewReport] No new resolved decisions since last review — skipping generation.');
    return null;
  }

  const resolved = decisions.filter(d => d.resolved);
  if (resolved.length === 0) {
    console.log('[ReviewReport] No resolved decisions yet — skipping.');
    return null;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = injectedStats || computeStats(decisions);
  if (!stats) {
    console.log('[ReviewReport] Stats computation returned null — skipping.');
    return null;
  }

  // ── Filenames ─────────────────────────────────────────────────────────────
  const now       = new Date();
  const dateLabel = now.toLocaleString('en-US', { timeZone: 'America/New_York',
    month: '2-digit', day: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false }).replace(/[/, :]/g, '-');
  const baseName  = `REVIEW_${dateLabel}`;
  const htmlPath  = join(REPORTS_DIR, `${baseName}.html`);
  const docxPath  = join(REPORTS_DIR, `${baseName}.docx`);

  // ── Write HTML ────────────────────────────────────────────────────────────
  const html = buildHtml(stats, now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  writeFileSync(htmlPath, html, 'utf8');
  console.log(`[ReviewReport] HTML report saved: reports/${baseName}.html`);

  // ── Write DOCX via Python ─────────────────────────────────────────────────
  try {
    const statsJson = JSON.stringify({ stats, dateLabel: now.toLocaleString('en-US', { timeZone: 'America/New_York' }) });
    execSync(`python3 "${PYTHON_SCRIPT}" '${statsJson.replace(/'/g, "'\\''")}' "${docxPath}"`, {
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    console.log(`[ReviewReport] DOCX report saved: reports/${baseName}.docx`);
  } catch (err) {
    console.error('[ReviewReport] DOCX generation failed (HTML still saved):', err.message);
  }

  // ── Update review state ───────────────────────────────────────────────────
  saveReviewState({
    lastReviewAt:        now.toISOString(),
    lastReviewHtmlFile:  `${baseName}.html`,
    lastReviewDocxFile:  `${baseName}.docx`,
    resolvedDecisionIds: resolved.map(d => d.id),
  });

  console.log(`[ReviewReport] Review state updated — ${resolved.length} decisions captured.`);
  return `${baseName}.html`;
}

// ─── Allow direct invocation for testing ─────────────────────────────────────
// node lib/llm/council/utils/generateReviewReport.mjs --force

if (process.argv.includes('--force')) {
  const decisions = loadJSON(DECISIONS_PATH, []);
  const stats = computeStats(decisions);
  if (!stats) { console.log('No resolved decisions to review.'); process.exit(0); }
  console.log('Computed stats:', JSON.stringify(stats, null, 2));
  generateReviewReport().then(f => console.log('Generated:', f));
}
