// maCrossStore.mjs — Moving-average CROSS detection for held/watched tickers.
//
// POSITION_TECHNICALS tells the agent price is *below* an MA; this tells it price just *crossed* one
// THIS sweep — the actionable event (a fresh breakdown or reclaim), not a static state. It persists each
// sweep's MA position per ticker to runs/ma-state.json and diffs against it next sweep.
//
// Detects, per ticker:
//   • price crossing its 50-day MA  (lost / reclaimed MA50)
//   • price crossing its 200-day MA (lost / reclaimed MA200 — major)
//   • MA50 crossing MA200           (death cross / golden cross — the classic trend-change signal)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR  = join(__dirname, '../../runs');
const PATH      = join(RUNS_DIR, 'ma-state.json');

function loadState() {
  try { return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}; }
  catch { return {}; }
}
function saveState(state) {
  try {
    if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
    writeFileSync(PATH, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) { console.warn('[MACross] save failed:', err.message); }
}

// Current MA position for one ticker's technicals. Returns null if data is insufficient.
function positionOf(x) {
  if (!x || x.ma50 == null || x.ma200 == null || x.price == null) return null;
  return {
    belowMA50:   !!x.belowMA50,
    belowMA200:  !!x.belowMA200,
    ma50AboveMA200: Number(x.ma50) > Number(x.ma200),
  };
}

/**
 * Diff this sweep's technicals against last sweep's stored MA positions, return fresh crosses, and
 * persist the new state. First time a ticker is seen there is no prior, so nothing fires (we just store).
 * @param {object} tech  { TICKER: getSetupTechnicals(...) }  — this sweep's per-position technicals
 * @returns {object}     { TICKER: [ "cross description", ... ] }  — only tickers with a cross this sweep
 */
export function detectMaCrosses(tech = {}) {
  const prev = loadState();
  const next = {};
  const crosses = {};

  for (const [ticker, x] of Object.entries(tech || {})) {
    const cur = positionOf(x);
    if (!cur) continue;
    next[ticker] = cur;

    const p = prev[ticker];
    if (!p) continue; // no baseline yet — record and wait for the next sweep

    const events = [];
    // Price vs MA50
    if (p.belowMA50 === false && cur.belowMA50 === true) events.push('lost 50-day MA (bearish)');
    else if (p.belowMA50 === true && cur.belowMA50 === false) events.push('reclaimed 50-day MA (bullish)');
    // Price vs MA200 (major)
    if (p.belowMA200 === false && cur.belowMA200 === true) events.push('lost 200-day MA — MAJOR breakdown');
    else if (p.belowMA200 === true && cur.belowMA200 === false) events.push('reclaimed 200-day MA (bullish)');
    // MA50 vs MA200 (death / golden cross)
    if (p.ma50AboveMA200 === true && cur.ma50AboveMA200 === false) events.push('DEATH CROSS (50MA crossed below 200MA)');
    else if (p.ma50AboveMA200 === false && cur.ma50AboveMA200 === true) events.push('GOLDEN CROSS (50MA crossed above 200MA)');

    if (events.length) crosses[ticker] = events;
  }

  saveState(next);
  return crosses;
}
