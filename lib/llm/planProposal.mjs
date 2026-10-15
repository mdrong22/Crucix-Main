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

GROUND IN LIVE STATE: the context carries CURRENT HOLDINGS, RECENT TRADES, and a LIVE MARKET SWEEP that
includes POSITION_NEWS (company-specific news on holdings) and INSIDER_SELLS (executives reducing a held
name). Weigh them before you answer. If a proposal contradicts fresh position news or insider selling —
e.g. "keep holding WMB" when POSITION_NEWS shows a thesis-break (court ruling, permit loss) or insiders are
dumping it — do NOT rubber-stamp it: PARTIAL with a tighter stop / smaller size, or DENY an unsound hold,
and name the specific signal in your reasoning.

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
 * @param {string} [extraContext]  live grounding: current holdings, track record, directives, market sweep
 * @returns {Promise<{verdict,reasoning,summary,stanceUpdates}|null>}
 */
export async function evaluatePlanProposal(provider, userQuery, stancesDigest = 'none yet', fallbackProvider = null, extraContext = '') {
  if (!provider?.isConfigured) provider = fallbackProvider;
  if (!provider?.isConfigured) return null;

  const context = [
    `=== YOUR CURRENT STANCE BOOK ===\n  ${stancesDigest || 'none yet'}`,
    extraContext ? `\n=== CURRENT STATE & CONTEXT ===\n${String(extraContext).slice(0, 7000)}` : '',
    `\n=== USER'S PROPOSED CHANGE ===\n${String(userQuery || '').slice(0, 800)}`,
  ].filter(Boolean).join('\n');

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

// ── Read-only Q&A about the plan ("Ask") ──────────────────────────────────────
// Unlike evaluatePlanProposal, this NEVER changes state. It lets the user interrogate the agent's
// thinking — "why hold NVDA?", "what's your exit on SLV?", "what would make you sell?" — grounded in
// the real stance book + track record, so the answer reflects the actual plan, not a fresh invention.

const ASK_PROMPT = `You are the trading agent. The user is ASKING about your plan — your stance book, your
holdings, your theses, your track record. Answer their question, grounded ONLY in the context provided.

RULES:
 - Be concrete and honest. When a stock is involved, cite its real stance, thesis, entry trigger, exit
   ("sell when…"), and confidence from the stance book; reference track-record facts when relevant.
 - CURRENT HOLDINGS (in the context) is the GROUND TRUTH of what you actually own — shares, cost basis,
   and P/L. For "what do I hold / am I up on X / what's my position" questions, answer from it, NOT from
   the stance book (the book is your plan/watchlist; it may list stocks you don't own and omit detail).
   If a held stock isn't in the stance book, you still own it — say so.
 - RECENT TRADES (in the context) is your real executed history — buys/sells with entry and outcome.
   Use it for "what did I trade today / what was my last buy / how did the X trade go" questions.
 - POSITION_NEWS and INSIDER_SELLS (in the LIVE MARKET SWEEP) are company-specific news and insider
   selling on the user's own holdings/watchlist. Use them for "any news on X / why is X moving / should
   I be worried about my WMB / is my thesis still intact" questions. If they show a thesis-break (court/
   regulatory ruling, permit loss, guidance cut, insiders dumping), say so plainly and flag the risk —
   don't stay bullish on the old thesis when the live feed contradicts it.
 - When a LIVE MARKET SWEEP section is present, it is your CURRENT real-time intelligence — fresh news,
   catalysts, movers, cross-correlation/priority signals, congressional + insider activity. PREFER it for
   "why is X moving / what's happening now" questions. Cite the actual sweep line (e.g. a PRIORITY headline
   or cross-correlation), not just the older stored thesis. The stored thesis is your standing view; the
   sweep is what's true right now — reconcile them if they differ.
 - If the context doesn't contain the answer, say so plainly. NEVER invent a thesis, a position, a
   price, or a number that isn't in the context.
 - This is READ-ONLY. You are explaining, not changing anything — do NOT propose edits or claim to
   have made any. If the user wants a change, tell them to use "Propose".
 - 2-6 sentences, plain English, plain text (no markdown headings, no JSON). Direct and useful.`;

/**
 * Answer a read-only question about the plan. Returns { answer, provider, model } or null.
 * @param {object} provider
 * @param {string} question       the user's plain-English question
 * @param {string} stancesDigest  current stance book
 * @param {string} [extraContext] optional extra grounding (track record, directives, portfolio)
 * @param {object} [fallbackProvider]
 */
export async function answerPlanQuestion(provider, question, stancesDigest = 'none yet', extraContext = '', fallbackProvider = null) {
  if (!provider?.isConfigured) provider = fallbackProvider;
  if (!provider?.isConfigured) return null;

  const context = [
    `=== YOUR CURRENT STANCE BOOK ===\n  ${stancesDigest || 'none yet'}`,
    extraContext ? `\n=== ADDITIONAL CONTEXT ===\n${extraContext}` : '',
    `\n=== USER'S QUESTION ===\n${String(question || '').slice(0, 800)}`,
  ].filter(Boolean).join('\n');

  const chain = [provider, fallbackProvider].filter(p => p?.isConfigured);
  for (let i = 0; i < chain.length; i++) {
    try {
      const res = await chain[i].complete(ASK_PROMPT, context, { maxTokens: 500, timeout: 60000, temperature: 0.3 });
      const answer = String(res.text || '').trim();
      if (answer) return { answer: answer.slice(0, 1200), provider: chain[i].name, model: res.model || chain[i].model };
      console.warn(`[PlanAsk] ${i ? 'Fallback' : 'Primary'} returned an empty answer.`);
    } catch (err) {
      console.warn(`[PlanAsk] ${i ? 'Fallback' : 'Primary'} failed: ${err.message}`);
    }
  }
  return null;
}
