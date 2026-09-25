/**
 * tradeReport.mjs — Per-Trade Report (single-agent model)
 *
 * Replaces the old council `generateLocalReport` (which parsed a Scout/Phi/Theta/Gregor
 * post-mortem transcript that no longer exists). When a proposal EXECUTES — whether via a
 * manual Accept or Auto-Trade — this renders a self-contained HTML report of the agent's
 * decision (thesis, trade params, confidence, hard stop) and saves it to /reports, where the
 * RedLine dashboard report viewer renders it inline.
 *
 * Output filename: YYYY-MM-DDTHH-mm-ss_SYMBOL_Report.html  (same convention the viewer expects)
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const REPORT_DIR = join(process.cwd(), 'reports');

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Minimal markdown → HTML for the thesis/desc: **bold**, bullet lines, paragraph breaks.
function renderProse(text) {
  const esc = escHtml(text).trim();
  if (!esc) return '<p>—</p>';
  return esc
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .split(/\n{2,}/)
    .map(b => {
      const t = b.trim();
      if (!t) return '';
      return /^<(ul|li|h[1-6])/.test(t) ? t : '<p>' + t.replace(/\n/g, ' ') + '</p>';
    })
    .join('');
}

function kpi(label, value, color = '#e0e0e0') {
  return `<div class="rl-kpi"><div class="rl-kpi-label">${label}</div><div class="rl-kpi-value" style="color:${color}">${escHtml(value)}</div></div>`;
}

/**
 * Render + persist a trade report for an executed proposal.
 *
 * @param {object} proposal  the executed proposal (title, desc, ticker, side, action, horizon,
 *                           confidence, order_type, price, units, notional_value, stopLoss)
 * @param {object} [opts]    { auto:boolean, orderId:string|null }
 * @returns {string|null}    the saved filename, or null on failure
 */
export function generateTradeReport(proposal, opts = {}) {
  if (!proposal?.ticker) return null;

  try {
    if (!existsSync(REPORT_DIR)) mkdirSync(REPORT_DIR, { recursive: true });
  } catch (err) {
    console.error('[TradeReport] Failed to create reports dir:', err.message);
    return null;
  }

  const symbol = String(proposal.ticker).toUpperCase();
  const side   = String(proposal.side || 'BUY').toUpperCase();
  const sideColor = side === 'SELL' ? '#FF6B00' : '#00C896';
  const mode   = opts.auto ? 'AUTO-TRADE' : 'MANUAL (approved)';
  const conf   = Number.isFinite(Number(proposal.confidence)) ? `${Math.round(Number(proposal.confidence))}%` : (proposal.confidence || '—');

  const priceStr = proposal.price ? `$${proposal.price}` : (proposal.order_type === 'Market' ? 'MARKET' : 'TBD');
  const qtyStr   = proposal.units ? `${proposal.units}` : (proposal.notional_value ? `$${proposal.notional_value}` : '—');
  const stopStr  = proposal.stopLoss ? `$${proposal.stopLoss}` : '—';

  const kpiBar = `
    <div class="rl-kpi-grid">
      ${kpi('TICKER', symbol, '#FF6B00')}
      ${kpi('SIDE', side, sideColor)}
      ${kpi('CONFIDENCE', conf, '#7ED4AD')}
      ${kpi('HORIZON', proposal.horizon || '—')}
      ${kpi('ORDER', `${proposal.order_type || 'Limit'} @ ${priceStr}`)}
      ${kpi('QTY', qtyStr)}
      ${kpi('HARD STOP', stopStr, proposal.stopLoss ? '#FF4444' : '#e0e0e0')}
      ${kpi('TIF', proposal.time_in_force || '—')}
    </div>`;

  const stopSection = proposal.stopLoss
    ? `<div class="rl-section"><div class="rl-section-title">Hard Stop</div><div class="rl-section-body"><p>Auto-sells at <strong>$${escHtml(proposal.stopLoss)}</strong> without approval if breached — the thesis is invalidated below this level.</p></div></div>`
    : '';

  const dateLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const actionLabel = proposal.action === 'MAINTENANCE' ? 'PORTFOLIO MAINTENANCE' : 'NEW POSITION';

  const html = `<style>
.rl-trade{font-family:'Courier New',monospace;color:#e0e0e0;font-size:12px;line-height:1.7}
.rl-trade-header{margin-bottom:20px;padding-bottom:12px;border-bottom:1px solid #FF6B00}
.rl-trade-title{color:#FF6B00;font-size:17px;letter-spacing:3px;font-weight:bold;margin-bottom:4px}
.rl-trade-meta{color:#666;font-size:10px}
.rl-kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;margin-bottom:20px}
.rl-kpi{background:#111;border:1px solid #222;padding:8px 10px;text-align:center}
.rl-kpi-label{color:#555;font-size:9px;letter-spacing:1px;margin-bottom:3px}
.rl-kpi-value{font-size:17px;font-weight:bold}
.rl-section{margin-bottom:20px}
.rl-section-title{color:#FF6B00;font-size:10px;letter-spacing:2px;font-weight:bold;
  border-bottom:1px solid #1e1e1e;padding-bottom:5px;margin-bottom:10px;text-transform:uppercase}
.rl-section-body{color:#ccc;font-size:11px;line-height:1.75}
.rl-section-body p{margin-bottom:8px}
.rl-section-body strong{color:#fff}
.rl-section-body ul{margin:4px 0 8px 16px;padding:0}
.rl-section-body li{margin-bottom:3px;color:#bbb}
.rl-divider{border:none;border-top:1px solid #1a1a1a;margin:18px 0}
</style>
<div class="rl-trade">
  <div class="rl-trade-header">
    <div class="rl-trade-title">◈ TRADE REPORT — ${escHtml(symbol)}</div>
    <div class="rl-trade-meta">Generated: ${escHtml(dateLabel)} &nbsp;|&nbsp; ${escHtml(actionLabel)} &nbsp;|&nbsp; ${escHtml(mode)}${opts.orderId ? ` &nbsp;|&nbsp; Order ${escHtml(opts.orderId)}` : ''}</div>
  </div>
  ${kpiBar}
  <hr class="rl-divider">
  <div class="rl-section">
    <div class="rl-section-title">${escHtml(proposal.title || `${side} ${symbol}`)}</div>
    <div class="rl-section-body">${renderProse(proposal.desc)}</div>
  </div>
  ${stopSection}
</div>`;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName  = `${timestamp}_${symbol}_Report.html`;

  try {
    writeFileSync(join(REPORT_DIR, fileName), html, 'utf8');
    console.log(`[TradeReport] 📂 Saved: ${fileName}`);
    return fileName;
  } catch (err) {
    console.error('[TradeReport] Failed to write report:', err.message);
    return null;
  }
}
