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

   


}