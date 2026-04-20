/**
 * debate.mjs — Project RedLine Council Debate Engine
 * Updated to support Multi-Trade Arrays and Rotation Logic.
 */

import { DataCleaner } from "../llm/council/utils/cleaner.mjs";
import { getHistoricalTechnicals } from "../../apis/sources/alpaca.mjs";
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
    // Scout format: "- Ticker: AAPL" or "**Ticker:** AAPL" (preferred)
    const scoutMatch = text.match(/Ticker[:\*\s]+([A-Z]{1,5})\b/i);
    if (scoutMatch) return scoutMatch[1].toUpperCase();
    // Legacy Phi TARGET format (fallback)
    const targetMatch = text.match(/TARGET:\s*([A-Z]{1,5})/i);
    return targetMatch?.[1]?.toUpperCase() || null;
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

    // FetchUserTrades already returns cleaned data — keep reference for mechanical P&L checks
    const cleanedPortfolio = Array.isArray(port) ? port : [];
    const portfolio = DataCleaner.stringifyPortfolio(cleanedPortfolio);
    const orders24h = DataCleaner.stringifyOrders(orders);
    const openAccountOrders = DataCleaner.stringifyOpenOrders(openAccOrders);
     
    const liveVix = (() => {
      try {
        const dataArr = Array.isArray(context) ? context : [];
        const fred = dataArr.find(d => d.fred)?.fred;
        return fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
      } catch(err) { return `N/A`; }
    })();

    // 2. EXTRACT TARGET TICKER directly from Scout's briefing (Scout already selected it)
    // No LLM call needed — Scout's ESCALATING output always contains "- Ticker: SYMBOL"
    const targetTicker = this._extractTicker(briefing);
    if (!targetTicker) {
      console.warn('[DEBATE] ⚠ Could not extract ticker from Scout briefing — standing down.');
      return [{ action: "WAIT" }];
    }
    console.log(`[DEBATE] 🎯 Ticker extracted from Scout: ${targetTicker}`);

    // 3. FETCH LIVE QUOTE + CANDLE DATA before Phi/Theta run so all agents share the same picture
    let liveQuote;
    try {
      liveQuote = await this.getLiveQuote(targetTicker);
      if (!liveQuote || !liveQuote.price) throw new Error('Quote returned null or no price');
    } catch (err) {
      console.error(`[REDLINE] ❌ Live quote failed for ${targetTicker}: ${err.message} — aborting debate.`);
      return [{ action: "WAIT" }];
    }

    // Horizon-aware candle fetch — Phi anchors bull case to S1, Theta calls out second floor risk
    // INTRADAY → 5-min bars, 20 bars | SWING → daily, 20 days | LONG → daily, 60 days
    const horizonMatch = briefing.match(/Horizon:\s*(INTRADAY|SWING|LONG)/i);
    const tradeHorizon = horizonMatch?.[1]?.toUpperCase() || 'SWING';
    const candleConfig = tradeHorizon === 'INTRADAY'
      ? { timeframe: '5Min', limit: 20 }
      : tradeHorizon === 'LONG'
        ? { timeframe: '1Day', limit: 60 }
        : { timeframe: '1Day', limit: 20 };

    // INTRADAY time gate — block if < 30 min to market close (4:00 PM ET)
    if (tradeHorizon === 'INTRADAY') {
      const nowET = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      const closeET = new Date(nowET);
      closeET.setHours(16, 0, 0, 0);
      const minutesToClose = (closeET - nowET) / 60000;
      if (minutesToClose < 30) {
        console.log(`[DEBATE] ⏰ INTRADAY blocked — ${minutesToClose.toFixed(0)} min to market close (< 30 min threshold).`);
        return [{ action: "WAIT" }];
      }
      console.log(`[DEBATE] ⏰ INTRADAY time check OK — ${minutesToClose.toFixed(0)} min to close.`);
    }

    let candleBlock = '';
    let technicalCtx = {}; // structured summary passed into agent prompts
    try {
      const tech = await getHistoricalTechnicals(targetTicker, candleConfig.timeframe, candleConfig.limit);
      if (tech?.bars?.length >= 3) {
        const bars = tech.bars;
        const price = liveQuote.price;

        // True ATR: max(H-L, |H-prevClose|, |L-prevClose|) — accounts for overnight gaps
        // bars are sorted desc (newest first), so bars[i+1] is the prior bar
        let atrSum = 0, atrCount = 0;
        for (let i = 0; i < bars.length - 1; i++) {
          const bar = bars[i], prevClose = bars[i + 1].c;
          atrSum += Math.max(bar.h - bar.l, Math.abs(bar.h - prevClose), Math.abs(bar.l - prevClose));
          atrCount++;
        }
        const atr     = atrCount > 0 ? atrSum / atrCount : bars.reduce((sum, b) => sum + (b.h - b.l), 0) / bars.length;
        const atrPct  = atr / price * 100;
        const volLabel = atrPct > 4 ? 'HIGH' : atrPct > 2 ? 'MODERATE' : 'LOW';

        // 2-bar swing lookback for more robust structural level detection (avoids false pivots)
        const chrono = [...bars].reverse();
        const swingLows = [], swingHighs = [];
        for (let i = 2; i < chrono.length - 2; i++) {
          if (chrono[i].l < chrono[i-1].l && chrono[i].l < chrono[i-2].l &&
              chrono[i].l < chrono[i+1].l && chrono[i].l < chrono[i+2].l) swingLows.push(chrono[i].l);
          if (chrono[i].h > chrono[i-1].h && chrono[i].h > chrono[i-2].h &&
              chrono[i].h > chrono[i+1].h && chrono[i].h > chrono[i+2].h) swingHighs.push(chrono[i].h);
        }
        const supports    = swingLows.filter(l => l < price).sort((a, b) => b - a).slice(0, 3);
        const resistances = swingHighs.filter(h => h > price).sort((a, b) => a - b).slice(0, 3);
        const rangeLow    = Math.min(...bars.map(b => b.l));
        const rangeHigh   = Math.max(...bars.map(b => b.h));

        const s1 = supports[0]    ?? rangeLow;
        const s2 = supports[1]    ?? null;
        const r1 = resistances[0] ?? rangeHigh;

        technicalCtx = { price, atr, atrPct, volLabel, s1, s2, r1, supports, resistances, rangeLow, rangeHigh, rsi: tech.rsi, momentum: tech.momentum };

        const supportStr    = supports.length ? supports.map((s, i) => `S${i+1}=$${s.toFixed(2)}`).join('  ') : `S1=$${rangeLow.toFixed(2)} (range low)`;
        const resistanceStr = resistances.length ? resistances.map((r, i) => `R${i+1}=$${r.toFixed(2)}`).join('  ') : `R1=$${rangeHigh.toFixed(2)} (range high)`;

        candleBlock = [
          ``,
          `TECHNICAL DATA — ${targetTicker} (${candleConfig.timeframe}, ${bars.length} bars, ${tradeHorizon} horizon)`,
          `  Price   : $${price} | RSI(14): ${tech.rsi != null ? tech.rsi.toFixed(1) : 'N/A'} | Momentum: ${tech.momentum ?? 'N/A'}%`,
          `  ATR     : $${atr.toFixed(2)} (${atrPct.toFixed(1)}%) — ${volLabel} volatility`,
          `  Support : ${supportStr}`,
          `  Resist  : ${resistanceStr}`,
          `  S1→S2 gap: ${s2 ? `$${(s1 - s2).toFixed(2)} — second floor risk if S1 breaks` : 'no confirmed S2 in range'}`,
          ``,
          `PRICING RULES:`,
          `  BUY  → target S1 $${s1.toFixed(2)}. Second floor: ${s2 ? `S2=$${s2.toFixed(2)}` : 'unknown'}. ${volLabel === 'HIGH' ? `HIGH ATR — widen buffer, stops are hard to place.` : ''}`,
          `  SELL → target R1 $${r1.toFixed(2)}.`,
        ].join('\n');

        console.log(`[DEBATE] 📊 ${tradeHorizon} | ${targetTicker}: ATR=$${atr.toFixed(2)} (${atrPct.toFixed(1)}%) | S1=$${s1.toFixed(2)} S2=${s2?.toFixed(2) ?? 'N/A'} | R1=$${r1.toFixed(2)}`);
      }
    } catch (err) {
      console.warn(`[DEBATE] ⚠ Candle fetch failed for ${targetTicker}: ${err.message}`);
    }

    // Build conversation — inject technical data before Phi/Theta so both agents are grounded
    // Scout already selected the ticker; no redundant LLM call needed here
    const conversation = [
      { role: "user", content: `CONTEXT: ${briefing}\nPRIMARY_TARGET: ${targetTicker}\nVIX: ${liveVix}${candleBlock}` },
    ];

    const bullThesis = await this.bull.assessInfo(`Bull case for ${targetTicker}`, conversation, briefing, portfolio, buyingPower, openAccountOrders);
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.assessInfo(`Bear case for ${targetTicker}`, conversation, portfolio, liveVix, openAccountOrders);
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // 4. THETA VETO
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

    const liveContext = `LIVE_PRICE_${targetTicker}: $${liveQuote.price}. Time: ${estTime} EST. Remaining Day Trades: ${remainingTrades}${candleBlock}`;

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

    // 5. POST-PROCESS AND SAFETY CHECKS
    const ROTATION_FLOOR_PCT  = -3.0;  // held position must be down ≥3% to qualify as rotation sell
    const MIN_ORDER_NOTIONAL  = 1.00;  // USD — SnapTrade rejects anything below broker minimum
    // If there's a SELL in the verdict, it's a rotation — freed capital covers the BUY,
    // so the minimum notional check should not block it.
    const isRotation = rawVerdicts.some(v => v.action === "SELL");
    const finalTrades = [];
    for (const v of rawVerdicts) {
      if (v.action === "WAIT") continue;

      // SELL unit validation — clamp to actual held quantity so we never oversell
      if (v.action === "SELL" && v.units != null) {
        const heldPos = cleanedPortfolio.find(p => p.symbol === v.symbol);
        if (heldPos) {
          const heldUnits = parseFloat(heldPos.quantity ?? heldPos.units ?? 0);
          const sellUnits = parseFloat(v.units);
          if (!isNaN(heldUnits) && heldUnits > 0 && sellUnits > heldUnits + 0.001) {
            console.warn(`[DEBATE] ⚠ SELL unit clamp — ${v.symbol}: requested ${sellUnits} but only hold ${heldUnits}. Clamping.`);
            v.units = heldUnits;
          }
        }
      }

      // Rotation guard — mechanical, not prompt-based.
      // Block SELL on a held position unless it's actually down ≥3%.
      // Allows deliberate profit-take SELLs (pnlPct > 0) and stop-loss SELLs (pnlPct < -3).
      if (v.action === "SELL") {
        const held = cleanedPortfolio.find(p => p.symbol === v.symbol);
        if (held) {
          const pnlPct = parseFloat(held.pnl_pct);
          if (!isNaN(pnlPct) && pnlPct > ROTATION_FLOOR_PCT && pnlPct < 0) {
            // Only block negative-P&L sells that haven't crossed the -3% floor (noise zone)
            console.warn(`[DEBATE] 🛑 Rotation SELL blocked — ${v.symbol} P&L: ${pnlPct.toFixed(2)}% is in noise zone (floor: ${ROTATION_FLOOR_PCT}%). Dropping.`);
            continue;
          }
        }
      }

      // Minimum viable order check — only applies to pure BUYs with no rotation SELL.
      // If a SELL is in the same batch, freed proceeds cover the BUY — don't block it.
      if (v.action === "BUY" && !isRotation) {
        const notional = v.notional_value ?? (v.units && v.price ? v.units * v.price : 0);
        if (notional < MIN_ORDER_NOTIONAL) {
          console.warn(`[DEBATE] 🛑 BUY blocked — ${v.symbol} notional $${notional.toFixed(2)} below minimum $${MIN_ORDER_NOTIONAL} and no rotation SELL to cover it.`);
          continue;
        }
      }

      // Price drift safety (only for the primary ticker we quoted)
      if (v.symbol === targetTicker && !this._isPriceSafe(v.price, liveQuote.price)) {
        console.warn(`[REDLINE] Price drift too high for ${v.symbol}. Skipping.`);
        continue;
      }

      finalTrades.push({
        ...v,
        symbol: v.symbol || targetTicker,
        transcript: conversation
      });
    }

    // 6. SORT TRADES: SELLS FIRST (Mechanical necessity for rotation)
    const sorted = finalTrades.sort((a, b) => (a.action === "SELL" ? -1 : 1));

    return sorted;
  }
}