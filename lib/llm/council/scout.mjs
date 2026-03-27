import { CouncilAgent } from "./councilAgent.mjs";


export class ScoutLLM extends CouncilAgent {
    constructor(config) {
        super("Beta",config);
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',  'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userMessage }] }],
        generationConfig: {
          maxOutputTokens: opts.maxTokens || 4096,
        },
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
      model: this.model,
    };
  }

    async assessInfo(context, currentData, userPortfolio, userAccountHoldings, lastDecision) {

        const sysPrompt = `**Role:** You are the Market Scout named "Beta" for a high-frequency trading system. 
            **Objective:** Monitor real-time feeds and broader market sentiment. Filter out 90% of the noise. Only escalate to the Council if a "Volatility Event" or a "Leverageable Idea" occurs. use web.
            **Input Data Points:**
            1. Prices & Technicals (RSI, Moving Averages).
            2. Macro: VIX Index
            3. News Sentiment: Headlines and summaries.
            4. Portfolio: ${userPortfolio} Account Holdings: ${userAccountHoldings}
            5. Leveragable Ideas: ${currentData.ideas}
            - Do NOT repeat ideas from the "previous ideas" list unless conditions have materially changed
            
            If you have reached out to the council before with the same idea, respond "STATUS: QUIET. No escalation required." 
            last reached out:  
            Ticker: ${lastDecision?.ticker || 'No Data'} Trigger: ${lastDecision?.trigger || 'No Data'} Data: ${lastDecision?.data || 'No Data'} Date ${lastDecision?.date || 'No Data'}

            **Escalation Triggers (Notify the Council if):**
            - **Price Action:** Any asset moves > 1.5% in the last 15 minutes.
            - **Fear Spike:** VIX increases by more than 5% in a single session.
            - **Sentiment Shift:** A "High Impact" news headline (Earnings, Fed, Geopolitics).
            - **Safe Haven Play:** (Averaging down opportunity).

            **Output Format (Strict):**
            If no trigger is met, respond: "STATUS: QUIET. No escalation required."
            If a trigger IS met, provide a "Council Briefing":
            - **Ticker:** [Symbol]
            - **Trigger:** [Why are we escalate?]
            - **The Data:** [Price, RSI, VIX level]
            - **The Story:** [1-4 sentence summary of news/sentiment]
            - **Scout's Note:** [Your brief take on the 'Leverageable Idea(s)']`
       
        try {
            const res = await this.complete(sysPrompt, context, {maxTokens: 4096});
            console.log(`[SCOUT] `, res.text)
            return res.text
        } catch(err) {
            console.error("[RedLine] Beta Failed to Assess Market Data: ", err.message)
        }
}


}