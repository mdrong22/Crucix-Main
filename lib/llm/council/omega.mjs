import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AnthropicProvider } from "../anthropic.mjs";
import { init } from "@heyputer/puter.js/src/init.cjs";

const _gregorDir       = dirname(fileURLToPath(import.meta.url));
const _gregLastReview  = join(_gregorDir, '../../../runs/lastReview.json');

function loadGregorReview() {
  if (!existsSync(_gregLastReview)) return null;
  try { return JSON.parse(readFileSync(_gregLastReview, 'utf8')); }
  catch { return null; }
}

function buildGregorSizingContext(review) {
  if (!review) return null;
  const pct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'N/A';
  const bh  = review.byHorizon || {};
  const bs  = review.bySignal  || {};

  const lines = [
    `=== PERFORMANCE CONTEXT (from review: ${review.generatedAt?.slice(0, 10) || 'unknown'}) ===`,
    `Win Rate: ${pct(review.winRate)} | Profit Factor: ${review.profitFactor === 999 ? '∞' : review.profitFactor?.toFixed(2)} | ${review.resolved} resolved decisions`,
    ``,
    `SIZING MODIFIERS (apply to POSITION SIZING FORMULA):`,
  ];

  // Horizon-based sizing modifiers
  for (const [h, s] of Object.entries(bh)) {
    if (s.winRate >= 0.65) {
      lines.push(`  ${h}: Win rate ${pct(s.winRate)} — apply +15% to standard ${h} sizing.`);
    } else if (s.winRate < 0.40) {
      lines.push(`  ${h}: Win rate ${pct(s.winRate)} — apply -30% to standard ${h} sizing. Reduce conviction.`);
    }
  }

  // Signal modifiers
  const clusterWr = bs.congressionalCluster?.winRate;
  if (clusterWr != null && (bs.congressionalCluster?.decisions || 0) >= 3) {
    if (clusterWr >= 0.70) {
      lines.push(`  Congressional Cluster: ${pct(clusterWr)} win rate — apply +20% sizing when cluster signal confirmed.`);
    } else if (clusterWr < 0.50) {
      lines.push(`  Congressional Cluster: ${pct(clusterWr)} win rate — size at minimum tier until rate recovers.`);
    }
  }

  const highVixWr = bs.highVix?.winRate;
  if (highVixWr != null && highVixWr < 0.45 && (bs.highVix?.decisions || 0) >= 3) {
    lines.push(`  High-VIX: ${pct(highVixWr)} win rate — reduce sizing to minimum tier on VIX ≥ 25 setups.`);
  }

  // Recommendations
  if (review.recommendations?.length) {
    lines.push(``, `Priority council directive: ${review.recommendations[0]}`);
  }

  return lines.join('\n');
}

/**
 * gregor.mjs — Gregor, Master Macro Decider
 *
 * FIXES:
 *  1. VIX no longer hardcoded at 27.45 — passed in live via assessInfo signature
 *  2. VERDICT output format now specifies full JSON object (was just BUY|SELL|WAIT word —
 *     debate.mjs's JSON extractor always failed, causing every trade to default to WAIT)
 *  3. assessInfo signature updated to accept vix parameter
 *  4. Debate context injected as user-turn message so Gregor sees Phi + Theta arguments
 */

import { DataCleaner } from "./utils/cleaner.mjs";

export class GregorLLM extends AnthropicProvider {
    constructor(config) {
        super(config);
        this.name = 'gregor';
        this.puter = init(config.apiKey)
    }

