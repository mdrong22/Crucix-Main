import { CouncilAgent } from "./councilAgent.mjs";

export class GregorLLM extends CouncilAgent {
    constructor(config) {
        super("Gregor", config);
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const raw = await super.complete(systemPrompt, userMessage, opts);
        console.log(`[GREGOR] ${raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim()}`)
        return raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    }
}