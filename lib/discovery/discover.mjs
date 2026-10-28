// discover.mjs — Phase 1 stock discovery: harvest a market-wide candidate universe from the tickers the
// sweep's signals ALREADY name, score each by the bullish/bearish signals it triggered, and hand the
// agent a ranked NEW-BUY shortlist (MARKET_SETUPS). Every source here already scans the whole market —
// this just harvests their tickers instead of discarding them, so discovery costs ~zero extra API calls.
//
// Two passes:
//   harvestAndScore(data)  — pre-enrichment composite score from catalyst signals (who to enrich).
//   annotateBoard(scored)  — fold in the deep enrichment (chart setup, news, insider/13F selling) + rank.

const isTicker = t => /^[A-Z]{1,5}$/.test(String(t || '').toUpperCase());
const UP = t => String(t || '').toUpperCase().trim();

/**
 * Build a scored candidate list from the signals in a synthesized sweep.
 * @param {object} data        synthesized sweep
 * @param {object} [opts]
 * @param {Set}    [opts.exclude]  tickers to drop (e.g. names already held — discovery is for NEW names)
 * @param {Array}  [opts.ideas]    ideas list (defaults to data.ideas; pass lastGoodIdeas when current not ready)
 * @returns {Array<{ticker,score,signals:string[]}>}  positive-score candidates, highest first
 */
export function harvestAndScore(data = {}, opts = {}) {
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set();
  const ideas   = Array.isArray(opts.ideas) ? opts.ideas : (Array.isArray(data.ideas) ? data.ideas : []);
  const cands   = new Map();

  const add = (ticker, pts, label) => {
    const t = UP(ticker);
    if (!isTicker(t) || exclude.has(t)) return;
    const c = cands.get(t) || { ticker: t, score: 0, signals: [] };
    c.score += pts;
    if (label && !c.signals.includes(label)) c.signals.push(label);
    cands.set(t, c);
  };

  // ── Bullish catalysts ──────────────────────────────────────────────────────
  for (const b of data.congress?.topBuys || [])                       // congressional cluster buys (strong)
    add(b.ticker, 3 + Math.min(Number(b.memberCount) || 0, 4), `cluster-buy(${b.memberCount ?? '?'})`);
  for (const a of data.congress?.insiderAlerts || [])                 // known-member insider BUY
    if (String(a.tag || '').toUpperCase() === 'BUY')
      for (const tk of String(a.tickers || '').split(/[,\s]+/)) add(tk, 3, 'congress-insider-buy');
  for (const b of data.finnhub?.insiderBuys || [])                    // exec/director buys
    add(b.ticker, (Number(b.value) || 0) > 100000 ? 3 : 2, 'insider-buy');
  for (const u of data.congress?.upgradesDowngrades?.upgrades || []) add(u.ticker, 2, `upgrade(${u.toGrade || ''})`);
  for (const o of data.benzinga?.optionsFlow?.bullish || [])         add(o.ticker, 2, 'bullish-sweep');
  for (const f of data.sec?.eightKFilings || [])                     add(f.ticker, 1, '8-K');
  // Gainers scaled by magnitude — a big one-day move is a far stronger "something happened here" signal
  // than a small wiggle, so a real catalyst mover (ORCL +12% on guidance) clears the board while a +3%
  // twitch (RIG) stays filtered. News on the mover (pulled below) then lets the agent judge chase vs re-rate.
  for (const m of data.movers?.gainers || []) {
    const chg = Math.abs(m.changePct || 0);
    const pts = chg >= 10 ? 3 : chg >= 6 ? 2 : 1;
    add(m.ticker, pts, `gainer+${(m.changePct || 0).toFixed(0)}%`);
  }
  for (const m of data.movers?.losers  || [])                        add(m.ticker, 1, `discount${(m.changePct || 0).toFixed(0)}%`);
  for (const th of data.theses || []) {                              // forward-paced thesis targets (policy/geo catalysts flow in here)
    const pts = /HIGH/i.test(th.inevitability) ? 3 : /MED/i.test(th.inevitability) ? 2 : 1;
    for (const tk of th.targetTickers || []) add(tk, pts, `thesis:${String(th.trend || '').slice(0, 18)}`);
  }
  for (const i of ideas) if (String(i.type || '').toUpperCase() === 'LONG')
    add(i.ticker, /HIGH/i.test(i.confidence) ? 2 : 1, 'idea');

  // ── Bearish catalysts (down-weight) ────────────────────────────────────────
  for (const u of data.congress?.upgradesDowngrades?.downgrades || []) add(u.ticker, -2, 'downgrade');
  for (const o of data.benzinga?.optionsFlow?.bearish || [])           add(o.ticker, -2, 'bearish-sweep');

  // Earnings within the window — a binary event flag (not a directional score) on names already in play.
  for (const e of data.finnhub?.earnings || []) if (cands.has(UP(e.ticker))) add(e.ticker, 0, `earnings ${e.date}`);

  return [...cands.values()].filter(c => c.score > 0).sort((a, b) => b.score - a.score);
}

/**
 * Fold the deep enrichment (technical setup, news, insider/13F selling) into the scored candidates and
 * re-rank. Produces the final board objects the digest renders.
 * @param {Array}  scored                 harvestAndScore output
 * @param {object} enrich  { positionTech, positionNews, insiderSells, institutionalSells }
 * @returns {Array<{ticker,score,setup,signals,techStr,newsHeadline,flags}>}
 */
export function annotateBoard(scored = [], enrich = {}) {
  const { positionTech = {}, positionNews = {}, insiderSells = {}, institutionalSells = {} } = enrich;

  return scored.map(c => {
    const tech  = positionTech[c.ticker] || null;
    const flags = [];
    let score   = c.score;

    // Bearish enrichment adjustments — a strong catalyst with execs/funds dumping or a broken chart
    // should fall down the board, not top it.
    if (insiderSells[c.ticker])       { score -= 2; flags.push('insider-selling'); }
    if (institutionalSells[c.ticker]) { score -= 1; flags.push('13F-cut'); }
    // Counter-trend: a long below its 200-day MA is swimming upstream (RIG's "reclaim" was still sub-200MA).
    // Allowed, but it needs more conviction to clear the board — downgrade, don't ban (a real earned
    // discount can still rank if the catalyst is strong enough).
    if (tech?.belowMA200) { score -= 1; flags.push('counter-trend(<200MA)'); }
    if (tech?.belowMA50 && (tech.ret1m ?? 0) < 0) { score -= 1; flags.push('below-50MA/downtrend'); }

    const setup = tech?.setup && tech.setup !== 'NONE' ? tech.setup : null;
    if (setup === 'STRONG') score += 2; else if (setup === 'BUILDING') score += 1;

    const techStr = tech
      ? `${tech.belowMA200 ? '<200MA' : tech.belowMA50 ? '<50MA' : '>MAs'}, RSI ${tech.rsi ?? '?'}${tech.rsVsSpy != null ? `, RS ${tech.rsVsSpy >= 0 ? '+' : ''}${tech.rsVsSpy}` : ''}`
      : 'no chart';
    const newsHeadline = positionNews[c.ticker]?.[0]?.headline || '';

    return { ticker: c.ticker, score, setup, signals: c.signals, techStr, newsHeadline, flags };
  }).sort((a, b) => b.score - a.score);
}
