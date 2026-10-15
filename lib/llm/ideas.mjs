// LLM-Powered Trade Ideas — generates actionable ideas from sweep data + delta context

import { DataCleaner } from "./council/utils/cleaner.mjs";

/**
 * Generate LLM-enhanced trade ideas from sweep data.
 * @param {LLMProvider} provider - configured LLM provider
 * @param {object} sweepData - synthesized dashboard data
 * @param {object|null} delta - delta from last sweep
 * @param {Array} previousIdeas - ideas from previous runs (for dedup)
 * @param {Array} userPortfolio - users profile from robinhood/Other Firm
 * @returns {Promise<Array>} - array of idea objects
 */
export async function generateLLMIdeas(provider, sweepData, delta, previousIdeas = [], userPort, accountOrders, fallbackProvider = null) {
  if (!provider?.isConfigured) return null;

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return null;
  }

  const userPortfolio = DataCleaner.stringifyPortfolio(userPort);
  // Portfolio and orders go in the user-context message, not the system prompt.
  // System prompt is cached by providers — injecting volatile data into it defeats caching and wastes tokens.
  const userContext = [
    userPortfolio ? `PORTFOLIO: ${userPortfolio}` : '',
    accountOrders  ? `ACCOUNT_ORDERS: ${accountOrders}` : '',
    context,
  ].filter(Boolean).join('\n');

  const systemPrompt = `Quant analyst at a macro intelligence firm. From OSINT + economic data, produce 5-8 actionable trade ideas.
Rules: cite specific data | name instruments (tickers, ETFs) not sectors | lead with delta changes | skip PREV_IDEAS repeats unless conditions changed | HIGH=multiple confirming signals, MEDIUM=supported, LOW=speculative
Output ONLY valid JSON array:
[{"title":"<10 words>","type":"LONG|SHORT|HEDGE|WATCH|AVOID","ticker":"","confidence":"HIGH|MEDIUM|LOW","rationale":"2-3 sentences citing data","risk":"key risk","horizon":"Intraday|Days|Weeks|Months","signals":["s1","s2"]}]`;

  // 5-8 ideas with rationale + signals need headroom — 1024 truncated the JSON array mid-stream,
  // producing "no parseable ideas" even on a successful call.
  const IDEAS_MAX_TOKENS = 2048;
  const contextTokenEstimate = Math.round(context.length / 4);
  console.log(`[LLM Ideas] Context ~${contextTokenEstimate} tokens → ${provider.name}/${provider.model}`);

  // ── Primary provider ───────────────────────────────────────────────────────
  let primaryRateLimited = false;
  try {
    const result = await provider.complete(systemPrompt, userContext, { maxTokens: IDEAS_MAX_TOKENS, timeout: 60000 });
    console.log(`[LLM Ideas] ✅ Primary OK — input: ${result.usage?.inputTokens ?? '?'} tokens, output: ${result.usage?.outputTokens ?? '?'} tokens`);
    const ideas = parseIdeasResponse(result.text);
    if (ideas && ideas.length > 0) return { llmIdeas: ideas, context };
    console.warn('[LLM Ideas] Primary returned no parseable ideas — trying fallback.');
  } catch (err) {
    primaryRateLimited = !!err.isRateLimit;
    console.warn(`[LLM Ideas] Primary provider failed${primaryRateLimited ? ' (RATE LIMITED)' : ''}: ${err.message} — trying fallback.`);
  }

  // ── Fallback provider (Groq / other cross-API provider) ────────────────────
  // This is the correct escape valve for Gemini rate limits — different API,
  // different quota. If GROQ_FALLBACK_KEY is unset, this is skipped and the
  // sweep returns null for ideas (non-fatal — sweep continues without ideas).
  if (fallbackProvider?.isConfigured) {
    try {
      console.log(`[LLM Ideas] ⚡ Retrying with fallback: ${fallbackProvider.name} / ${fallbackProvider.model}${primaryRateLimited ? ' (primary was rate limited)' : ''}`);
      const result = await fallbackProvider.complete(systemPrompt, userContext, { maxTokens: IDEAS_MAX_TOKENS, timeout: 45000 });
      const ideas = parseIdeasResponse(result.text);
      if (ideas && ideas.length > 0) {
        console.log(`[LLM Ideas] ✅ Fallback succeeded — ${ideas.length} ideas via ${fallbackProvider.model}.`);
        return { llmIdeas: ideas, context };
      }
      console.warn('[LLM Ideas] Fallback also returned no parseable ideas.');
    } catch (err) {
      console.error(`[LLM Ideas] Fallback also failed: ${err.message}`);
    }
  } else if (primaryRateLimited) {
    console.warn('[LLM Ideas] ⚠ Primary rate limited but no cross-API fallback configured. Set GROQ_FALLBACK_KEY to enable Groq fallback.');
  }

  return null;
}

