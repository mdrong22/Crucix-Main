import { CouncilAgent } from "./councilAgent.mjs";
import { BullSysPrompt } from "./utils/prompts.mjs";


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
  

  async assessInfo(sysPrompts, conversation ) {  
      const sysPrompt = BullSysPrompt + sysPrompts
      try {
          const res = await this.complete(sysPrompt, conversation, {maxTokens: 4096});
          return res
      } catch(err) {
          console.error("[RedLine] PHI Failed to Assess Market Data: ", err.message)
      }
}


}