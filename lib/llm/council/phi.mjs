import { CouncilAgent } from "./councilAgent.mjs";


export class PhiLLM extends CouncilAgent {
    constructor(config) {
        super("Phi",config);
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
    }

   async complete(systemPrompt, userMessage, opts = {}) {
    console.log(`[${this.name}] Thinking...`);
    const messages = [
    { role: 'system', content: systemPrompt },
    ...(Array.isArray(userMessage)
      ? userMessage.filter(m => m.role !== 'system') // strip system msgs, already handled above
      : [{ role: 'user', content: userMessage }])
    ];

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
     body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temp ?? 0.7,
        max_completion_tokens: opts.maxTokens || 2048, // ← changed from max_tokens
        ...(opts.extra || {})
        }),
      signal: AbortSignal.timeout(opts.timeout || 30000),
    });

    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`${this.name} API Error: ${res.status} - ${errData.error?.message || res.statusText}`);
    }
    
    const data = await res.json();
    console.log(`[PHI]  ${data.choices[0].message.content}`)
    return data.choices[0].message.content;
  }
  

    async assessInfo(currentData, userPortfolio, userAccountHoldings) {
        
        const vix = currentData.fred?.find(f => f.id === 'VIXCLS').value;
        const sysPrompt = `**Role:** You are the Market Scout named "Beta" for a high-frequency trading system. 
            **Objective:** Monitor real-time feeds and broader market sentiment. Filter out 90% of the noise. Only escalate to the Council if a "Volatility Event" or a "Leverageable Idea" occurs.
            All Current Data: ${JSON.stringify(currentData)}
            **Input Data Points:**
            1. Prices & Technicals (RSI, Moving Averages).
            2. Macro: VIX Index (Current: ${vix}).
            3. News Sentiment: Headlines and summaries.
            4. Portfolio: ${userPortfolio} Account Holdings: ${userAccountHoldings}
            5. Leveragable Ideas: ${currentData.ideas}

            **Escalation Triggers (Notify the Council if):**
            - **Price Action:** Any asset moves > 1.5% in the last 15 minutes.
            - **Fear Spike:** VIX increases by more than 5% in a single session.
            - **Sentiment Shift:** A "High Impact" news headline (Earnings, Fed, Geopolitics).
            - **Safe Haven Play:** $SLV drops significantly while VIX is rising (Averaging down opportunity).

            **Output Format (Strict):**
            If no trigger is met, respond: "STATUS: QUIET. No escalation required."
            If a trigger IS met, provide a "Council Briefing":
            - **Ticker:** [Symbol]
            - **Trigger:** [Why are we escalate?]
            - **The Data:** [Price, RSI, VIX level]
            - **The Story:** [1-4 sentence summary of news/sentiment]
            - **Scout's Note:** [Your brief take on the 'Leverageable Idea(s)']`
       
        try {
            const res = await this.complete(sysPrompt, "Analyze current market state.");
            console.log(`[SCOUT] `, res.text)
            return res.text
        } catch(err) {
            console.error("[RedLine] Beta Failed to Assess Market Data: ", err.message)
        }
}


}