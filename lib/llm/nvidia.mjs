import { LLMProvider } from "./provider.mjs";

export class Nemotron extends LLMProvider {
    
    async complete(systemPrompt, userMessage, opts = {}) {
        const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
    ];

        try {
        const res = await puter.ai.chat(messages, {
            model: 'nvidia/nemotron-3-super-120b-a12b:free',
            enable_thinking: true, 
            reasoning_budget: 1024,
            ...opts // Spread other opts like temperature
        });

        return {
            text: res.message.content, 
            reasoning: res.reasoning || "", 
            usage: {
                inputTokens: res.usage?.prompt_tokens || 0,
                outputTokens: res.usage?.completion_tokens || 0,
            }
        };
    } catch (err) {
        console.error("Error with Nemotron: ", err.message);
        return null;
    }
    }
}