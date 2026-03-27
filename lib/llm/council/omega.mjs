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

    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h) {
        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider. 
        Mission: Synthesize Phi vs. Theta to issue a Final Command.
        Context: Buying Power: ${buyingPower} | Total Value: ${totalValue} | VIX: 27.45.
        
        OPERATIONAL DIRECTIVES:
        1. The Final Call: Weigh the Bull's "Alpha" vs. the Bear's "Risk." 
        2. Liquidity Logic: If ${buyingPower} is <10% of ${totalValue}, your default is WAIT unless the Scout identifies an "Emergency Exit" or "Safe Haven Play."
        3. Recent Performance: Check ${orders24h}. If the team is on a losing streak, favor Theta's caution.
        4. Capital Preservation: You are not a mediator. You are a Decider.
        
        OUTPUT:
        Logic: [1-2 sentences max].
        VERDICT: [BUY | SELL | WAIT]`;
        const sysPrompt = GregorSysPrompt + sysPrompts
            try {
              const res = await this.complete(sysPrompt, conversation);
              return res
          } catch(err) {
              console.error("[RedLine] PHI Failed to Assess Market Data: ", err.message)
          }
        }
    }