export async function runPortfolioBrief(provider, sweepData, delta, previousIdeas = [], userPort, accountOrders) {
  if (!provider?.isConfigured) return null;

  let context;
  try {
    context = compactSweepForLLM(sweepData, delta, previousIdeas);
  } catch (err) {
    console.error('[LLM Ideas] Failed to compact sweep data:', err.message);
    return null;
  }

  const userPortfolio = DataCleaner.stringifyPortfolio(userPort);
  const portfolioContext = [
    userPortfolio ? `PORTFOLIO: ${userPortfolio}` : '',
    accountOrders ? `ACCOUNT_ORDERS: ${accountOrders}` : '',
    context,
  ].filter(Boolean).join('\n');

  const systemPrompt = `Quant analyst at a macro intelligence firm. Produce a concise portfolio brief from the user's holdings, orders, and OSINT + economic data.
Rules: cite specific data | only include stocks relevant to today's signals | skip penny stocks and closed positions | 2-3 sentences max per stock.
Format: fun title + separate section per relevant stock (BUY/SELL/HOLD + 2-3 sentence reasoning). Include a short macro summary at top.`;

  try {
    return await provider.complete(systemPrompt, portfolioContext, { maxTokens: 2048, timeout: 60000 });
  } catch (err) {
    console.error('[LLM PORTFOLIO BRIEF] Generation failed:', err.message);
    return null;
  }
}

/**
 * Compact sweep data to ~8KB for token efficiency.
 * Exported so server.mjs can rebuild context on throttled sweeps without re-running the LLM.
 */
