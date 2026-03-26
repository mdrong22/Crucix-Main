import { OpenAIProvider } from "./openai.mjs";

export class LLAMA4 extends OpenAIProvider {
   constructor(config) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = 'https://api.openai.com/v1';
  }
  
  async complete(systemPrompt, userMessage, opts = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens || 4096, // Note: OpenAI uses max_tokens or max_completion_tokens
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: opts.temperature ?? 0.7, // Bulls need creativity, Bears need focus
      }),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`API Error ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    
    return {
      text: data.choices?.[0]?.message?.content || '',
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      model: data.model || this.model,
    };
  }

}