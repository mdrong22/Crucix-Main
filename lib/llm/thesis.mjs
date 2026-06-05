// Auto-Derived Forward-Pacing (Thesis) Engine
//
// Reactive discovery (news/earnings/dislocation) arrives AFTER a move. This pass does the
// opposite: it clusters structural signals from the sweep into durable megatrends, traces each
// causal supply chain, and names the rung the market hasn't repriced yet — so Scout can position
// on the unpriced link BEFORE capital rotates to it (e.g. data-center demand → power bottleneck →
// GEV/CEG/VRT/uranium, before the breakout).
//
// Auto-derived: trends + chains are reasoned live from the data every cycle. No hardcoded ticker
// map — nothing is "propped up". The thesis only sets the hunting ground; a separate pre-breakout
// SETUP scan (apis/sources/alpaca.mjs getSetupTechnicals) decides whether any name is actually
// timing in. Modeled on lib/llm/ideas.mjs (same provider→fallback chain + JSON-parse guard).

const _t = (s, n = 90) => (s && s.length > n ? s.slice(0, n) + '…' : (s || ''));

/**
 * Build the Stage-1 thematic digest — only the STRUCTURAL signals that hint at durable trends.
 * Deliberately excludes day-trade noise (intraday gaps, single headlines).
 */
export function compactThemesForLLM(data, priorTheses = []) {
  const sections = [];

  // Presidential / executive policy (already sector-tagged) — strongest structural driver.
  if (data.policy?.signals?.length) {
    sections.push(`POLICY: ${data.policy.signals.slice(0, 5).join(' | ')}`);
  }
  // CHIPS Act grants + BIS export controls — multi-year fab/investment signal.
  if (data.chipsact?.signals?.length) {
    sections.push(`CHIPS/EXPORT: ${data.chipsact.signals.slice(0, 3).join(' | ')}`);
  }
  // Semiconductor memory cycle — leads semis stocks by 4-12 weeks.
  if (data.trendforce) {
    const tf = data.trendforce;
    const b2b = tf.b2bRatio != null ? ` B2B=${tf.b2bRatio}(${tf.b2bBullish ? 'BULLISH' : 'BEARISH'})` : '';
    sections.push(`SEMI_CYCLE: Memory=${tf.memoryDirection || 'NEUTRAL'}${b2b}${tf.signals?.length ? ' | ' + tf.signals.slice(0, 2).join(' | ') : ''}`);
  }
  // Defense contracts — multi-year program awards.
  if (data.defense?.length) {
    sections.push(`DEFENSE_CONTRACTS: ${data.defense.slice(0, 3).map(d => `$${((d.amount || 0) / 1e6).toFixed(0)}M ${_t(d.recipient, 30)}`).join(' | ')}`);
  }
  // Congressional clusters + analyst revisions — informed accumulation ahead of policy.
  if (data.congress?.topBuys?.length) {
    const cl = data.congress.topBuys.filter(b => b.clustered).slice(0, 5).map(b => b.ticker);
    if (cl.length) sections.push(`CONGRESS_CLUSTERS: ${cl.join(', ')}`);
  }
  if (data.congress?.upgradesDowngrades?.upgrades?.length) {
    sections.push(`ANALYST_UPGRADES: ${data.congress.upgradesDowngrades.upgrades.slice(0, 4).map(u => `${u.ticker}→${u.toGrade || ''}`).join(' | ')}`);
  }
  // EIA / energy structural signals.
  if (data.energy?.signals?.length) {
    sections.push(`ENERGY: ${data.energy.signals.slice(0, 2).join(' | ')}`);
  }
  // M&A — consolidation often marks a maturing theme.
  const ma = (data.finnhub?.news?.merger || []).slice(0, 3).map(a => _t(a.headline, 60)).filter(Boolean);
  if (ma.length) sections.push(`M&A: ${ma.join(' | ')}`);
  // Emerging momentum (broad gainers) — corroborating which rung is moving.
  if (data.movers?.gainers?.length) {
    sections.push(`MOMENTUM_NAMES: ${data.movers.gainers.slice(0, 6).map(m => m.ticker).join(', ')}`);
  }
  // Patents — early innovation signal.
  if (data.patents?.length) {
    sections.push(`PATENTS: ${data.patents.slice(0, 3).map(p => _t(p.title || p.label, 50)).filter(Boolean).join(' | ')}`);
  }

  // Carry prior theses so the LLM ages/maintains them rather than re-inventing each run.
  if (priorTheses?.length) {
    sections.push(`PRIOR_THESES (maintain/age, drop if invalidated): ${priorTheses.slice(0, 4).map(t => `${t.trend} [rung: ${(t.targetTickers || []).slice(0, 3).join(',')}]`).join(' | ')}`);
  }

  return sections.join('\n');
}

