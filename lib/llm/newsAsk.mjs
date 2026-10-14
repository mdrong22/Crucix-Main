// newsAsk.mjs — Read-only Q&A about current events / geopolitics for the NEWS feed channel's /ask.
//
// Grounded in the live sweep intelligence (OSINT, headlines, energy/geo/maritime signals) and, when the
// user REPLIES to a posted story, that story's text. This is situational analysis — it never changes
// state and gives no specific trade calls (that's /propose). Distinct from planProposal.answerPlanQuestion,
// which is about the agent's stance book.

const NEWS_PROMPT = `You are Crucix's geopolitical + markets intelligence analyst, answering a question in the live NEWS feed.
Answer grounded in the LIVE INTELLIGENCE provided (OSINT, headlines, energy/geo/maritime/policy signals) and, if present, THE STORY BEING DISCUSSED.

RULES:
 - Be concrete and analytical: what's happening, why it matters, and the likely market/sector read-through
   (energy, defense, shipping, rates, etc.) when relevant — this is a trading desk.
 - Ground claims in the provided intelligence and cite the specific signal/headline. If the context doesn't
   cover it, say what you can and can't see from the current sweep. NEVER invent facts, casualty figures,
   dates, or prices that aren't in the context.
 - Reason in probabilities and name the key uncertainty. No investment advice or specific buy/sell calls
   (that's what /propose is for) — this is situational analysis, not a recommendation.
 - 2-6 sentences, plain text (no markdown headings, no JSON). Direct and useful.`;

/**
 * Answer a read-only current-events / geopolitics question for the news channel.
 * @param {object} provider        primary LLM provider (.complete, .isConfigured)
 * @param {string} question        the user's question (or a default when they only replied to a story)
 * @param {string} [intel]         live sweep intelligence digest (compactSweepForLLM output)
 * @param {string} [storyContext]  text of the story the user replied to, if any
 * @param {object} [fallbackProvider]
 * @returns {Promise<{answer,provider,model}|null>}
 */
export async function answerNewsQuestion(provider, question, intel = '', storyContext = '', fallbackProvider = null) {
  if (!provider?.isConfigured) provider = fallbackProvider;
  if (!provider?.isConfigured) return null;

  const context = [
    `=== LIVE INTELLIGENCE (current sweep) ===\n${intel || '(no sweep intelligence available yet)'}`,
    storyContext ? `\n=== THE STORY BEING DISCUSSED (the user replied to this) ===\n${String(storyContext).slice(0, 1500)}` : '',
    `\n=== USER'S QUESTION ===\n${String(question || '').slice(0, 800)}`,
  ].filter(Boolean).join('\n');

  const chain = [provider, fallbackProvider].filter(p => p?.isConfigured);
  for (let i = 0; i < chain.length; i++) {
    try {
      const res = await chain[i].complete(NEWS_PROMPT, context, { maxTokens: 500, timeout: 60000, temperature: 0.4 });
      const answer = String(res.text || '').trim();
      if (answer) return { answer: answer.slice(0, 1400), provider: chain[i].name, model: res.model || chain[i].model };
      console.warn(`[NewsAsk] ${i ? 'Fallback' : 'Primary'} returned an empty answer.`);
    } catch (err) {
      console.warn(`[NewsAsk] ${i ? 'Fallback' : 'Primary'} failed: ${err.message}`);
    }
  }
  return null;
}
