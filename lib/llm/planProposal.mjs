// planProposal.mjs — User-proposed edits to the agent's living plan (stance book).
//
// The user types a plain-English proposal ("start watching URA for a nuclear-fuel squeeze",
// "drop WDC, the thesis is dead"). The agent evaluates it against its current book and returns
// ACCEPT | PARTIAL | DENY with reasoning, plus the stanceUpdates to apply. The agent keeps its
// judgment — it can refuse an unsound idea. Accepted/partial updates are applied to the book and
// take effect on the next sweep.
//
// Same provider interface + fenced-JSON parse guard as analyst.mjs.

const SYSTEM_PROMPT = `You manage a personal trading portfolio. The user sends a proposal in plain English. It may be EITHER:
 (A) a STOCK-SPECIFIC plan edit — e.g. "start watching URA", "drop WDC, thesis is dead", "raise CEG's target to $400"; or
 (B) a GENERAL DIRECTIVE — a standing instruction for HOW you operate — e.g. "use idle buying power for quick flips",
     "focus on energy + defense", "be patient, only A+ setups", "take profits faster".
Figure out which it is, then respond.

VERDICTS:
 - ACCEPT: sound — adopt it as stated.
 - PARTIAL: has merit but needs a tweak — adopt a sensible version.
 - DENY: genuinely unsound (reckless, removes prudent risk control, or self-contradictory). Explain why.

IMPORTANT: A general directive is NOT a specific trade — do NOT demand a ticker, thesis, or catalyst for it.
"Use spare buying power for quick flips" is a legitimate standing preference (bias toward small INTRADAY/SWING
flips), not a no-thesis trade — ACCEPT it as a directive. Reserve DENY for things that are actually dangerous
(e.g. "remove all stop-losses", "go all-in on one meme stock"). Lean toward ACCEPT/PARTIAL for reasonable guidance.

For (A) emit stanceUpdates. For (B) emit a "directive" — a concise standing instruction you will follow each cycle.
A proposal may produce both. A stance = WATCH | ACCUMULATE | HOLD | TRIM | EXIT | AVOID.
Each stanceUpdate: {ticker, stance, thesis, plan (ENTRY trigger), exit (WHEN TO SELL — target + invalidation), confidence 0-100, close}.

Output ONE JSON object, no prose/fence:
{"verdict":"ACCEPT|PARTIAL|DENY","reasoning":"<1-3 sentences to the user>","summary":"<=8 word headline","directive":"<standing instruction to follow, or empty if none>","stanceUpdates":[{"ticker":"","stance":"WATCH","thesis":"","plan":"","exit":"","confidence":0,"close":false}]}
For DENY, directive must be "" and stanceUpdates []. Only include tickers you are actually changing.`;

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
    directive: verdict === 'DENY' ? '' : String(obj.directive || '').slice(0, 240),
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