const SYSTEM_PROMPT = `You are a macro strategist mapping durable structural trends to their supply chains.
From the structural signals below, identify 2-4 DURABLE trends that are happening "regardless" (multi-quarter inevitability, not a one-day headline).
For EACH trend, trace the causal chain and find the rung the market HAS NOT yet repriced.

Rules:
- Inevitability HIGH only if multiple independent signals corroborate a multi-year demand driver.
- Trace 1st→2nd→3rd order. The valuable rung is usually the BOTTLENECK (the constraint everyone needs), not the obvious headline name.
- "priced" = rungs already obvious/extended. "emergingRung" = the next link capital rotates to.
- targetTickers = 2-4 specific tickers ON the emerging/bottleneck rung (the names to hunt). Real, liquid US tickers only.
- Name a concrete invalidation (what would kill the thesis).
- Do NOT invent trends from no evidence. Fewer, higher-quality theses beat many weak ones.

Output ONLY a valid JSON array. Each object:
{"trend":"<short name>","evidence":["signal1","signal2"],"inevitability":"HIGH|MED|LOW","chain":{"priced":["TICK"],"emergingRung":["TICK"],"bottleneck":"<the constraint>"},"targetTickers":["TICK1","TICK2"],"invalidation":"<what kills it>"}`;

function parseThesesResponse(text) {
  if (!text) return null;
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (!m) return null;
    try { parsed = JSON.parse(m[0]); } catch { return null; }
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const valid = arr
    .filter(t => t && t.trend && Array.isArray(t.targetTickers) && t.targetTickers.length)
    .map(t => ({
      trend:         String(t.trend).slice(0, 80),
      evidence:      Array.isArray(t.evidence) ? t.evidence.slice(0, 4) : [],
      inevitability: ['HIGH', 'MED', 'LOW'].includes(t.inevitability) ? t.inevitability : 'MED',
      chain: {
        priced:       Array.isArray(t.chain?.priced)       ? t.chain.priced.slice(0, 4)       : [],
        emergingRung: Array.isArray(t.chain?.emergingRung) ? t.chain.emergingRung.slice(0, 4) : [],
        bottleneck:   String(t.chain?.bottleneck || '').slice(0, 100),
      },
      targetTickers: t.targetTickers.map(x => String(x).toUpperCase().trim()).filter(x => /^[A-Z]{1,5}$/.test(x)).slice(0, 4),
      invalidation:  String(t.invalidation || '').slice(0, 120),
      source: 'llm',
    }))
    .filter(t => t.targetTickers.length > 0);
  return valid.length ? valid : null;
}

/**
 * Generate auto-derived forward-pacing theses from a synthesized sweep.
 * @returns {Promise<Array|null>} array of thesis objects, or null on failure.
 */
export async function generateLLMTheses(provider, sweepData, delta, priorTheses = [], fallbackProvider = null) {
  if (!provider?.isConfigured) return null;

  let digest;
  try {
    digest = compactThemesForLLM(sweepData, priorTheses);
  } catch (err) {
    console.error('[Thesis] Failed to build thematic digest:', err.message);
    return null;
  }
  if (!digest.trim()) {
    console.log('[Thesis] No structural signals this cycle — skipping thesis pass.');
    return null;
  }

  console.log(`[Thesis] Deriving forward-pacing theses (~${Math.round(digest.length / 4)} tok) → ${provider.name}/${provider.model}`);

  // Primary provider
  try {
    const result = await provider.complete(SYSTEM_PROMPT, digest, { maxTokens: 1024, timeout: 60000 });
    const theses = parseThesesResponse(result.text);
    if (theses) { console.log(`[Thesis] ✅ ${theses.length} theses derived.`); return theses; }
    console.warn('[Thesis] Primary returned no parseable theses — trying fallback.');
  } catch (err) {
    console.warn(`[Thesis] Primary failed: ${err.message} — trying fallback.`);
  }

  // Cross-API fallback (Groq), same as ideas pass
  if (fallbackProvider?.isConfigured) {
    try {
      const result = await fallbackProvider.complete(SYSTEM_PROMPT, digest, { maxTokens: 1024, timeout: 45000 });
      const theses = parseThesesResponse(result.text);
      if (theses) { console.log(`[Thesis] ✅ ${theses.length} theses via fallback ${fallbackProvider.model}.`); return theses; }
    } catch (err) {
      console.error(`[Thesis] Fallback also failed: ${err.message}`);
    }
  }
  return null;
}