export function compactSweepForLLM(data, delta, previousIdeas) {
  const sections = [];

  // Fresh MA CROSSES this sweep — the single most actionable technical event: price just crossed its
  // 50/200-day MA, or a death/golden cross fired. Lead with it so a trend-change on a held name is the
  // first thing the agent sees.
  if (data.maCrosses && Object.keys(data.maCrosses).length) {
    const xLines = Object.entries(data.maCrosses).slice(0, 15)
      .map(([t, events]) => `${t}: ${(events || []).join('; ')}`);
    if (xLines.length) sections.push(`⚠ MA_CROSS (JUST crossed this sweep — act on trend changes on YOUR names): ${xLines.join(' | ')}`);
  }

  // Company-specific news on the agent's OWN holdings/watchlist — highest priority, because a single
  // position's catalyst (a court ruling, permit loss, earnings date, insider selling) is exactly what a
  // macro sweep misses and what breaks a thesis. Lead with it so the agent always checks its positions.
  if (data.positionNews && Object.keys(data.positionNews).length) {
    const _hl = s => { const t = String(s || '').trim(); return t.length > 90 ? t.slice(0, 90) + '…' : t; };
    const posLines = Object.entries(data.positionNews).slice(0, 12).map(([t, items]) => {
      const hl = (items || []).slice(0, 3).map(n => _hl(n.headline)).filter(Boolean).join(' / ');
      return hl ? `${t}: ${hl}` : '';
    }).filter(Boolean);
    if (posLines.length) sections.push(`POSITION_NEWS (company-specific news on YOUR holdings/watchlist — scan for thesis-breaks):\n${posLines.join('\n')}`);
  }

  // Insider SELLING on held/watched names — a direct bearish signal on something you own (executives
  // reducing exposure). Aggregated per ticker: how many filings/sellers, shares, and $ value.
  if (data.insiderSells && Object.keys(data.insiderSells).length) {
    const sellLines = Object.entries(data.insiderSells).slice(0, 12).map(([t, s]) => {
      const _v = Number(s?.value) || 0;
      const val = _v >= 1e6 ? `~$${(_v / 1e6).toFixed(1)}M` : _v > 0 ? `~$${(_v / 1000).toFixed(0)}k` : '';
      const sh  = Number(s?.shares) > 0 ? `${Number(s.shares).toLocaleString()} sh` : '';
      const who = Number(s?.sellers) > 0 ? `${s.sellers} insider(s)` : '';
      const bits = [who, sh, val].filter(Boolean).join(', ');
      return `${t}: ${bits}${s?.lastDate ? ` (latest ${s.lastDate})` : ''}`;
    }).filter(Boolean);
    if (sellLines.length) sections.push(`INSIDER_SELLS (executives reducing YOUR holdings — bearish, weigh against the thesis): ${sellLines.join(' | ')}`);
  }

  // 13F INSTITUTIONAL selling — funds/institutions reducing stakes in the latest quarterly filing. Slower
  // (quarterly-lagged) than corporate insiders but heavier money; net reducers>adders is a distribution sign.
  if (data.institutionalSells && Object.keys(data.institutionalSells).length) {
    const instLines = Object.entries(data.institutionalSells).slice(0, 12).map(([t, s]) => {
      const sh   = Number(s?.sharesReduced) > 0 ? `${Number(s.sharesReduced).toLocaleString()} sh cut` : '';
      const who  = Number(s?.reducers) > 0 ? `${s.reducers} reducing vs ${s?.adders ?? 0} adding` : '';
      const top  = Array.isArray(s?.topSellers) && s.topSellers.length ? `top: ${s.topSellers.join(', ')}` : '';
      const bits = [who, sh, top].filter(Boolean).join('; ');
      return `${t}: ${bits}${s?.period ? ` (${s.period})` : ''}`;
    }).filter(Boolean);
    if (instLines.length) sections.push(`INSTITUTIONAL_SELLS (13F — funds reducing stakes, quarterly-lagged; net reducers>adders = distribution): ${instLines.join(' | ')}`);
  }

  // Per-position TECHNICALS — price vs 50/200-day MA, RSI, trend. This is what flags a moving-average
  // REVERSAL on a held name (breakdown below MA50/MA200 with momentum rolling over) that macro movers miss.
  if (data.positionTech && Object.keys(data.positionTech).length) {
    const techLines = Object.entries(data.positionTech).slice(0, 15).map(([t, x]) => {
      const ma50  = x.ma50  != null ? `MA50 $${x.ma50} ${x.belowMA50 ? '↓below' : '↑above'}` : '';
      const ma200 = x.ma200 != null ? `MA200 $${x.ma200} ${x.belowMA200 ? '↓below' : '↑above'}` : '';
      const rsi   = x.rsi   != null ? `RSI ${x.rsi}` : '';
      const rets  = `1m ${(x.ret1m ?? 0) >= 0 ? '+' : ''}${x.ret1m ?? '?'}%, 3m ${(x.ret3m ?? 0) >= 0 ? '+' : ''}${x.ret3m ?? '?'}%`;
      const h52   = x.pctFrom52wHigh != null ? `${x.pctFrom52wHigh}% vs 52wk high` : '';
      const flags = [];
      if (x.belowMA200) flags.push('below 200MA (major breakdown)');
      else if (x.belowMA50) flags.push('below 50MA');
      if (x.belowMA50 && (x.ret1m ?? 0) < 0) flags.push('downtrend');
      const flag = flags.length ? ` [⚠ ${flags.join(', ')}]` : (x.aboveStack ? ' [uptrend intact]' : '');
      return `${t}: $${x.price} | ${[ma50, ma200, rsi].filter(Boolean).join(', ')} | ${rets} | ${h52}${flag}`;
    });
    sections.push(`POSITION_TECHNICALS (price vs moving averages + trend on YOUR holdings/watchlist — watch for MA reversals):\n${techLines.join('\n')}`);
  }

  // Economic indicators
  if (data.fred?.length) {
    const key = data.fred.filter(f => ['VIXCLS', 'DFF', 'DGS10', 'DGS2', 'T10Y2Y', 'BAMLH0A0HYM2', 'DTWEXBGS', 'MORTGAGE30US'].includes(f.id));
    sections.push(`ECONOMIC: ${key.map(f => `${f.id}=${f.value}${f.momChange ? ` (${f.momChange > 0 ? '+' : ''}${f.momChange})` : ''}`).join(', ')}`);
  }

  // Energy — render only the fields that actually arrived; a half-failed EIA pull must never
  // leak "Brent=$undefined" into the prompt (a bad read the agent can't distinguish from real data).
  if (data.energy) {
    const e = data.energy;
    const _en = [];
    if (e.wti != null)         _en.push(`WTI=$${e.wti}`);
    if (e.brent != null)       _en.push(`Brent=$${e.brent}`);
    if (e.natgas != null)      _en.push(`NatGas=$${e.natgas}`);
    if (e.crudeStocks != null) _en.push(`CrudeStocks=${e.crudeStocks}bbl`);
    if (_en.length) sections.push(`ENERGY: ${_en.join(', ')}`);
    // EIA inventory draw/build signals — large weekly moves are market-moving for energy stocks
    if (e.signals?.length) {
      sections.push(`EIA_SIGNALS: ${e.signals.slice(0, 3).join(' | ')}`);
    }
  }

  // Market moves today — yfinance pre-market / intraday % change for macro assets
  // Moves ≥1.5% on SPY/QQQ/commodities are the strongest INTRADAY catalyst signal
  const _mktGaps = [
    ...(data.markets?.indexes     || []),
    ...(data.markets?.commodities || []),
    ...(data.markets?.rates       || []),
  ].filter(q => Math.abs(q.changePct || 0) >= 1.5)
   .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
   .slice(0, 8);
  if (_mktGaps.length) {
    sections.push(`MARKET_MOVES: ${_mktGaps.map(q => `${q.symbol}${q.changePct >= 0 ? '+' : ''}${q.changePct?.toFixed(1)}%`).join(' | ')}`);
  }

  // Metals
  if (data.metals?.gold != null || data.metals?.silver != null) {
    const gold = data.metals?.gold != null ? `$${data.metals.gold}` : 'n/a';
    const silver = data.metals?.silver != null ? `$${data.metals.silver}` : 'n/a';
    const goldChg = data.metals?.goldChangePct != null ? ` (${data.metals.goldChangePct >= 0 ? '+' : ''}${data.metals.goldChangePct}%)` : '';
    const silverChg = data.metals?.silverChangePct != null ? ` (${data.metals.silverChangePct >= 0 ? '+' : ''}${data.metals.silverChangePct}%)` : '';
    sections.push(`METALS: Gold=${gold}${goldChg}, Silver=${silver}${silverChg}`);
  }

  // Presidential / executive actions — leading policy catalyst (sector-mapped)
  if (data.policy?.signals?.length) {
    sections.push(`POLICY_ACTIONS: ${data.policy.signals.slice(0, 5).join(' | ')}`);
  }

  // Market-wide dislocations — biggest losers (discount candidates) + gainers (momentum)
  if (data.movers?.available) {
    const losers  = (data.movers.losers  || []).slice(0, 6).map(m => `${m.ticker} ${m.changePct.toFixed(1)}%`);
    const gainers = (data.movers.gainers || []).slice(0, 5).map(m => `${m.ticker} +${m.changePct.toFixed(1)}%`);
    if (losers.length)  sections.push(`MARKET_LOSERS (discount/oversold candidates): ${losers.join(' | ')}`);
    if (gainers.length) sections.push(`MARKET_GAINERS (momentum): ${gainers.join(' | ')}`);
  }

  // BLS
  if (data.bls?.length) {
    sections.push(`LABOR: ${data.bls.map(b => `${b.id}=${b.value}`).join(', ')}`);
  }

  // Treasury — totalDebt is raw dollars (e.g. "40305316210829.72"); render in $T.
  if (data.treasury?.totalDebt) {
    const debtT = Number(data.treasury.totalDebt) / 1e12;
    if (Number.isFinite(debtT) && debtT > 0) sections.push(`TREASURY: totalDebt=$${debtT.toFixed(1)}T`);
  }

  // Supply chain
  if (data.gscpi?.value != null) {
    sections.push(`SUPPLY_CHAIN: GSCPI=${data.gscpi.value}${data.gscpi.interpretation ? ` (${data.gscpi.interpretation})` : ''}`);
  }

  // Geopolitical signals (cap total OSINT text to keep prompt compact)
  const urgentPosts = (data.tg?.urgent || []).slice(0, 4);
  if (urgentPosts.length) {
    const MAX_OSINT_CHARS = 600;  // Tighter cap — OSINT is high-value but verbose; top 3 posts at 600 chars total
    let remaining = MAX_OSINT_CHARS;
    const lines = [];
    for (const p of urgentPosts) {
      const text = p.text || '';
      if (remaining <= 0) break;
      const trimmed = text.length > remaining ? text.substring(0, remaining) + '…' : text;
      lines.push(`- ${trimmed}`);
      remaining -= trimmed.length;
    }
    sections.push(`URGENT_OSINT:\n${lines.join('\n')}`);
  }

  // Thermal / fire detections
  if (data.thermal?.length) {
    const hotRegions = data.thermal.filter(t => t.det > 10).map(t => `${t.region}: ${t.det} detections (${t.hc} high-conf)`);
    if (hotRegions.length) sections.push(`THERMAL: ${hotRegions.join(', ')}`);
  }

  // Air activity
  if (data.air?.length) {
    const airSum = data.air.map(a => `${a.region}: ${a.total} aircraft`);
    sections.push(`AIR_ACTIVITY: ${airSum.join(', ')}`);
  }

  // Nuclear
  if (data.nuke?.length) {
    const anomalies = data.nuke.filter(n => n.anom);
    if (anomalies.length) sections.push(`NUCLEAR_ANOMALY: ${anomalies.map(n => `${n.site}: ${n.cpm}cpm`).join(', ')}`);
  }

  // WHO alerts
  if (data.who?.length) {
    sections.push(`WHO_ALERTS: ${data.who.slice(0, 3).map(w => w.title).join('; ')}`);
  }

  // Defense spending
  if (data.defense?.length) {
    const topContracts = data.defense.slice(0, 3)
      .filter(d => d.recipient)
      .map(d => `$${((d.amount || 0) / 1e6).toFixed(0)}M to ${d.recipient}`);
    if (topContracts.length) sections.push(`DEFENSE_CONTRACTS: ${topContracts.join(', ')}`);
  }

  // ── Semiconductor lead indicators (Tier 9) ────────────────────────────────
  // TrendForce: DRAM/NAND pricing + SEMI B2B ratio (leads stock moves by 4-12 weeks)
  if (data.trendforce) {
    const tf = data.trendforce;
    if (tf.memoryDirection) {
      const b2bLine = tf.b2bRatio != null
        ? ` B2B=${tf.b2bRatio}(${tf.b2bBullish ? 'BULLISH' : 'BEARISH'})`
        : '';
      sections.push(`SEMI_PRICING: MemoryDirection=${tf.memoryDirection}${b2bLine}`);
    }
    if (tf.signals?.length) {
      sections.push(`SEMI_SIGNALS: ${tf.signals.slice(0, 3).join(' | ')}`);
    }
  }

  // Benzinga: fast financial headlines — upgrades/downgrades/guidance ahead of Yahoo
  if (data.benzinga?.signals?.length) {
    sections.push(`FAST_NEWS: ${data.benzinga.signals.slice(0, 3).join(' | ')}`);
  }
  if (data.benzinga?.upgradeDowngrade?.length) {
    const ud = data.benzinga.upgradeDowngrade.slice(0, 2).map(h => h.title);
    sections.push(`UPGRADES_DOWNGRADES_NEWS: ${ud.join(' | ')}`);
  }
  // Structured options sweeps — raw objects from Benzinga (requires BENZINGA_API_KEY)
  // $500k+ sweeps on watched tickers are among the strongest institutional pre-positioning signals
  const _bigSweeps = [
    ...(data.benzinga?.optionsFlow?.bullish || []),
    ...(data.benzinga?.optionsFlow?.bearish || []),
  ].sort((a, b) => (b.premium || 0) - (a.premium || 0)).slice(0, 5);  // Top 5 by premium — 8 was over-sampling
  if (_bigSweeps.length) {
    const sweepLines = _bigSweeps.map(o =>
      `${o.sentiment} ${o.ticker} ${o.putCall} ${o.premiumFmt}${o.type ? ` [${o.type}]` : ''} exp:${(o.expiry || '?').slice(0, 10)}`
    );
    sections.push(`OPTIONS_SWEEPS: ${sweepLines.join(' | ')}`);
  } else if (data.benzinga?.optionSignals?.length) {
    // Fallback to pre-formatted strings when raw flow unavailable
    sections.push(`OPTIONS_FLOW: ${data.benzinga.optionSignals.slice(0, 3).join(' | ')}`);
  }

  if (data.congress?.upgradesDowngrades) {
    const ud = data.congress.upgradesDowngrades;
    const upLines = (ud.upgrades || []).slice(0, 3)
      .map(u => `↑${u.ticker} ${u.fromGrade}→${u.toGrade} (${u.analyst}${u.priceTarget ? ` PT:$${u.priceTarget}` : ''})`);
    const dnLines = (ud.downgrades || []).slice(0, 3)
      .map(u => `↓${u.ticker} ${u.fromGrade}→${u.toGrade} (${u.analyst}${u.priceTarget ? ` PT:$${u.priceTarget}` : ''})`);
    const allLines = [...upLines, ...dnLines];
    if (allLines.length) sections.push(`ANALYST_CALLS: ${allLines.join(' | ')}`);
  }

  // FMP economic calendar — upcoming macro catalysts (FOMC/CPI/NFP/GDP)
  if (data.congress?.econCalendar?.upcoming?.length) {
    const events = data.congress.econCalendar.upcoming.slice(0, 5)
      .map(e => `${e.date.slice(0, 10)} ${e.event}${e.estimate ? ` (est:${e.estimate})` : ''} [${e.impact}]`);
    sections.push(`MACRO_CALENDAR: ${events.join(' | ')}`);
  }

  // Congressional trading: known insider buys/sells (high-conviction signal)
  if (data.congress?.insiderAlerts?.length) {
    const alerts = data.congress.insiderAlerts.slice(0, 3).map(a => a.signal);
    sections.push(`CONGRESS_INSIDERS: ${alerts.join(' || ')}`);
  }
  if (data.congress?.topBuys?.length) {
    const buys = data.congress.topBuys.slice(0, 4).map(b => {
      const mc  = Number.isFinite(b.memberCount)    ? `${b.memberCount} members` : '?';
      const vol = Number.isFinite(b.totalBuyVolume) ? `, $${(b.totalBuyVolume / 1000).toFixed(0)}k` : '';
      return `${b.ticker}(${mc}${vol})`;
    });
    sections.push(`CONGRESS_CLUSTER_BUYS: ${buys.join(', ')}`);
  }

  // CHIPS Act: government semiconductor investment + BIS export controls
  if (data.chipsact) {
    const ca = data.chipsact;
    if (ca.totalGrantsM > 0) {
      sections.push(`CHIPS_GRANTS: $${ca.totalGrantsM}M in recent CHIPS Act awards — ${(ca.chipsGrantAwards || []).slice(0, 2).map(g => `${g.recipient} $${g.amountM}M`).join(', ')}`);
    }
    if (ca.bisExportControls?.length) {
      sections.push(`BIS_EXPORT_CONTROLS: ${ca.bisExportControls.slice(0, 2).map(a => a.title).join(' | ')}`);
    }
  }

  // Finnhub earnings calendar — upcoming binary events within 7 days
  // Earnings within 3d = +1 scoring; earnings day itself = +3 if gap >3%
  if (data.finnhub?.earnings?.length) {
    const _now = Date.now();
    const _earningsSoon = data.finnhub.earnings.filter(e => {
      if (!e.date) return false;
      const daysOut = (new Date(e.date).getTime() - _now) / 86400000;
      return daysOut >= 0 && daysOut <= 7;
    });
    if (_earningsSoon.length) {
      const items = _earningsSoon.slice(0, 6).map(e =>
        `${e.ticker} ${e.date}${e.eps_estimate != null ? ` est.EPS:${e.eps_estimate}` : ''}`
      );
      sections.push(`EARNINGS_CALENDAR: ${items.join(' | ')}`);
    }
  }

  // Finnhub executive insider buys — C-suite / director purchases on watchlist tickers
  // Buys >$50k are scored +1; >$100k are +2 (see Scout scoring rules)
  if (data.finnhub?.insiderBuys?.length) {
    const _insiderLines = data.finnhub.insiderBuys.slice(0, 4).map(b => {
      const who = (b.name || '?').split(' ').slice(-1)[0];
      const val = b.value != null ? `$${(b.value / 1000).toFixed(0)}k` : '$?';
      const dt  = b.date ? ` (${b.date})` : '';
      return `${b.ticker} ${who} ${val}${dt}`;
    });
    sections.push(`EXEC_INSIDER_BUYS: ${_insiderLines.join(' | ')}`);
  }

  // SEC EDGAR — 8-K material events + Form 4 insider filings (no API key needed)
  // 8-K = contract award / FDA decision / M&A / guidance change — high-immediacy signal
  if (data.sec?.eightKFilings?.length) {
    const _events = data.sec.eightKFilings.slice(0, 4).map(f => `${f.ticker}(${f.date})`);
    sections.push(`SEC_MATERIAL_EVENTS: ${_events.join(' | ')} — 8-K filed, verify contract/FDA/M&A`);
  }
  if (data.sec?.form4Filings?.length) {
    const _f4 = {};
    for (const f of data.sec.form4Filings) _f4[f.ticker] = (_f4[f.ticker] || 0) + 1;
    sections.push(`SEC_INSIDER_FILINGS: ${Object.entries(_f4).slice(0, 5).map(([t, n]) => `${t}(${n}x)`).join(', ')} — verify on EDGAR`);
  }

  // Maritime chokepoints — static reference so second-order geo chains can cite specific straits
  if (data.chokepoints?.length) {
    const _cp = data.chokepoints.slice(0, 4).map(c => `${c.label}(${(c.note || '').slice(0, 20)})`);  // 4 chokepoints, tighter note
    sections.push(`MARITIME_CHOKEPOINTS: ${_cp.join(' | ')}`);
  }

  // Reddit social velocity — viral posts signal retail momentum before price moves
  // Only fire when Reddit OAuth is configured (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET)
  if (data.reddit?.available) {
    const _viral = [
      ...(data.reddit.wsb    || []).filter(p => (p.score || 0) > 8000).map(p => `WSB: ${(p.title || '').slice(0, 55)}`),
      ...(data.reddit.stocks || []).filter(p => (p.score || 0) > 3000).map(p => `r/stocks: ${(p.title || '').slice(0, 55)}`),
      ...(data.reddit.ml     || []).filter(p => (p.score || 0) > 2000).map(p => `r/ML: ${(p.title || '').slice(0, 55)}`),
    ].slice(0, 4);
    if (_viral.length) sections.push(`SOCIAL_VIRAL: ${_viral.join(' | ')}`);
  }

  // Delta context
  if (delta?.summary) {
    sections.push(`\nDELTA_SINCE_LAST_SWEEP: direction=${delta.summary.direction}, changes=${delta.summary.totalChanges}, critical=${delta.summary.criticalChanges}`);
    if (delta.signals?.escalated?.length) {
      sections.push(`ESCALATED: ${delta.signals.escalated.map(s => `${s.label}: ${s.previous}→${s.current} (${(s.changePct||0) > 0 ? '+' : ''}${(s.changePct||0).toFixed(1)}%)`).join(', ')}`);
    }
    if (delta.signals?.new?.length) {
      sections.push(`NEW_SIGNALS: ${delta.signals.new.map(s => s.label || s.text?.substring(0, 60)).join('; ')}`);
    }
  }

  // Finnhub + NewsAPI financial news (M&A, signals)
  const _t80 = s => s?.length > 60 ? s.slice(0, 60) + '…' : (s || '');  // 60-char cap — keeps signal, cuts narrative
  if (data.finnhub?.signals?.length) {
    sections.push(`FINNHUB_SIGNALS: ${data.finnhub.signals.slice(0, 5).map(_t80).join(' | ')}`);
  }
  const mergerHeadlines = (data.finnhub?.news?.merger || []).slice(0, 4).map(a => _t80(a.headline)).filter(Boolean);
  if (mergerHeadlines.length) sections.push(`M&A_HEADLINES: ${mergerHeadlines.join(' | ')}`);
  if (data.newsapi?.signals?.length) {
    sections.push(`NEWSAPI_SIGNALS: ${data.newsapi.signals.slice(0, 5).map(_t80).join(' | ')}`);
  }
  const maArticles = (data.newsapi?.categories?.ma_activity?.articles || []).slice(0, 4).map(a => _t80(a.title)).filter(Boolean);
  if (maArticles.length) sections.push(`MA_DEALS: ${maArticles.join(' | ')}`);

  // Previous ideas (dedup — cap to last 4)
  if (previousIdeas.length) {
    sections.push(`PREV_IDEAS (skip repeats): ${previousIdeas.slice(0, 3).map(i => `${i.title}[${i.type}]`).join(' | ')}`);
  }

  return sections.join('\n');
}

