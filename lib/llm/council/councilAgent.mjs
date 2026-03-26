export class CouncilAgent {
  constructor(name, config) {
    this.name = name; // "Bull", "Bear", "Scout", etc.
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
        max_tokens: opts.maxTokens || 2048,
        ...(opts.extra || {}) // For things like 'enable_thinking' for Nemotron
      }),
      signal: AbortSignal.timeout(opts.timeout || 120000),
    });

    if (!res.ok) throw new Error(`${this.name} API Error: ${res.status}`);
    
    const data = await res.json();
    return data.choices[0].message.content;
  }
}