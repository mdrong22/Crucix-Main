import { BearSysPrompt, BullSysPrompt, GregorSysPrompt } from "../llm/council/utils/prompts.mjs";

export class Debate {
  constructor(bull, bear, gregor, snapTrade) {
    this.bull = bull;
    this.bear = bear;
    this.gregor = gregor;
    this.snapTradeInstance = snapTrade
  }

  async beginDebate(briefing) {
    console.log("--- 🏁 DEBATE STARTING (Dynamic API Mode) ---");
    const [portfolio, accountHoldings, accountBalance] = await Promise.all([this.snapTradeInstance.FetchUserTrades(), this.snapTradeInstance.getBuyDates(), this.snapTradeInstance.GetAccountBalance()])
   const conversation = [
  { 
    role: "system", 
    content: `Current Market Briefing: ${briefing}\nOur Account: ${portfolio} | Our Holdings: ${accountHoldings} | Our Accout Balance: ${accountBalance}` 
  }
];
    // --- CYCLE 1: THE TARGET ---
    const selectionMsg = "Identify ONE priority ticker. Format: TARGET: [TICKER]";
    const selection = await this.bull.complete(selectionMsg, conversation); 
    const targetTicker = selection.match(/TARGET:\s*(\w+)/i)?.[1] || "SLV";
    conversation.push({ role: "assistant", name: "Beta", content: `Target: ${targetTicker}` });

    // --- CYCLE 2: THE ARGUMENTS ---
    const bullThesis = await this.bull.complete(`${BullSysPrompt} -> Case for ${targetTicker}`, conversation);
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.complete(`${BearSysPrompt} -> Risk case for ${targetTicker}`, conversation, { temp: 0.2 });
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // --- CYCLE 3: THE VERDICT (SNAPTRADE FORMATTING) ---
    const gregorResponse = await this.gregor.complete(
      `${GregorSysPrompt}
      
      -> Based on the debate, output the final trade parameters. 
      
      MATCH THIS API SPEC:
      - action: "BUY" | "SELL" | "WAIT"
      - order_type: "Limit" | "Market" | "Stop" | "StopLimit"
      - time_in_force: "Day" | "GTC" | "FOK" | "IOC"
      - price: (Number if Limit/StopLimit, else null)
      - units: (Number of shares)
      
      Output the final decision at the end as: VERDICT: {json_object}`,
      conversation,
      { temp: 0.4, extra: { enable_thinking: true } }
    );

    conversation.push({ role: "assistant", name: "Gregor", content: gregorResponse });

    // Regex to grab the JSON object Gregor built
    const jsonMatch = gregorResponse.match(/VERDICT:\s*(\{.*\})/s);
    const verdict = jsonMatch ? JSON.parse(jsonMatch[1]) : { action: "WAIT" };
    console.log(`${'='.repeat(60)}`)
    console.log(`[REDLINE] Final Command: ${verdict.action} ${targetTicker}`);
    
    return {
      symbol: targetTicker,
      action: verdict.action.toUpperCase(),
      order_type: verdict.order_type || "Limit",
      time_in_force: verdict.time_in_force || "Day",
      price: verdict.price || null,
      units: verdict.units || null,
      transcript: conversation 
    };
  }
}