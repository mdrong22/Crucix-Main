import { CouncilAgent } from "./councilAgent.mjs";


export class ThetaLLM extends CouncilAgent {
    constructor(config) {
        super("Theta",config);
        this.model = config.model;
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl;
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        console.log(`[${this.name}] Thinking...`);
        const messages = [
        { role: 'system', content: systemPrompt },
        ...(Array.isArray(userMessage)
            ? userMessage.filter(m => m.role !== 'system')
            : [{ role: 'user', content: userMessage }])
        ];

        // QwQ-32b doesn't support temperature — only add it if the model isn't QwQ
        const isQwQ = this.model.includes('qwq') || this.model.includes('qwen3');        
        const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
            model: this.model,
            messages,
            ...(!isQwQ && { temperature: opts.temp ?? 0.7 }),
            max_completion_tokens: opts.maxTokens || 2048,
            ...(opts.extra || {})
        }),
        signal: AbortSignal.timeout(opts.timeout || 30000),
        });

        if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(`${this.name} API Error: ${res.status} - ${errData.error?.message || res.statusText}`);
        }
        
        const data = await res.json();
        console.log(`[THETA] ${data.choices[0].message.content}`)
        return data.choices[0].message.content;
}

async assessInfo(sysPrompts, conversation, userPortfolio) {    
       const BearSysPrompt = `Role: "Theta", Lead Risk Architect. 
        Mission: Protect ${userPortfolio} by identifying the "Single Point of Failure" in the proposed trade.
        Primary Source: ${userPortfolio} and real-time market risk data for the VIX.
        
        OPERATIONAL DIRECTIVES:
        1. The Prosecutor: Your job is to find reasons to say NO. Assume every rally is a trap.
        2. Portfolio Exposure: Look at ${userPortfolio}. If we are already heavy in a sector, scream "Overexposure."
        3. Volatility Tax: At VIX 27.45, assume stop-losses will be hunted. Demand 2x the normal margin of safety.
        4. Structural Flaws: If Phi cites "News," you cite "Liquidity." If Phi cites "RSI," you cite "Divergence."
        
        OUTPUT:
        Cold, calculated Bear Thesis (bullet points). Focus on why we should REJECT or WAIT.`
        
      const sysPrompt = BearSysPrompt + sysPrompts
      try {
          const res = await this.complete(sysPrompt, conversation);
          return res
      } catch(err) {
          console.error("[RedLine] PHI Failed to Assess Market Data: ", err.message)
      }
    }

   


}