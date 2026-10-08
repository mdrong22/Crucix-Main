// planReport.mjs — Report for a user plan proposal + the agent's verdict.
// Saved to /reports so it appears in the RedLine report viewer, styled like trade reports.

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const REPORT_DIR = join(process.cwd(), 'reports');

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function renderProse(text) {
  const esc = escHtml(text).trim();
  if (!esc) return '<p>—</p>';
  return esc.split(/\n{2,}/).map(b => b.trim() ? '<p>' + b.replace(/\n/g, ' ') + '</p>' : '').join('');
}

const VERDICT_COLOR = { ACCEPT: '#00C896', PARTIAL: '#FFAA00', DENY: '#FF4444' };

/**
 * @param {object} p { query, verdict, reasoning, summary, stanceUpdates, model, provider }
 * @returns {string|null} saved filename
 */
export function generatePlanReport(p = {}) {
  try { if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true }); }
  catch (err) { console.error('[PlanReport] mkdir failed:', err.message); return null; }

  const verdict = String(p.verdict || 'DENY').toUpperCase();
  const vColor = VERDICT_COLOR[verdict] || '#aaaaaa';
  const dateLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

  const updates = Array.isArray(p.stanceUpdates) ? p.stanceUpdates : [];
  const changesHtml = updates.length
    ? `<ul>${updates.map(u => `<li><strong>${escHtml((u.ticker || '').toUpperCase())}</strong> → ${escHtml(u.close ? 'REMOVED' : (u.stance || '?'))}${u.thesis ? ` — ${escHtml(u.thesis)}` : ''}${u.plan ? `<br><span style="opacity:.7">plan: ${escHtml(u.plan)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p>No changes applied.</p>';

  const html = `<style>
.rl-trade{font-family:'Courier New',monospace;color:#e0e0e0;font-size:12px;line-height:1.7}
.rl-trade-header{margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #FF6B00}
.rl-trade-title{color:#FF6B00;font-size:17px;letter-spacing:3px;font-weight:bold;margin-bottom:4px}
.rl-trade-meta{color:#666;font-size:10px}
.rl-badge{display:inline-block;padding:6px 14px;font-size:12px;letter-spacing:2px;font-weight:bold;margin-bottom:16px;border-radius:4px}
.rl-section{margin-bottom:20px}
.rl-section-title{color:#FF6B00;font-size:10px;letter-spacing:2px;font-weight:bold;border-bottom:1px solid #1e1e1e;padding-bottom:5px;margin-bottom:10px;text-transform:uppercase}
.rl-section-body{color:#ccc;font-size:11px;line-height:1.75}
.rl-section-body strong{color:#fff}.rl-section-body ul{margin:4px 0 8px 16px}.rl-section-body li{margin-bottom:5px}
.rl-divider{border:none;border-top:1px solid #1a1a1a;margin:18px 0}
</style>
<div class="rl-trade">
  <div class="rl-trade-header">
    <div class="rl-trade-title">◈ PLAN PROPOSAL — ${escHtml(p.summary || verdict)}</div>
    <div class="rl-trade-meta">Generated: ${escHtml(dateLabel)}${p.model ? ` &nbsp;|&nbsp; ${escHtml(p.provider ? p.provider + '/' : '')}${escHtml(p.model)}` : ''}</div>
  </div>
  <div class="rl-badge" style="background:${vColor}22;border:1px solid ${vColor};color:${vColor}">${verdict === 'ACCEPT' ? '✅' : verdict === 'PARTIAL' ? '〜' : '⛔'} ${verdict}</div>
  <div class="rl-section"><div class="rl-section-title">Your Proposal</div><div class="rl-section-body">${renderProse(p.query)}</div></div>
  <div class="rl-section"><div class="rl-section-title">Claude's Decision</div><div class="rl-section-body">${renderProse(p.reasoning)}</div></div>
  <hr class="rl-divider">
  <div class="rl-section"><div class="rl-section-title">Applied Changes</div><div class="rl-section-body">${changesHtml}</div></div>
</div>`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `${timestamp}_PLAN_Report.html`;
  try {
    writeFileSync(join(REPORT_DIR, fileName), html, 'utf8');
    console.log(`[PlanReport] 📂 Saved: ${fileName}`);
    return fileName;
  } catch (err) { console.error('[PlanReport] write failed:', err.message); return null; }
}
