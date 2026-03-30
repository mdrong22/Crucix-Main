/**
 * debate.mjs — Project RedLine Council Debate Engine
 * Optimized for strict SnapTrade execution and Gregor JSON parsing.
 */

export class Debate {
  constructor(bull, bear, gregor, snapTrade, getLiveQuote) {
    this.bull = bull;
    this.bear = bear;
    this.gregor = gregor;
    this.snapTradeInstance = snapTrade;
    this.getLiveQuote = getLiveQuote;
  }

  _extractTicker(text) {
    const match = text.match(/TARGET:\s*([A-Z]{1,5})/i);
    return match?.[1]?.toUpperCase() || null;
  }

  _extractVerdict(text) {
    const match = text.match(/VERDICT:\s*({[\s\S]*?})(?:\n|$)/i);
    if (!match) {
        console.warn("[REDLINE] ⚠️ No VERDICT JSON found in Gregor's output.");
        return { action: "WAIT" };
    }
    try {
      // Clean up potential trailing commas and whitespace
      const jsonStr = match[1].replace(/,\s*([}\]])/g, '$1').trim();
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error("[REDLINE] ❌ Gregor JSON parse failed:", e.message);
      return { action: "WAIT" };
    }
  }

  _isPriceSafe(gregorPrice, livePrice, maxDriftPct = 0.02) {
    if (!gregorPrice || !livePrice) return true; 
    const drift = Math.abs(livePrice - gregorPrice) / livePrice;
    return drift <= maxDriftPct;
  }

  async PlaceOrder(data) {
    if (!data || data.action === "WAIT") return null;

    const universalSymbolId = await this.snapTradeInstance.resolveSymbolId(data.symbol);
    if (!universalSymbolId) return null;

    // 1. Build Payload using 'account_id' (SnapTrade specific)
    const orderPayload = {
      userId: this.snapTradeInstance.userId,
      userSecret: this.snapTradeInstance.userSecret,
      account_id: this.snapTradeInstance.accountId, 
      action: String(data.action).toUpperCase(),
      universal_symbol_id: universalSymbolId,
      order_type: data.order_type || "Limit",
      time_in_force: data.time_in_force || "Day",
      trading_session: data.trading_session || "EXTENDED",
    };

    // 2. Mutual Exclusivity Logic (Notional vs Units)
    // If Notional is provided (Regular Hours), it MUST be a String for SnapTrade
    if (data.notional_value > 0) {
      orderPayload.notional_value = String(data.notional_value);
    } else {
      if (data.units) orderPayload.units = parseFloat(data.units);
      if (data.price) orderPayload.price = parseFloat(data.price);
    }

    // Scrub nulls and undefined
    Object.keys(orderPayload).forEach(key => {
      if (orderPayload[key] === null || orderPayload[key] === undefined) delete orderPayload[key];
    });

    console.log(`[REDLINE] 🚀 EXECUTING:`, JSON.stringify(orderPayload, null, 2));

    try {
      const response = await this.snapTradeInstance.snaptrade.trading.placeForceOrder(orderPayload);
      console.log(`[REDLINE] ✅ SUCCESS: ${data.symbol}`);
      return response.data;
    } catch (error) {
      const msg = error?.response?.data || error.message;
      console.error(`[REDLINE] ❌ SNAPTRADE REJECTED:`, JSON.stringify(msg));
      return null;
    }
  }

  async beginDebate(briefing, context) {
    console.log("--- 🏁 DEBATE STARTING ---");
    const estTime = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});

    const [portfolio, accountHoldings, buyingPower, totalValue, orders24h] =
      await Promise.all([
        this.snapTradeInstance.FetchUserTrades(),
        this.snapTradeInstance.getBuyDates(),
        this.snapTradeInstance.GetAccountBuyingPower(),
        this.snapTradeInstance.FetchAccountTotalValue(),
        this.snapTradeInstance.FetchAccountOrders24h(),
      ]);

    const liveVix = (() => {
      try {
        const dataArr = Array.isArray(context) ? context : [];
        const fred = dataArr.find(d => d.fred)?.fred;
        return fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
      } catch { return 'N/A'; }
    })();

    // 1. SELECT TICKER (Phi)
    const selectionRaw = await this.bull.assessInfo("TARGET: [TICKER]", [], briefing, portfolio, buyingPower);
    const targetTicker = this._extractTicker(selectionRaw);
    if (!targetTicker) return { action: "WAIT" };

    const conversation = [
      { role: "user", content: `CONTEXT: ${briefing}\nTICKER: ${targetTicker}\nVIX: ${liveVix}` },
      { role: "assistant", name: "Phi", content: `TARGET: ${targetTicker}` }
    ];

    // 2. BULL/BEAR ARGUMENTS
    const bullThesis = await this.bull.assessInfo(`Bull case for ${targetTicker}`, conversation, briefing, portfolio, buyingPower);
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.assessInfo(`Bear case for ${targetTicker}`, conversation, portfolio, liveVix);
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // 3. LIVE QUOTE
    let liveQuote = await this.getLiveQuote(targetTicker);
    const liveContext = `LIVE PRICE: ${targetTicker} is $${liveQuote.price}. Time: ${estTime} EST.`;

    // 4. GREGOR VERDICT
    const verdictInstruction = [
      liveContext,
      `RULES:`,
      `- IF EXTENDED HOURS: Use Limit/Day/EXTENDED. Whole shares only. floor(${buyingPower}/${liveQuote.price}).`,
      `- IF REGULAR HOURS: Use Market/Day/REGULAR. Notional_value allowed.`,
      `VERDICT: {"action":"...","order_type":"...","time_in_force":"Day","price":...,"units":...,"notional_value":...,"trading_session":"..."}`
    ].join('\n');

    const gregorResponse = await this.gregor.assessInfo(
      verdictInstruction,
      conversation,
      buyingPower,
      totalValue,
      orders24h,
      liveVix
    );

    const verdict = this._extractVerdict(gregorResponse);
    
    if (verdict.action !== "WAIT" && !this._isPriceSafe(verdict.price, liveQuote.price)) {
      console.warn(`[REDLINE] Price drift too high. Aborting.`);
      return { action: "WAIT", symbol: targetTicker };
    }

    return {
      symbol: targetTicker,
      ...verdict,
      transcript: conversation
    };
  }
}