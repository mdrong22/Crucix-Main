/**
 * debate.mjs — Project RedLine Council Debate Engine
 *
 * FIXES APPLIED:
 *  1. Strict ticker extraction with no hardcoded fallback (abort on parse fail)
 *  2. NVIDIA / named-stock anchor removed from Phi prompt (handled upstream in phi.mjs)
 *  3. Live quote injected before Gregor's verdict — prices from market, not LLM memory
 *  4. Price drift guard: aborts if Gregor's price deviates >2% from live feed
 *  5. Robust JSON extraction — strips markdown fences, handles multiline
 */

export class Debate {
  /**
   * @param {object} bull       - Phi LLM instance
   * @param {object} bear       - Theta LLM instance
   * @param {object} gregor     - Gregor LLM instance
   * @param {object} snapTrade  - SnapTrade wrapper instance
   * @param {function} getLiveQuote - async (ticker: string) => { price, bid, ask, volume }
   */
  constructor(bull, bear, gregor, snapTrade, getLiveQuote) {
    this.bull = bull;
    this.bear = bear;
    this.gregor = gregor;
    this.snapTradeInstance = snapTrade;
    this.getLiveQuote = getLiveQuote; // injected live quote fetcher
  }

  // ─── HELPERS ────────────────────────────────────────────────────────────────

  /**
   * Extracts the ticker from Phi's TARGET: response.
   * Returns null if the format is missing or malformed — caller must handle.
   */
  _extractTicker(text) {
    // Match "TARGET: BA" on its own line, 1-5 uppercase letters only
    const match = text.match(/^TARGET:\s*([A-Z]{1,5})\s*$/m);
    return match?.[1] || null;
  }

