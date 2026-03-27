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
  

  async assessInfo(sysPrompts, conversation, scoutBriefing, portfolio, buyingPower) {  
    const BullSysPrompt = `Role: "Phi", Lead Growth Catalyst. 
    Mission: Identify Alpha by analyzing ${scoutBriefing}. 
    Primary Source: ${scoutBriefing}, ${portfolio}, and ${buyingPower}.
    
    OPERATIONAL DIRECTIVES:
    1. Scout Priority: You MUST prioritize the Ticker and Idea provided in the Scout's Briefing. Do NOT deviate to NVIDIA or other tickers unless the Scout flagged them.
    2. Momentum/RSI: If the Scout flags a "Breakout," argue for aggressive entry. 
    3. Deployment Logic: Check {{buyingPower}}. If we have high cash reserves, argue for a larger 5-7% allocation. If {{buyingPower}} is low, suggest a smaller "Scalp" trade.
    4. Risk as Opportunity: At VIX 27.45, argue that "Weak Hands" are providing us a discount.
    
    OUTPUT:
    Aggressive, data-backed Bull Thesis. Tell Gregor exactly why we deploy capital into the Scout's target NOW.`;
      const sysPrompt = BullSysPrompt + sysPrompts
      try {
          const res = await this.complete(sysPrompt, conversation, {maxTokens: 4096});
          return res
      } catch(err) {
          console.error("[RedLine] PHI Failed to Assess Market Data: ", err.message)
      }
}


}