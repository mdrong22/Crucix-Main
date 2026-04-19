/**
 * debate.mjs — Project RedLine Council Debate Engine
 * Updated to support Multi-Trade Arrays and Rotation Logic.
 */

import { DataCleaner } from "../llm/council/utils/cleaner.mjs";
// logDecisions moved to server.mjs — only log after confirmed execution

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

  /**
   * Updated to handle both single objects and Arrays []
   */
  _extractVerdict(cleanText) {
    // 1. Standardize the Verdict prefix (removes duplicates)
    cleanText = cleanText.replace(/(VERDICT:\s*)+/gi, 'VERDICT: ');

    // 2. Capture the JSON block specifically AFTER "VERDICT:"
    // This looks for "VERDICT:" and then the first [ or { that follows it
    const verdictMatch = cleanText.match(/VERDICT:\s*([{\[][\s\S]*)/i);
    let jsonToParse = null;

    if (verdictMatch && verdictMatch[1]) {
        jsonToParse = verdictMatch[1].trim();
    } else {
        // Fallback: If "VERDICT:" is missing, find the LAST [ or { in the text
        // This avoids grabbing conversational brackets like [ACCEPTED] at the start
        const allBlocks = [...cleanText.matchAll(/([{\[][\s\S]*)/g)];
        if (allBlocks.length > 0) {
            jsonToParse = allBlocks[allBlocks.length - 1][1].trim();
        }
    }

    if (!jsonToParse) return [{ action: "WAIT" }];

    // 3. EMERGENCY BRACKET REPAIR (Improved)
    // We only want the JSON block, not trailing conversational text
    if (jsonToParse.startsWith('[')) {
        const lastBracket = jsonToParse.lastIndexOf(']');
        if (lastBracket !== -1) {
            jsonToParse = jsonToParse.substring(0, lastBracket + 1);
        } else {
            // It's cut off, close it at the last valid curly
            const lastCurly = jsonToParse.lastIndexOf('}');
            if (lastCurly !== -1) jsonToParse = jsonToParse.substring(0, lastCurly + 1) + ']';
        }
    } else if (jsonToParse.startsWith('{')) {
        const lastCurly = jsonToParse.lastIndexOf('}');
        if (lastCurly !== -1) jsonToParse = jsonToParse.substring(0, lastCurly + 1);
    }

    try {
        // 4. CLEAN AND PARSE
        const fixedJson = jsonToParse.replace(/,\s*([}\]])/g, '$1').trim();
        const parsed = JSON.parse(fixedJson);
        
        const finalArray = Array.isArray(parsed) ? parsed : [parsed];
        return finalArray.length > 0 ? finalArray : [{ action: "WAIT" }];
    } catch (e) {
        console.error("[REDLINE] ❌ JSON Parse Failed:", e.message);
        console.error("[REDLINE] Attempted string:", jsonToParse);
        return [{ action: "WAIT" }];
    }
}

  _isPriceSafe(gregorPrice, livePrice, maxDriftPct = 0.02) {
    if (!gregorPrice || !livePrice) return true; 
    const drift = Math.abs(livePrice - gregorPrice) / livePrice;
    return drift <= maxDriftPct;
  }

  async beginDebate(briefing, context, remainingTrades) {
    console.log("--- 🏁 DEBATE STARTING ---");
    const estTime = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});

    // 1. GATHER STATE
    const [port, buyingPower, totalValue, orders, openAccOrders] =
      await Promise.all([
        this.snapTradeInstance.FetchUserTrades(),
        this.snapTradeInstance.FetchAccountBuyingPower(),
        this.snapTradeInstance.FetchAccountTotalValue(),
        this.snapTradeInstance.FetchAccountOrders24h(),
        this.snapTradeInstance.FetchOpenAccountOrders()
      ]);

    const portfolio = DataCleaner.stringifyPortfolio(port);
    const orders24h = DataCleaner.stringifyOrders(orders);
    const openAccountOrders = DataCleaner.stringifyOpenOrders(openAccOrders);
     
    const liveVix = (() => {
      try {
        const dataArr = Array.isArray(context) ? context : [];
        const fred = dataArr.find(d => d.fred)?.fred;
        return fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
      } catch(err) { return `N/A`; }
    })();

    // 2. BULL/BEAR PHASE (Targeting primary opportunity)
    const selectionRaw = await this.bull.assessInfo("TARGET: [TICKER]", [], briefing, portfolio, buyingPower, openAccountOrders);
    const targetTicker = this._extractTicker(selectionRaw);
    if (!targetTicker) return [{ action: "WAIT" }];

    const conversation = [
      { role: "user", content: `CONTEXT: ${briefing}\nPRIMARY_TARGET: ${targetTicker}\nVIX: ${liveVix}` },
      { role: "assistant", name: "Phi", content: `Selection: ${targetTicker}` }
    ];

    const bullThesis = await this.bull.assessInfo(`Bull case for ${targetTicker}`, conversation, briefing, portfolio, buyingPower, openAccountOrders);
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.assessInfo(`Bear case for ${targetTicker}`, conversation, portfolio, liveVix, openAccountOrders);
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // 3. THETA VETO — REJECT + low score = no Gregor call, return WAIT immediately
    const thetaVerdictMatch = bearThesis.match(/THETA\s+VERDICT:\s*(REJECT|WAIT|PROCEED)/i);
    const thetaVerdict = thetaVerdictMatch?.[1]?.toUpperCase() || null;
    const scoreMatch   = briefing.match(/Signal\s*Score:\s*(\d+)/i);
    const signalScore  = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    if (thetaVerdict === 'REJECT' && signalScore < 7) {
      console.log(`[REDLINE] 🛑 Theta VETO — verdict: REJECT, score: ${signalScore}/10 (threshold: 7). Council stands down.`);
      return [{ action: 'WAIT' }];
    }
    if (thetaVerdict === 'REJECT') {
      console.warn(`[REDLINE] ⚠ Theta REJECT but score ${signalScore} ≥ 7 — escalating to Gregor with veto flag.`);
    }

    // 4. ENRICH WITH LIVE QUOTE
    let liveQuote;
    try {
      liveQuote = await this.getLiveQuote(targetTicker);
      if (!liveQuote || !liveQuote.price) throw new Error('Quote returned null or no price');
    } catch (err) {
      console.error(`[REDLINE] ❌ Live quote failed for ${targetTicker}: ${err.message} — aborting debate.`);
      return [{ action: "WAIT" }];
    }
    const liveContext = `LIVE_PRICE_${targetTicker}: $${liveQuote.price}. Time: ${estTime} EST. Remaining Day Trades: ${remainingTrades}`;

    // 5. GREGOR VERDICT (Now expects a list)
    const verdictInstruction = [
      liveContext,
      thetaVerdict === 'REJECT' ? `⚠ THETA VETO FLAG: Theta issued REJECT but signal score (${signalScore}) overrides the veto threshold. Address Theta's concern explicitly in Logic before executing.` : '',
      `ROTATION_RULE: If rotating from one symbol to another, output a LIST: [{"action":"SELL",...}, {"action":"BUY",...}].`,
      `SELL_RULE: If "order_type" is "Limit" (required for EXTENDED sessions), you CANNOT use "notional_value, however prefer units for SELL in general".`,
      `FRACTIONAL RULE: If the units value is a decimal (e.g., 0.04), you MUST set time_in_force to 'Day'. Use 'GTC' only for whole-number units (e.g., 1, 2, 10).`,
      `// VERDICT MUST BE AN ARRAY EVEN IF THERE IS 1 ORDER`,
      `VERDICT: [{"symbol":"...","action":"...","order_type":"...","price":...,"units":...,"notional_value":...}]`
    ].join('\n');
    const GetPortfolio = this.snapTradeInstance.FetchUserTrades.bind(this.snapTradeInstance);
    const gregorResponse = await this.gregor.assessInfo(
      verdictInstruction,
      conversation,
      buyingPower,
      totalValue,
      orders24h,
      liveVix,
      openAccountOrders,
      GetPortfolio,
      remainingTrades
    );
    console.log(`GREGOR RAW OUTPUT: ${gregorResponse}`)

    // Preserve Gregor's full Logic + VERDICT in transcript so Scribe sees complete reasoning
    conversation.push({ role: "assistant", name: "Gregor", content: gregorResponse || '' });

    const rawVerdicts = this._extractVerdict(gregorResponse);

    // 5. POST-PROCESS AND SAFETY CHECK
    const finalTrades = [];
    for (const v of rawVerdicts) {
      if (v.action === "WAIT") continue;

      // Price drift safety (only for the primary ticker we quoted)
      if (v.symbol === targetTicker && !this._isPriceSafe(v.price, liveQuote.price)) {
        console.warn(`[REDLINE] Price drift too high for ${v.symbol}. Skipping.`);
        continue;
      }

      finalTrades.push({
        ...v,
        symbol: v.symbol || targetTicker, // Fallback to target if symbol missing
        transcript: conversation
      });
    }

    // 6. SORT TRADES: SELLS FIRST (Mechanical necessity for rotation)
    const sorted = finalTrades.sort((a, b) => (a.action === "SELL" ? -1 : 1));

    return sorted;
  }
}