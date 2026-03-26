import { GeminiProvider } from "../llm/gemini.mjs";


export class ScoutLLM extends GeminiProvider {
    constructor() {
        super()
        this.lastSweep  
    }

    async assessInfo(currentData, userPortfolio, userAccountHoldings, lastSweep) {
        if(this.lastSweep === lastSweep) {
            console.log("[REDLINE] Nothing to Notify")
            return
        }
        const vix = currentData.fred?.find(f => f.id === 'VIXCLS').value;
        const sysPrompt = `**Role:** You are the Market Scout named "Beta" for a high-frequency trading system. 
            **Objective:** Monitor real-time feeds for $NVDA, $SLV, and broader market sentiment. Filter out 90% of the noise. Only escalate to the Council if a "Volatility Event" or a "Leverageable Idea" occurs.
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
            if(res) {
                this.lastSweep = lastSweep
            }
            return res
        } catch(err) {
            console.error("[RedLine] Beta Failed to Assess Market Data: ", err.message)
        }
}


}