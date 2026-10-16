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

// HYSTERESIS margin — a cross only "counts" when price clears the MA by this fraction. Price hugging
// the line (within the band) is indeterminate and fires nothing, which kills whipsaw crosses on a
// volatile name oscillating across its MA (the RIG failure). Default 0.75%; tune via MA_CROSS_MARGIN.
const MARGIN = (() => { const m = parseFloat(process.env.MA_CROSS_MARGIN ?? '0.0075'); return Number.isFinite(m) && m >= 0 ? m : 0.0075; })();

// Decisive side of price vs a moving average: 'above' / 'below', or null when inside the neutral band.
function sideOf(price, ma) {
  const p = Number(price), m = Number(ma);
  if (!Number.isFinite(p) || !Number.isFinite(m) || m <= 0) return null;
  if (p > m * (1 + MARGIN)) return 'above';
  if (p < m * (1 - MARGIN)) return 'below';
  return null; // within the band — indeterminate, don't flip
}
// Decisive MA50-vs-MA200 relationship (golden/death), null inside the band.
function maSideOf(ma50, ma200) {
  const a = Number(ma50), b = Number(ma200);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  if (a > b * (1 + MARGIN)) return 'golden';
  if (a < b * (1 - MARGIN)) return 'death';
  return null;
}

/**
 * Diff this sweep's technicals against last sweep's stored MA sides, return fresh crosses, and persist.
 * A cross fires only when price (or MA50/MA200) DECISIVELY flips sides — clearing the hysteresis band —
 * vs the last decisive reading. While price sits in the band we carry the prior side forward (no flip),
 * so line-hugging noise never generates a signal. First observation sets a baseline (nothing fires).
 * @param {object} tech  { TICKER: getSetupTechnicals(...) }
 * @returns {object}     { TICKER: [ "cross description", ... ] }
 */
export function detectMaCrosses(tech = {}) {
  const prev = loadState();
  const next = {};
  const crosses = {};

  for (const [ticker, x] of Object.entries(tech || {})) {
    if (!x || x.ma50 == null || x.ma200 == null || x.price == null) continue;
    const s50  = sideOf(x.price, x.ma50);     // fresh decisive reading, or null (in band)
    const s200 = sideOf(x.price, x.ma200);
    const sMA  = maSideOf(x.ma50, x.ma200);
    const p    = prev[ticker] || {};

    // Carry the last decisive side forward when currently in the band, so state isn't lost.
    next[ticker] = {
      side50:  s50  ?? p.side50  ?? null,
      side200: s200 ?? p.side200 ?? null,
      maCross: sMA  ?? p.maCross ?? null,
    };

    const events = [];
    if (p.side50 && s50 && s50 !== p.side50)
      events.push(s50 === 'below' ? 'lost 50-day MA (bearish)' : 'reclaimed 50-day MA (bullish)');
    if (p.side200 && s200 && s200 !== p.side200)
      events.push(s200 === 'below' ? 'lost 200-day MA — MAJOR breakdown' : 'reclaimed 200-day MA (bullish)');
    if (p.maCross && sMA && sMA !== p.maCross)
      events.push(sMA === 'death' ? 'DEATH CROSS (50MA crossed below 200MA)' : 'GOLDEN CROSS (50MA crossed above 200MA)');

    if (events.length) crosses[ticker] = events;
  }

  saveState(next);
  return crosses;
}