/**
 * Parse LLM response into ideas array. Handles markdown code blocks.
 */
function parseIdeasResponse(text) {
  if (!text) return null;

  // Strip markdown code block wrappers
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned);
    // Wrap single-object responses — some models return {} instead of [{}]
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
    if (!arr.length) return null;

    // Validate each idea has required fields
    const valid = arr.filter(idea => idea.title && idea.type && idea.confidence)
      .map(idea => ({
        title:      idea.title,
        type:       idea.type,
        ticker:     idea.ticker     || '',
        confidence: idea.confidence,
        rationale:  idea.rationale  || '',
        risk:       idea.risk       || '',
        horizon:    idea.horizon    || '',
        signals:    idea.signals    || [],
        source: 'llm',
      }));
    return valid.length > 0 ? valid : null;
  } catch {
    // Try to extract JSON value from mixed text (array first, then single object)
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed2 = JSON.parse(match[0]);
        // Wrap single object just like the primary path
        const arr2 = Array.isArray(parsed2) ? parsed2 : [parsed2];
        const valid2 = arr2.filter(i => i.title && i.type).map(idea => ({ ...idea, source: 'llm' }));
        return valid2.length > 0 ? valid2 : null;
      } catch { /* give up */ }
    }
    // Salvage a TRUNCATED array (e.g. output hit maxTokens mid-stream, so there's no closing `]`):
    // recover every complete top-level {…} object that did stream in. Idea objects are flat
    // (their only nesting is a string array), so a brace-to-brace match is safe here.
    const objs = cleaned.match(/\{[^{}]*\}/g);
    if (objs?.length) {
      const salvaged = [];
      for (const o of objs) {
        try {
          const p = JSON.parse(o);
          if (p?.title && p?.type) salvaged.push({ ...p, source: 'llm' });
        } catch { /* skip the partial trailing object */ }
      }
      if (salvaged.length) return salvaged;
    }
    return null;
  }
}
