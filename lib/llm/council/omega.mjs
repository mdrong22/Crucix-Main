import { CouncilAgent } from "./councilAgent.mjs";
import { GregorSysPrompt } from "./utils/prompts.mjs";

export class GregorLLM extends CouncilAgent {
    constructor(config) {
        super("Gregor", config);
    }

    async complete(systemPrompt, userMessage, opts = {}) {
        const raw = await super.complete(systemPrompt, userMessage, opts);
        console.log(`[GREGOR] ${raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim()}`)
        return raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
    }

    async assessInfo(sysPrompts, conversation) {
        const sysPrompt = GregorSysPrompt + sysPrompts
            try {
              const res = await this.complete(sysPrompt, conversation);
              return res
          } catch(err) {
              console.error("[RedLine] PHI Failed to Assess Market Data: ", err.message)
          }
        }
    }