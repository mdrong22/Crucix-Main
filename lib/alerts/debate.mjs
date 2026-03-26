export class Debate {
  

    constructor(bullAgent, bearAgent, gregorAgent) {
        this.bull = bullAgent;
        this.bear = bearAgent;
        this.gregor = gregorAgent;
    }

    /**
     * The 3-Cycle Execution Engine
     * @param briefing - The output from your Scout
     */
    async beginDebate(briefing, portfolio, holdings) {
        console.log("--- 🏁 DEBATE INITIALIZED ---");

        // CYCLE 1: SELECTION (The Draft)
        // We ask the Bull and Bear to agree on a single focus ticker
        const selectionPrompt = `Review the Scout's briefing and pick ONE ticker to focus on.
                                 Bull wants growth. Bear wants safety. 
                                 Current VIX: 25.13. Output: "TARGET: [TICKER]"`;
        
        const selection = await this.bull.complete(selectionPrompt, briefing);
        const targetTicker = selection.match(/TARGET: (\w+)/)?.[1] || "SLV"; 
        console.log(`[Cycle 1] Focused on: ${targetTicker}`);

        // CYCLE 2: THE THESIS (The Trial)
        // Bull and Bear argue over the target ticker
        const bullThesis = await this.bull.complete(
            `Build a strong BUY case for ${targetTicker}. Ignore the risks.`,
            briefing, { temp: 0.9 } // Higher temp for "creative" bullishness
        );

        const bearThesis = await this.bear.complete(
            `Build a strong WAIT/SELL case for ${targetTicker}. Focus on the VIX and risk.`,
            briefing, { temp: 0.2 } // Lower temp for "cold" bear logic
        );
        console.log(`[Cycle 2] Thesis arguments generated.`);

        // CYCLE 3: FINALITY (The Verdict)
        // Gregor (Nemotron-3-120B) processes the conflict and returns JSON
       const finalContext = `
      TARGET: ${targetTicker}
      BULL ARGUMENT: ${bullThesis}
      BEAR ARGUMENT: ${bearThesis}
      USER_ID: "cookiemathias"
      USER_SECRET: "491e5b66-0ca1-419a-ab0d-b3efa059962f"
    `;

    const decision = await this.gregor.complete(
      `You are Gregor. Your goal is to output a single JSON object for the SnapTrade 'Place equity order' API. 
      API INFO: [
                action
                string
                required
                The action describes the intent or side of a trade. This is either BUY or SELL for Equity symbols or BUY_TO_OPEN, BUY_TO_CLOSE, SELL_TO_OPEN or SELL_TO_CLOSE for Options.

                BUY
                universal_symbol_id
                string (format: uuid) or null
                The universal symbol ID of the security to trade. Must be 'null' if symbol is provided, otherwise must be provided.

                symbol
                string or null
                The security's trading ticker symbol. If 'symbol' is provided, then 'universal_symbol_id' must be 'null'.

                F
                order_type
                string
                required
                The type of order to place.

                For Limit and StopLimit orders, the price field is required.
                For Stop and StopLimit orders, the stop field is required.
                Limit
                time_in_force
                string
                required
                The Time in Force type for the order. This field indicates how long the order will remain active before it is executed or expires. Here are the supported values:

                Day - Day. The order is valid only for the trading day on which it is placed.
                GTC - Good Til Canceled. The order is valid until it is executed or canceled.
                FOK - Fill Or Kill. The order must be executed in its entirety immediately or be canceled completely.
                IOC - Immediate Or Cancel. The order must be executed immediately. Any portion of the order that cannot be filled immediately will be canceled.
                Day
                trading_session
                string
                The trading session for the order. This field indicates which market session the order will be placed in. This is only available for certain brokerages. Defaults to REGULAR. Here are the supported values:
                REGULAR - Regular trading hours.
                EXTENDED - Extended trading hours.
                
                price
                number or null
                The limit price for Limit and StopLimit orders.

                stop
                number or null
                The price at which a stop order is triggered for Stop and StopLimit orders.

                units
                number or null
                For Equity orders, this represents the number of shares for the order. This can be a decimal for fractional orders. Must be null if notional_value is provided. If placing an Option order, this field represents the number of contracts to buy or sell. (e.g., 1 contract = 100 shares).
                notional_value
                or null

                Total notional amount for the order. Must be null if units is provided. Can only work with Market for order_type and Day for time_in_force. This is only available for certain brokerages. Please check the integrations doc for more information.
]

        REQUIRED FORMAT:
      {
        "action": "BUY" | "SELL" | "WAIT",
        "symbol": "${targetTicker}",
        "order_type": "Limit", 
        "time_in_force": "Day",
        "price": NUMBER,
        "units": NUMBER
      }
        

      If the Bear wins and we should do nothing, set action to "WAIT".
      Use the current market data to pick a competitive Limit price.`,
      finalContext,
      { extra: { enable_thinking: true } }
    );

    return this.cleanJsonResponse(decision);
    }

    // Helper to strip any Markdown backticks from the LLM output
     cleanJsonResponse(text) {
        return text.replace(/```json|```/g, "").trim();
    }
}