  /**
   * Extracts and parses Gregor's VERDICT JSON.
   * Handles: markdown fences, trailing commas, whitespace, multiline objects.
   * Returns { action: "WAIT" } as safe fallback on any parse failure.
   */
  _extractVerdict(text) {
    // Strip markdown code fences if Gregor wrapped JSON in ```json ... ```
    const stripped = text.replace(/```(?:json)?[\s\S]*?```/gi, (match) => {
      // Extract content inside the fences
      return match.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    });

    const match = stripped.match(/VERDICT:\s*(\{[\s\S]*?\})/);
    if (!match) {
      console.warn("[REDLINE] ⚠️  Gregor produced no VERDICT block. Defaulting to WAIT.");
      return { action: "WAIT" };
    }

    try {
      return JSON.parse(match[1]);
    } catch (e) {
      // Attempt light repair: remove trailing commas before } or ]
      try {
        const repaired = match[1].replace(/,\s*([}\]])/g, '$1');
        return JSON.parse(repaired);
      } catch (e2) {
        console.error("[REDLINE] ❌ Gregor JSON parse failed (even after repair):", match[1]);
        return { action: "WAIT" };
      }
    }
  }

  /**
   * Checks if Gregor's proposed limit price has drifted too far from the live feed.
   * Returns true (safe to proceed) or false (abort).
   */
  _isPriceSafe(gregorPrice, livePrice, maxDriftPct = 0.02) {
    if (!gregorPrice || !livePrice) return true; // can't check, allow through
    const drift = Math.abs(livePrice - gregorPrice) / livePrice;
    if (drift > maxDriftPct) {
      console.warn(
        `[REDLINE] ⚠️  Price drift detected: Gregor=$${gregorPrice} | Live=$${livePrice} | Drift=${(drift * 100).toFixed(2)}% > ${maxDriftPct * 100}%. Order suppressed.`
      );
      return false;
    }
    return true;
  }

  // ─── MAIN DEBATE FLOW ────────────────────────────────────────────────────────

  async beginDebate(briefing, context) {
    console.log("--- 🏁 DEBATE STARTING ---");

    // ── Fetch all account data in parallel ──────────────────────────────────
    const [portfolio, accountHoldings, buyingPower, totalValue, orders24h] =
      await Promise.all([
        this.snapTradeInstance.FetchUserTrades(),
        this.snapTradeInstance.getBuyDates(),
        this.snapTradeInstance.GetAccountBuyingPower(),
        this.snapTradeInstance.FetchAccountTotalValue(),
        this.snapTradeInstance.FetchAccountOrders24h(),
      ]);

    // Extract live VIX from the context payload so all agents use the same value
    // context may be an array of sweep data objects — find the FRED VIXCLS entry
    const liveVix = (() => {
      try {
        const dataArr = Array.isArray(context) ? context : [];
        const fred = dataArr.find(d => d.fred)?.fred;
        return fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
      } catch { return 'N/A'; }
    })();

    // ── Build the shared context block ──────────────────────────────────────
    // IMPORTANT: this goes in as a `user` role message, NOT system.
    // Phi's complete() strips system-role entries from the conversation array,
    // so anything in a system message here would be invisible to Phi.
    const sharedContextMsg = [
      `=== SCOUT BRIEFING ===`,
      briefing,
      ``,
      `=== ACCOUNT STATE ===`,
      `Portfolio: ${portfolio}`,
      `Holdings: ${accountHoldings}`,
      `Buying Power: ${buyingPower} USD`,
      `Total Value: ${totalValue} USD`,
      `Last Orders (24h): ${orders24h}`,
      ``,
      `=== WORLD CONTEXT ===`,
      context,
    ].join('\n');

    // System message carries council rules only (no data — data goes in user turn)
    const conversation = [
      { role: "system",  content: "You are a council of trading analysts. All market data, scout briefings, and account information will be provided in the user messages below." },
      { role: "user",    content: sharedContextMsg },
    ];

    // ── CYCLE 1: TICKER SELECTION ────────────────────────────────────────────
    // Phi must return exactly: TARGET: [TICKER] on its own line — nothing else.
    // The briefing is already in the conversation above as a user message.
    const selectionMsg =
      "-> Based on the Scout Briefing above, identify the ONE priority ticker. " +
      "Your entire response must be a single line in this exact format:\nTARGET: [TICKER]";

    // Push the instruction as the next user turn before calling Phi
    conversation.push({ role: "user", content: selectionMsg });

    const selectionRaw = await this.bull.assessInfo(
      selectionMsg,
      conversation,
      briefing,
      portfolio,
      buyingPower
    );

    const targetTicker = this._extractTicker(selectionRaw);

    if (!targetTicker) {
      console.warn(
        "[REDLINE] ⚠️  Phi failed to isolate a valid ticker from the briefing. " +
        `Raw response: "${selectionRaw?.slice(0, 120)}". Aborting debate → WAIT.`
      );
      return { action: "WAIT", symbol: null, transcript: conversation };
    }

    console.log(`[REDLINE] 🎯 Council target: ${targetTicker}`);
    conversation.push({ role: "assistant", name: "Phi", content: `Target: ${targetTicker}` });

    // ── CYCLE 2: BULL vs BEAR ARGUMENTS ─────────────────────────────────────
    const bullThesis = await this.bull.assessInfo(
      `-> Build the bull case for ${targetTicker}. Reference our portfolio parameters.`,
      conversation,
      briefing,
      portfolio,
      buyingPower
    );
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.assessInfo(
      `-> Build the risk/bear case for ${targetTicker}. Reference our portfolio parameters.`,
      conversation,
      portfolio,
      liveVix
    );
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // ── CYCLE 3: LIVE PRICE INJECTION ────────────────────────────────────────
    // Fetch a fresh quote NOW — before Gregor decides price/units
    // This prevents Gregor from hallucinating a stale price from the Scout's briefing
    let liveQuote = null;
    let liveContext = "";

    if (this.getLiveQuote) {
      try {
        liveQuote = await this.getLiveQuote(targetTicker);
        liveContext = [
          `\n⚡ LIVE PRICE FEED (fetched at verdict time — use these numbers, not the Scout's quoted price):`,
          `  Symbol:  ${targetTicker}`,
          `  Price:   $${liveQuote.price}`,
          `  Bid:     $${liveQuote.bid}`,
          `  Ask:     $${liveQuote.ask}`,
          `  Volume:  ${liveQuote.volume}`,
          `  MarketState: ${liveQuote.marketState}`,
          `  ChangePrice: ${liveQuote.changePct}`,
          `  You MUST use $${liveQuote.price} as your price basis for the VERDICT.`,
        ].join('\n');
        console.log(`[REDLINE] 📡 Live quote for ${targetTicker}: $${liveQuote.price} (bid $${liveQuote.bid} / ask $${liveQuote.ask})`);
      } catch (err) {
        console.warn(`[REDLINE] ⚠️  Live quote fetch failed for ${targetTicker}: ${err.message}. Gregor will use briefing price.`);
      }
    }

    // ── CYCLE 4: GREGOR'S VERDICT ────────────────────────────────────────────
    const verdictInstruction = [
  liveContext,
  `-> Based on the full debate above, output the final trade parameters.`,
  `CRITICAL RULES:`,
  `1. If trading during EXTENDED hours (4:00 PM - 8:00 PM ET), you MUST use order_type: "Limit" and provide a price. Current Time ${new Date().toISOString()}`,
  `2. For fractional trades, prefer "notional_value" (dollar amount) over "units" (share count) for Market orders.`,
  `3. You must provide EITHER "units" OR "notional_value", the other must be null.`,
  `Required fields:`,
  `  - action:           "BUY" | "SELL" | "WAIT"`,
  `  - order_type:       "Limit" | "Market" | "Stop" | "StopLimit"`,
  `  - time_in_force:    "Day" | "GTC" | "FOK" | "IOC"`,
  `  - price:            number (required for Limit/StopLimit, null for Market)`,
  `  - units:            number of shares (positive number or null)`,
  `  - notional_value:   dollar amount (positive number or null)`,
  `  - trading_session:  "REGULAR" | "EXTENDED"`,
  `Output your reasoning in 1-2 sentences, then end with:`,
  `VERDICT: {"action":"...","order_type":"...","time_in_force":"...","price":...,"units":...,"notional_value":...,"trading_session":"..."}`,
  `The VERDICT JSON must be on a single line with no trailing commas.`,
].join('\n');

    const gregorResponse = await this.gregor.assessInfo(
      verdictInstruction,
      conversation,
      buyingPower,
      totalValue,
      orders24h,
      liveVix,
      { temp: 0.4, extra: { enable_thinking: true } }
    );

    conversation.push({ role: "assistant", name: "Gregor", content: gregorResponse });

    // ── PARSE & VALIDATE VERDICT ─────────────────────────────────────────────
    const verdict = this._extractVerdict(gregorResponse);

    console.log('='.repeat(60));
    console.log(`[REDLINE] Final Command: ${verdict.action} ${targetTicker}`);

    // Price drift safety check — only relevant for limit/stop orders
    if (
      verdict.action !== "WAIT" &&
      liveQuote &&
      ["Limit", "StopLimit", "Stop"].includes(verdict.order_type)
    ) {
      const safe = this._isPriceSafe(verdict.price, liveQuote.price);
      if (!safe) {
        console.warn("[REDLINE] ⛔ Order suppressed due to price drift. Returning WAIT.");
        return {
          action: "WAIT",
          symbol: targetTicker,
          transcript: conversation,
          reason: "price_drift",
        };
      }
    }

    return {
      symbol: targetTicker,
      action: verdict.action?.toUpperCase() || "WAIT",
      order_type: verdict.order_type || "Limit",
      time_in_force: verdict.time_in_force || "Day",
      trading_session: verdict.trading_session || "REGULAR",
      price: verdict.price ?? null,
      units: verdict.units ?? null,
      notational_value: verdict.notational_value ?? null,
      transcript: conversation,
    };
  }
}