    async usePuter(systemPrompt, userMessage) {
      console.log(`[GREGOR] Thinking...`);
      const messages = [
          { role: 'system', content: systemPrompt },
          ...(Array.isArray(userMessage) 
              ? userMessage 
              : [{ role: 'user', content: userMessage }])
      ];
      try {
          const response = await this.puter.ai.chat(messages, {
              model: this.model,
              temperature: 0.1,
              use_web: true,
              favour_speed: true 
          });
          const raw = response.toString();
          let sanitized = raw.replace(/https?:\/\/googleusercontent\.com\/immersive_entry_chip\/\d+/gi, '');
          let cleaned = sanitized.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
          const firstJSONChar = cleaned.search(/[\[\{]/); // Finds first { or [
          const lastJSONChar = cleaned.lastIndexOf(']') > cleaned.lastIndexOf('}') 
                              ? cleaned.lastIndexOf(']') 
                              : cleaned.lastIndexOf('}');

          if (firstJSONChar !== -1 && lastJSONChar !== -1) {
              cleaned = cleaned.substring(firstJSONChar, lastJSONChar + 1);
          }
          return `VERDICT: ${cleaned}`;

      } catch (err) {
          console.error(`[GREGOR] ❌ HeyPuter Execution Failed:`, err.message);
          try {
              console.warn("[GREGOR] Attempting Fallback...");
              const fallback = await this.complete(systemPrompt, userMessage)
              return fallback
          } catch (fallbackErr) {
              throw new Error(`Gregor total failure: ${err.message} -> ${fallbackErr.message}`);
          }
      }
    }
    // ── SIGNATURE UPDATED: vix parameter added ───────────────────────────────
    async assessInfo(sysPrompts, conversation, buyingPower, totalValue, orders24h, vix = 'N/A', openAccountOrders, GetPortfolio, remainingTrades) {
        const now = new Date();
        const estString = now.toLocaleString("en-US", { timeZone: "America/New_York" });
        const estDate = new Date(estString);  
        const hours = estDate.getHours();
        const minutes = estDate.getMinutes();
        const currentTimeValue = hours * 100 + minutes;
        const isRegularHours = currentTimeValue >= 930 && currentTimeValue < 1600;
        const marketStatus = isRegularHours ? "REGULAR_MARKET_OPEN" : "EXTENDED_HOURS_RESTRICTED";  
        const port = await GetPortfolio()
        const portfolio = DataCleaner.stringifyPortfolio(port)
        const GregorSysPrompt = `Role: "Gregor", Master Macro Decider & Strategic Commander.
Mission: Synthesize Phi's alpha case and Theta's risk prosecution into the FINAL EXECUTABLE COMMAND.
You are not just executing today's trade — you are stewarding a portfolio with a strategic vision.
Every decision must reflect HORIZON AWARENESS: Intraday, Swing, or Long. Each has different rules.

═══════════════════════════════════════════════════
SECTION 1 — HORIZON-BASED EXECUTION RULES
═══════════════════════════════════════════════════
The Scout has classified the opportunity with a HORIZON. Your verdict MUST respect it:

  INTRADAY (same-day):
    → "time_in_force": "Day" | "trading_session": "REGULAR" only.
    → PDT STRICTLY applies. If Remaining Trades = 0: FORBIDDEN. Pivot to WAIT.
    → Prefer "order_type": "Market" for speed (REGULAR hours only).
    → Smaller size: do NOT overcommit to a same-day trade.

  SWING (2-10 days):
    → "time_in_force": "Day" or "GTC" depending on urgency.
    → PDT does NOT apply to the HOLD — this is an overnight position.
    → Use "order_type": "Limit" for precision entry. Set price near current ask or support.
    → If EXTENDED hours: MUST use "order_type": "Limit" + "trading_session": "EXTENDED".
    → Medium size: 5-10% portfolio allocation typical.

  LONG (weeks/months):
    → "time_in_force": "GTC" — order stays open until filled at your target price.
    → PDT is IRRELEVANT for the hold. This is a position, not a trade.
    → ALWAYS "order_type": "Limit". Set price at a key support or consolidation zone.
    → "trading_session": "REGULAR" preferred (better fills, tighter spreads).
    → Size: 8-15% allocation. If congressional cluster confirmed → lean toward larger.
    → Congressional Cluster Buys: treat as structural signal. These members are positioning
      AHEAD of policy moves. Gregor gives extra weight to multi-member accumulation.

═══════════════════════════════════════════════════
SECTION 2 — STRATEGIC PORTFOLIO MANAGEMENT
═══════════════════════════════════════════════════
Before issuing a verdict, assess the portfolio strategically:
  Portfolio: ${portfolio}
  Buying Power: ${buyingPower} | Total Value: [from context]

  STRATEGIC RULES:
  a) CONCENTRATION CHECK: If one sector > 40% of portfolio → no new adds to that sector.
  b) LONG POSITION MANAGEMENT: Review existing LONGs. If thesis broken (stock -15%+ below entry
     with no catalyst change), consider SELL even if no day-trade triggered it.
  c) CASH DEPLOYMENT: If Buying Power > 30% of total value → capital is idle. LONG/SWING buys
     are especially justified. Idle cash is a drag.
  d) ROTATION DISCIPLINE: When rotating, ALWAYS execute SELL before BUY (output as array, SELL first).

═══════════════════════════════════════════════════
SECTION 3 — PDT SAFETY PROTOCOL (CRITICAL)
═══════════════════════════════════════════════════
  Remaining Day Trades: ${remainingTrades}/3
  Verified Fills (24h): ${orders24h}

  IF ${remainingTrades} === 0:
    - FORBIDDEN from executing a Round Trip (BUY + SELL same ticker same day).
    - Check Verified Fills. Ticker bought today = LOCKED (cannot sell). Ticker sold today = LOCKED (cannot buy back).
    - SWING or LONG entries are PERMITTED (buy today, hold overnight+).
    - This is an opportunity: force a higher-quality SWING/LONG entry instead of gambling an INTRADAY.

  IF ${remainingTrades} > 0:
    - INTRADAY permitted. Still prefer SWING/LONG if the signal warrants it.
    - Don't burn day trades on marginal INTRADAY setups when a cleaner SWING is available.

═══════════════════════════════════════════════════
SECTION 4 — OPEN ORDER DEFENSE
═══════════════════════════════════════════════════
  Scan: ${openAccountOrders}
  - If target ticker already has "ACCEPTED" or "WORKING" order → output "action": "WAIT". Prevents duplicate fills.
  - If a LONG GTC order has been sitting unfilled for >3 days → consider revising price in the Logic section (flag for user).

═══════════════════════════════════════════════════
SECTION 5 — EXECUTION MECHANICS
═══════════════════════════════════════════════════
  Market Status: ${marketStatus}

  EXTENDED HOURS (pre/post market):
    - MUST use "order_type": "Limit", "time_in_force": "GTC", "trading_session": "EXTENDED".
    - NO "notional_value" for Limit orders — calculate "units" from price.
    - Wide spreads in extended hours — set limit price conservatively (ask + $0.10 for buys).

  REGULAR HOURS:
    - INTRADAY/urgent: "order_type": "Market", "time_in_force": "Day" permitted.
    - SWING/LONG: "order_type": "Limit" preferred. Better fills.
    - "notional_value" allowed ONLY for Market orders (no "units" needed).

  POSITION SIZING FORMULA:
    - INTRADAY: notional = min(buyingPower * 0.03, buyingPower * 0.05)
    - SWING: notional = min(buyingPower * 0.08, totalValue * 0.07)
    - LONG: notional = min(buyingPower * 0.12, totalValue * 0.10)
    - Congressional Cluster confirmed → can scale LONG up by 20%
    - Always leave ≥10% buying power in reserve (do not go all-in).

MANDATORY OUTPUT FORMAT:
TARGET: [TICKER]
Horizon: [INTRADAY | SWING | LONG]
Logic: [2-3 sentences: Why Phi's case wins over Theta's risk. PDT status. Strategic rationale.]
VERDICT: [{"symbol":"TICKER","action":"BUY"|"SELL"|"WAIT","order_type":"Limit"|"Market","time_in_force":"Day"|"GTC","price":NUMBER_OR_NULL,"units":POSITIVE_NUMBER_OR_NULL,"notional_value":NUMBER_OR_NULL,"trading_session":"REGULAR"|"EXTENDED"}]
// VERDICT MUST BE AN ARRAY — even for a single order. Rotations = [SELL_obj, BUY_obj].`;

        // ── Phase 4: inject lastReview sizing context ──────────────────────────
        const gregReview     = loadGregorReview();
        const sizingContext  = buildGregorSizingContext(gregReview);

        // ── KEY FIX: all decision data injected as user-turn message ─────────
        // Previously buyingPower/totalValue/orders24h were only string-interpolated
        // into the system prompt. Gregor's base complete() may not see system content
        // the same way — putting it in the user turn ensures it's grounded.
        const dataUserMsg = [
            `=== ACCOUNT STATE ===`,
            `Buying Power: ${buyingPower ?? 'N/A'} USD`,
            `Total Value:  ${totalValue ?? 'N/A'} USD`,
            `Live VIX:     ${vix}`,
            `Remaining Day Trades: ${remainingTrades}/3`,
            ``,
            `=== VERIFIED FILLS (LAST 24H) ===`,
            `${orders24h || '(no recent orders)'}`,
            ``,
            `=== PORTFOLIO & OPEN ORDERS ===`,
            `Current Holdings: ${portfolio}`,
            `Pending Orders: ${openAccountOrders || 'NONE'}`,
            ``,
            ...(sizingContext ? [`${sizingContext}`, ``] : []),
            `=== SCOUT & COUNCIL INPUT ===`,
            `${sysPrompts}`,
            ``,
            `=== FINAL INSTRUCTION ===`,
            `If Remaining Trades is 0, ensure the VERDICT does not create a same-day round trip.`,
        ].join('\n');

        const fullConversation = [
            ...(Array.isArray(conversation) ? conversation : []),
            { role: 'user', content: dataUserMsg },
        ];

        try {
            console.log('[GREGOR] Thinking...');
            const res = await this.usePuter(GregorSysPrompt, fullConversation);
            return res.text ?? res;
        } catch (err) {
            console.error("[RedLine] Gregor failed to reach a verdict:", err.message);
            throw err;
        }
    }
}
