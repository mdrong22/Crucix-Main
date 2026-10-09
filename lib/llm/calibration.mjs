/**
 * calibration.mjs — Is the agent's stated confidence honest?
 *
 * For every resolved trade we stored the confidence (0-100) the agent claimed at decision time
 * (decisions.json → signals.confidence). This module buckets those by confidence band and compares
 * the CLAIMED probability to the REALIZED win rate, so the agent can see whether its "85%" calls
 * actually win ~85% of the time — and correct the gap. Two outputs:
 *   - buildCalibration()        → structured object for the dashboard / API
 *   - formatCalibrationForLLM() → one compact self-correction line injected into the agent context
 *
 * Brier score = mean squared error of the probability forecasts (win=1 / loss=0 / breakeven=0.5):
 * 0 = perfect, 0.25 = coin-flip, lower is better. The single scalar for "how well-calibrated am I?".
 *
 * Reuses runs/decisions.json via loadDecisions() — same source of truth as the track record.
 */

import { loadDecisions } from './council/utils/decisionLogger.mjs';

// Need a minimum sample of resolved calls that actually carried a confidence before calibration means
// anything — don't let the agent over-correct off 1-2 trades.
const MIN_CALIB = parseInt(process.env.CALIBRATION_MIN ?? '4', 10);

const BANDS = [
  { label: '<60%',   min: 0,  max: 59  },
  { label: '60-74%', min: 60, max: 74  },
  { label: '75-84%', min: 75, max: 84  },
  { label: '85%+',   min: 85, max: 100 },
];

function confOf(d) {
  const c = Number(d?.signals?.confidence);
  return Number.isFinite(c) ? c : null;
}

// win → it happened (1), loss → it didn't (0), breakeven → half-credit.
function actualOf(d) {
  return d.outcome === 'win' ? 1 : d.outcome === 'loss' ? 0 : 0.5;
}

/**
 * Compute calibration stats over resolved decisions that carried a stated confidence.
 * @returns {{ok:false, reason, n?}} | {{ok:true, n, brier, bands, overallWin, meanStated}}
 */
export function buildCalibration() {
  let decisions = [];
  try { decisions = loadDecisions(); } catch { return { ok: false, reason: 'no decisions yet' }; }

  const sample = decisions.filter(d =>
    d.resolved && confOf(d) != null && ['win', 'loss', 'breakeven'].includes(d.outcome));

  if (sample.length < MIN_CALIB) {
    return { ok: false, n: sample.length,
      reason: `need ${MIN_CALIB} resolved calls with a stated confidence (have ${sample.length})` };
  }

  const brier = sample.reduce((s, d) => {
    const p = confOf(d) / 100, a = actualOf(d);
    return s + (p - a) * (p - a);
  }, 0) / sample.length;

  const bands = BANDS.map(b => {
    const ds       = sample.filter(d => { const c = confOf(d); return c >= b.min && c <= b.max; });
    const decisive = ds.filter(d => d.outcome === 'win' || d.outcome === 'loss');
    const wins     = decisive.filter(d => d.outcome === 'win').length;
    const realized = decisive.length ? wins / decisive.length : null;   // 0-1
    const stated   = ds.length ? ds.reduce((s, d) => s + confOf(d), 0) / ds.length : null; // 0-100
    return {
      label: b.label,
      n: ds.length,
      stated,
      realized,
      gap: (realized != null && stated != null) ? (realized * 100 - stated) : null,  // +under / -over
    };
  });

  const decisiveAll = sample.filter(d => d.outcome === 'win' || d.outcome === 'loss');
  const overallWin  = decisiveAll.length ? decisiveAll.filter(d => d.outcome === 'win').length / decisiveAll.length : null;
  const meanStated  = sample.reduce((s, d) => s + confOf(d), 0) / sample.length;

  return { ok: true, n: sample.length, brier, bands, overallWin, meanStated };
}

/**
 * One compact self-correction line for the analyst context, or '' until enough history exists.
 * Leads with the Brier score, then calls out systemic over/under-confidence and the single
 * worst-calibrated band.
 */
export function formatCalibrationForLLM() {
  const c = buildCalibration();
  if (!c.ok) return '';

  const parts = [`Brier ${c.brier.toFixed(2)} over ${c.n} resolved calls (0=perfect, 0.25=coin-flip)`];

  if (c.overallWin != null) {
    const diff = c.overallWin * 100 - c.meanStated;
    if (diff <= -10)      parts.push(`you claim ~${c.meanStated.toFixed(0)}% on average but win ${(c.overallWin * 100).toFixed(0)}% — OVERCONFIDENT, mark your numbers down`);
    else if (diff >= 10)  parts.push(`you claim ~${c.meanStated.toFixed(0)}% on average but win ${(c.overallWin * 100).toFixed(0)}% — UNDERCONFIDENT, you can trust strong setups more`);
  }

  // Single worst-calibrated band with a real sample.
  const bad = c.bands
    .filter(b => b.n >= 3 && b.gap != null)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))[0];
  if (bad && Math.abs(bad.gap) >= 15) {
    if (bad.gap < 0) parts.push(`your ${bad.label} calls actually win only ${(bad.realized * 100).toFixed(0)}% — reserve ${bad.label} for truly confirmed setups`);
    else             parts.push(`your ${bad.label} calls win ${(bad.realized * 100).toFixed(0)}% — those deserve more conviction/size`);
  }

  return parts.join('; ') + '.';
}
