/**
 * debate.mjs — Project RedLine Council Debate Engine
 * Updated to support Multi-Trade Arrays and Rotation Logic.
 */

import { DataCleaner } from "../llm/council/utils/cleaner.mjs";
import { getHistoricalTechnicals } from "../../apis/sources/alpaca.mjs";
import { setSectorForTicker } from "../llm/council/utils/sectorCache.mjs";
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
        // Strip JS-style line comments (// ...) — weak fallback models (e.g. Cerebras llama3.1-8b) add these
        // Only strip outside of string values: match // not preceded by : " or inside a string
        const stripped = jsonToParse
            .replace(/\/\/[^\n"]*/g, '')          // strip // comments
            .replace(/\/\*[\s\S]*?\*\//g, '');    // strip /* block */ comments
        const fixedJson = stripped.replace(/,\s*([}\]])/g, '$1').trim();
        const parsed = JSON.parse(fixedJson);
        
        const finalArray = Array.isArray(parsed) ? parsed : [parsed];
        return finalArray.length > 0 ? finalArray : [{ action: "WAIT" }];
    } catch (e) {
        console.error("[REDLINE] ❌ JSON Parse Failed:", e.message);
        console.error("[REDLINE] Attempted string:", jsonToParse);
        return [{ action: "WAIT" }];
    }
}

  _isPriceSafe(gregorPrice, livePrice, action = null, orderType = null, maxDriftPct = 0.15) {
    if (!gregorPrice || !livePrice) return true;
    const drift = Math.abs(livePrice - gregorPrice) / livePrice;

    // For limit orders: only flag if the price is on the WRONG side of market.
    // A BUY limit BELOW market is intentional (targeting S1). A SELL limit ABOVE market is intentional (targeting R1).
    // These are NOT drift errors — blocking them kills valid swing/long entries.
    if (orderType === 'Limit') {
      if (action === 'BUY'  && gregorPrice <= livePrice) return true;  // below market ✓
      if (action === 'SELL' && gregorPrice >= livePrice) return true;  // above market ✓
      // Limit price on wrong side = already caught by the limit price direction guard
      // But still apply a wide sanity cap (15%) to catch outright hallucinations like $34 vs $70
      return drift <= maxDriftPct;
    }

    // Market orders and unknown types: tight 2% check — price should match live quote closely
    return drift <= 0.02;
  }

  async beginDebate(briefing, context, remainingTrades) {
    console.log("--- 🏁 DEBATE STARTING ---");
    const estTime = new Date().toLocaleString("en-US", {timeZone: "America/New_York"});

    // Detect exit-management debates early — needed to adjust candle block pricing rules
    // and to bypass entry-signal hard blocks (Theta REJECT/WAIT thresholds, R/R, stop-loss).
    // Must be set before candle block construction so the fallback block is framed correctly.
    const isExitDebate = briefing.includes('TRADE AROUND MODE') || briefing.includes('DEFENSIVE MODE') || briefing.includes('AVERAGE DOWN MODE');

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

    // Persist Scout's sector classification — enables dynamic bias for emergent tickers
    const sectorTagMatch = briefing.match(/[-\s]*Sector:\s*([^\n\r]+)/i);
    if (sectorTagMatch && targetTicker) {
        setSectorForTicker(targetTicker, sectorTagMatch[1].trim());
    }

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

    // If candle data is unavailable, inject an explicit warning so agents don't hallucinate levels
    if (!candleBlock) {
      const lp = liveQuote.price;
      if (isExitDebate) {
        // Exit debates with no bar data: R/R, stop-loss, and BUY proxy rules are irrelevant.
        // Theta must NOT compute R/R or cite stop-loss — those concepts apply to new entries, not exits.
        candleBlock = [
          ``,
          `TECHNICAL DATA — ${targetTicker} (NO BAR DATA AVAILABLE — EXIT DEBATE)`,
          `  ⚠ Alpaca returned insufficient bar history for ${targetTicker}.`,
          `  Live Price : $${lp}`,
          `  S1 / S2 / R1 / ATR : UNKNOWN`,
          `EXIT DEBATE PRICING RULES (no-data fallback):`,
          `  The only relevant question: is the stated Sell_Target reachable from $${lp}?`,
          `  ⛔ R/R calculations DO NOT apply to exit orders — do NOT compute or cite R/R.`,
          `  ⛔ Stop-loss levels DO NOT apply to exit orders — do NOT apply BUY entry stop rules.`,
          `  ⛔ Sizing modifiers (missing-data halving, win-rate adjustments) DO NOT apply to exits.`,
          `  Phi + Theta: validate sell target only. If target is within $${(lp * 0.03).toFixed(2)} of live price → ACHIEVABLE. Flag only if momentum is in freefall making the target genuinely unreachable.`,
        ].join('\n');
      } else {
        candleBlock = [
          ``,
          `TECHNICAL DATA — ${targetTicker} (NO BAR DATA AVAILABLE)`,
          `  ⚠ Alpaca returned insufficient bar history for ${targetTicker}.`,
          `  Live Price : $${lp} (from quote API — use this as the price anchor)`,
          `  S1 / S2 / R1 / ATR : UNKNOWN — do NOT invent levels from training data.`,
          `PRICING RULES (no-data fallback):`,
          `  BUY  → use current price $${lp} as anchor. Apply -2% as proxy entry ($${(lp * 0.98).toFixed(2)}). Size at MINIMUM tier.`,
          `  SELL → use current price $${lp} as anchor. Apply +2% as proxy target ($${(lp * 1.02).toFixed(2)}).`,
          `  Stop-Loss → use -5% from entry as default ($${(lp * 0.93).toFixed(2)}) until real levels are confirmed.`,
          `  If Theta flagged missing S1/S2: SIZING MUST BE HALVED per missing-data rule.`,
        ].join('\n');
      }
      console.warn(`[DEBATE] ⚠ No candle data for ${targetTicker} — injecting no-data fallback block. Gregor must use minimum sizing.`);
    }

    // Build conversation — inject technical data before Phi/Theta so both agents are grounded
    // Scout already selected the ticker; no redundant LLM call needed here
    const conversation = [
      { role: "user", content: `CONTEXT: ${briefing}\nPRIMARY_TARGET: ${targetTicker}\nVIX: ${liveVix}${candleBlock}` },
    ];

    const bullThesis = await this.bull.assessInfo(
      isExitDebate
        ? `EXIT MANAGEMENT — validate that the sell target for ${targetTicker} is achievable. DO NOT build a bull case for buying ${targetTicker}. Answer only: can price reach the sell target within the stated horizon?`
        : `Bull case for ${targetTicker}`,
      conversation, briefing, portfolio, buyingPower, openAccountOrders
    );
    conversation.push({ role: "assistant", name: "Phi", content: bullThesis });

    const bearThesis = await this.bear.assessInfo(
      isExitDebate
        ? `EXIT MANAGEMENT — validate that the sell target for ${targetTicker} is technically reachable. DO NOT issue REJECT for entry-quality reasons. Issue WAIT only if the sell target is genuinely unreachable given current momentum and technicals.`
        : `Bear case for ${targetTicker}`,
      conversation, portfolio, liveVix, openAccountOrders
    );
    conversation.push({ role: "assistant", name: "Theta", content: bearThesis });

    // 4. THETA VETO — entry signal hard blocks. Skipped entirely for exit debates.
    const thetaVerdictMatch = bearThesis.match(/THETA\s+VERDICT:\s*(REJECT|WAIT|PROCEED)/i);
    const thetaVerdict = thetaVerdictMatch?.[1]?.toUpperCase() || null;
    const scoreMatch   = briefing.match(/Signal\s*Score:\s*(\d+)/i);
    const signalScore  = scoreMatch ? parseInt(scoreMatch[1], 10) : 0;

    if (isExitDebate) {
      // Exit debates: Theta WAIT = sell target unreachable → stand down.
      // Theta REJECT = misfire (entry-quality reasoning crept in) → log and proceed anyway.
      if (thetaVerdict === 'WAIT') {
        console.log(`[REDLINE] 🛑 Theta WAIT on exit debate — sell target flagged as unreachable for ${targetTicker}. Standing down.`);
        return [{ action: 'WAIT' }];
      }
      if (thetaVerdict === 'REJECT') {
        console.warn(`[REDLINE] ⚠ Theta REJECT on exit debate for ${targetTicker} — likely entry-quality reasoning misfired. Proceeding to Gregor with flag.`);
      }
    } else {
      // ── R/R hard-block: if Theta cites R/R < 1:1 on a REJECT, no score overrides it ──
      if (thetaVerdict === 'REJECT') {
        const rrMatch = bearThesis.match(/(?:R\/R|R:R|risk[\s\/\-]*reward)(?:[\s\w]*(?:ratio|of|is|=|:))?\s*([0-9]+\.?[0-9]*)/i);
        const rr = rrMatch ? parseFloat(rrMatch[1]) : null;
        if (rr !== null && rr < 1.0) {
          console.log(`[REDLINE] 🛑 Theta REJECT + R/R ${rr.toFixed(2)} < 1:1 — hard block. Risk exceeds reward regardless of score.`);
          return [{ action: 'WAIT' }];
        }
      }

      // REJECT hard-blocks only genuinely weak signals (score < 6).
      if (thetaVerdict === 'REJECT' && signalScore < 6) {
        console.log(`[REDLINE] 🛑 Theta VETO — verdict: REJECT, score: ${signalScore}/10 (threshold: 6). Council stands down.`);
        return [{ action: 'WAIT' }];
      }
      if (thetaVerdict === 'REJECT') {
        console.warn(`[REDLINE] ⚠ Theta REJECT but score ${signalScore} ≥ 6 — escalating to Gregor with veto flag.`);
      }

      // ── Undefined stop-loss hard-block ───────────────────────────────────────
      const undefinedStop = /STOP:\s*(?:undefined|no\s+data|N\/A|unknown|\$?0(?:\.0+)?)/i.test(bearThesis)
                         || /(?:undefined|no\s+(?:defined?|real|actual))\s+stop/i.test(bearThesis)
                         || /stop.{0,30}(?:undefined|cannot\s+be\s+defined|no\s+data)/i.test(bearThesis);
      if ((thetaVerdict === 'WAIT' || thetaVerdict === 'REJECT') && undefinedStop) {
        console.log(`[REDLINE] 🛑 Theta flagged undefined stop-loss — hard block. Cannot enter without a quantifiable exit level.`);
        return [{ action: 'WAIT' }];
      }

      // WAIT hard-blocks at score < 7.
      if (thetaVerdict === 'WAIT' && signalScore < 7) {
        console.log(`[REDLINE] 🛑 Theta WAIT + score ${signalScore} < 7 — insufficient conviction to override. Council stands down.`);
        return [{ action: 'WAIT' }];
      }
      if (thetaVerdict === 'WAIT') {
        console.warn(`[REDLINE] ⚠ Theta WAIT but score ${signalScore} ≥ 7 — escalating to Gregor with wait flag.`);
      }
    }

    const liveContext = `LIVE_PRICE_${targetTicker}: $${liveQuote.price}. Time: ${estTime} EST. Remaining Day Trades: ${remainingTrades}${candleBlock}`;

    // 5. GREGOR VERDICT (Now expects a list)
    const verdictInstruction = [
      liveContext,
      isExitDebate
        ? `EXIT MODE: This is a SELL order, not a new entry. Win-rate modifiers and signal-score sizing rules DO NOT apply. Execute the specified sell at the stated price and units. Output WAIT only if Phi or Theta flagged the sell target as genuinely unreachable.`
        : '',
      !isExitDebate && thetaVerdict === 'REJECT' ? `⚠ THETA VETO FLAG: Theta issued REJECT. Signal score (${signalScore}) clears the hard-block threshold, so you may evaluate — but you are NOT cleared to proceed automatically. You MUST identify Theta's PRIMARY RISK (the specific named risk, not a generic restatement), provide a concrete data-point counter to it, and confirm R/R ≥ 1:1 before proceeding. "Signal score overrides the threshold" is NOT a valid justification — it is circular. If you cannot name a specific counter to Theta's primary risk, or if R/R < 1:1, output WAIT.` : '',
      !isExitDebate && thetaVerdict === 'WAIT'   ? `⚠ THETA WAIT FLAG: Theta issued WAIT (score ${signalScore} clears the override threshold). You MAY proceed, but you MUST name Theta's specific primary risk in Logic under "Bear Response" and state why you are overriding it with a concrete counter-argument. If you cannot provide a concrete counter, output WAIT.` : '',
      `ROTATION_RULE: If rotating from one symbol to another, output a LIST: [{"action":"SELL",...}, {"action":"BUY",...}].`,
      `SELL_RULE: If "order_type" is "Limit" (required for EXTENDED sessions), you CANNOT use "notional_value, however prefer units for SELL in general".`,
      `FRACTIONAL RULE: If the units value is a decimal (e.g., 0.04), you MUST set time_in_force to 'Day'. Use 'GTC' only for whole-number units (e.g., 1, 2, 10).`,
      `// VERDICT MUST BE AN ARRAY EVEN IF THERE IS 1 ORDER`,
      `VERDICT: [{"symbol":"...","action":"...","order_type":"...","price":...,"units":...,"notional_value":...}]`
    ].filter(Boolean).join('\n');
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

      // Limit order price direction guard — catches contradictory prices before SnapTrade rejects them.
      // BUY Limit above market = overpay / never-fill paradox. SELL Limit below market = value destruction.
      if (v.order_type === 'Limit' && v.price != null && liveQuote?.price) {
        const market = liveQuote.price;
        if (v.action === 'BUY' && v.price > market) {
          const corrected = technicalCtx.s1 ?? market;
          console.warn(`[DEBATE] ⚠ BUY Limit price $${v.price} is ABOVE market $${market} — contradictory order. Correcting to S1=$${corrected.toFixed(2)}.`);
          v.price = parseFloat(corrected.toFixed(2));
        } else if (v.action === 'SELL' && v.price < market) {
          const corrected = technicalCtx.r1 ?? market;
          console.warn(`[DEBATE] ⚠ SELL Limit price $${v.price} is BELOW market $${market} — contradictory order. Correcting to R1=$${corrected.toFixed(2)}.`);
          v.price = parseFloat(corrected.toFixed(2));
        }
      }

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
          console.warn(`[DEBATE] 🛑 BUY blocked — ${v.symbol} notional $${notional.toFixed(2)} is below minimum $${MIN_ORDER_NOTIONAL}. Likely a win-rate modifier math error. Dropping.`);
          continue;
        }
        // Sanity cap: flag suspiciously tiny notionals even above the $1 floor
        if (notional < 5.00) {
          console.warn(`[DEBATE] ⚠ BUY notional $${notional.toFixed(2)} for ${v.symbol} is suspiciously small — win-rate modifier may have compounded incorrectly. Proceeding but flagging.`);
        }
      }

      // Price drift safety (only for the primary ticker we quoted)
      if (v.symbol === targetTicker && !this._isPriceSafe(v.price, liveQuote.price, v.action, v.order_type)) {
        console.warn(`[REDLINE] 🛑 Price drift too high for ${v.symbol} — Gregor: $${v.price}, Live: $${liveQuote.price} (${((Math.abs(liveQuote.price - v.price)/liveQuote.price)*100).toFixed(1)}% drift). Skipping.`);
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