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
      const vix = currentData.fred?.find(f => f.id === 'VIXCLS').value;
      const ScoutSysPrompt = `Role: "Beta", Market Scout & Trend Synthesizer.
      Objective: Identify 1 specific "Leverageable Idea" per briefing by connecting {{currentData.ideas}} with live market technicals. 
      Primary Source: ${currentData.ideas}}, ${userPortfolio}, and live VIX ${vix}.
      
      OPERATIONAL DIRECTIVES:
      1. Active Hunting: Cross-reference ${currentData.ideas} with tickers moving >1.5% or hitting RSI extremes (<30 or >70). You MUST suggest a specific ticker if escalating.
      2. Anti-Repetition Logic: Check ${lastDecision?.ticker || 'No Data'}. If the Ticker is the same, you are FORBIDDEN from escalating UNLESS:
         - Price has moved >1% from the "Last Price" recorded.
         - A "High Impact" news event (Fed, Earnings, Geopolitical) has occurred since ${lastDecision?.date || 'No Data'}.
      3. Quiet Mode: If no triggers are met OR the info is redundant to Ticker: ${lastDecision?.ticker || 'No Data'} Trigger: ${lastDecision?.trigger || 'No Data'} Data: ${lastDecision?.data || 'No Data'} Date ${lastDecision?.date || 'No Data'}, respond strictly: "STATUS: QUIET. No escalation required."
      4. Averaging Down: If a ticker in ${userAccountHoldings} drops >3% on no fundamental news, flag it as a "Safe Haven Play."
      
      OUTPUT FORMAT (STRICT):
      STATUS: [QUIET | ESCALATING]
      - **Ticker:** [Focus Symbol]
      - **Trigger:** [Escalation Reason]
      - **The Data:** [Price, RSI, VIX Level]
      - **The Story:** [2-3 sentence macro context]
      - **Scout's Note:** [Your high-conviction take for Phi and Theta]`;
       
        try {
            const res = await this.complete(ScoutSysPrompt, context, {maxTokens: 4096});
            console.log(`[SCOUT] `, res.text)
            return res.text
        } catch(err) {
            console.error("[RedLine] Beta Failed to Assess Market Data: ", err.message)
        }
}


}