// planProposal.mjs — User-proposed edits to the agent's living plan (stance book).
//
// The user types a plain-English proposal ("start watching URA for a nuclear-fuel squeeze",
// "drop WDC, the thesis is dead"). The agent evaluates it against its current book and returns
// ACCEPT | PARTIAL | DENY with reasoning, plus the stanceUpdates to apply. The agent keeps its
// judgment — it can refuse an unsound idea. Accepted/partial updates are applied to the book and
// take effect on the next sweep.
//
// Same provider interface + fenced-JSON parse guard as analyst.mjs.

const SYSTEM_PROMPT = `You maintain a living trade-plan (a "stance book") for one personal portfolio. The user proposes a change to it in plain English. Judge it on its merits and respond.

VERDICTS:
 - ACCEPT: the proposal is sound — adopt it as stated.
 - PARTIAL: the idea has merit but needs adjustment — adopt a sensible version (tighter trigger, different stance, added caveat).
 - DENY: reject it (unsound, no edge, conflicts with risk discipline, or already covered). Explain why.

You have real judgment: do NOT rubber-stamp. A proposal to chase a pumped name, remove a prudent stop, or abandon a still-valid thesis should be DENIED or trimmed.

A stance = WATCH (interested, waiting) | ACCUMULATE (add on weakness) | HOLD (own, thesis intact) | TRIM | EXIT | AVOID.
Each stanceUpdate: {ticker, stance, thesis (one line why), plan (concrete ENTRY trigger, e.g. "buy <$30"), exit (WHEN TO SELL — take-profit + invalidation, e.g. "sell $42 or thesis-break <$27"), confidence 0-100, close (true to delete a stance)}.

Output ONE JSON object, no prose/fence:
{"verdict":"ACCEPT|PARTIAL|DENY","reasoning":"<1-3 sentences to the user explaining your decision>","summary":"<=8 word headline","stanceUpdates":[{"ticker":"","stance":"WATCH","thesis":"","plan":"","exit":"","confidence":0,"close":false}]}
For DENY, stanceUpdates must be []. Only include tickers you are actually changing.`;

function parseResult(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let obj;
  try { obj = JSON.parse(cleaned); }
  catch { const m = cleaned.match(/\{[\s\S]*\}/); if (!m) return null; try { obj = JSON.parse(m[0]); } catch { return null; } }
  if (!obj || typeof obj !== 'object') return null;

  const verdict = ['ACCEPT', 'PARTIAL', 'DENY'].includes(String(obj.verdict || '').toUpperCase())
    ? String(obj.verdict).toUpperCase() : null;
  if (!verdict) return null;

  const updates = verdict === 'DENY' ? [] : (Array.isArray(obj.stanceUpdates)
    ? obj.stanceUpdates.filter(u => u && typeof u === 'object').slice(0, 10) : []);

  return {
    verdict,
    reasoning: String(obj.reasoning || '').slice(0, 600),
    summary: String(obj.summary || '').slice(0, 80),
    stanceUpdates: updates,
  };
}

/**
 * Evaluate a user's plan proposal.
 * @param {object} provider        primary LLM provider (.complete, .isConfigured)
 * @param {string} userQuery       the user's plain-English proposal
 * @param {string} stancesDigest   current stance book (formatStancesForLLM output)
 * @param {object} [fallbackProvider]
 * @returns {Promise<{verdict,reasoning,summary,stanceUpdates}|null>}
 */
export async function evaluatePlanProposal(provider, userQuery, stancesDigest = 'none yet', fallbackProvider = null) {
  if (!provider?.isConfigured) provider = fallbackProvider;
  if (!provider?.isConfigured) return null;

  const context = [
    `=== YOUR CURRENT STANCE BOOK ===\n  ${stancesDigest || 'none yet'}`,
    `\n=== USER'S PROPOSED CHANGE ===\n${String(userQuery || '').slice(0, 800)}`,
  ].join('\n');

  const chain = [provider, fallbackProvider].filter(p => p?.isConfigured);
  for (let i = 0; i < chain.length; i++) {
    try {
      const res = await chain[i].complete(SYSTEM_PROMPT, context, { maxTokens: 900, timeout: 60000, temperature: 0.3 });
      const parsed = parseResult(res.text);
      if (parsed) { parsed.model = res.model || chain[i].model; parsed.provider = chain[i].name; return parsed; }
      console.warn(`[PlanProposal] ${i ? 'Fallback' : 'Primary'} returned no parseable verdict.`);
    } catch (err) {
      console.warn(`[PlanProposal] ${i ? 'Fallback' : 'Primary'} failed: ${err.message}`);
    }
  }
  return null;
}
