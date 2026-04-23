import { Snaptrade as SnapTradeSDK } from "snaptrade-typescript-sdk";
import { GetLiveQuote as yfLive } from "../../apis/sources/yfinance.mjs";
import { DataCleaner} from "../llm/council/utils/cleaner.mjs";

export class SnapTrade {
    constructor(config) {
        this.clientId = config.clientId;
        this.consumerKey = config.consumerKey;
        this.userId = config.userId;
        this.userSecret = config.userSecret;
        this.accountId = config.accountId;
        this.authId = config.authId;
        this.snaptrade = new SnapTradeSDK({clientId: this.clientId, consumerKey: this.consumerKey});
        this.currentPortfolio;
        this.currentHoldings;
        this.currentBuyingPower;
        this.currentValue;
        this.accountOrders24h;
        this.openAccountOrders;
    }   
       
    async FetchUserTrades() {
        console.log(`[Crucix] Retrieving ${this.userId} portfolio...`)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountPositions({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret,
                },
            );
            console.log(`[Crucix] ${this.userId}'s portfolio successfully retrieved`)
            this.currentPortfolio = DataCleaner.cleanPortfolio(response.data)
            return this.currentPortfolio
        } catch(err) {
            console.error("SnapTrade Error for Trades: ", err.message)
            return []
        }
    }

    async getBuyDates() {
        console.log(`[Crucix] Retrieving Account Orders for ${this.userId}`)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountDetails({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log(`[Crucix] Account Orders for ${this.userId} was successfully retrieved`)
            this.currentHoldings = JSON.stringify(response.data)
            return this.currentHoldings
        } catch(err) {
            console.error("SnapTrade Error for Account Orders: ", err.message)
            return []
        }
    }

    async FetchOpenAccountOrders() {
        console.log(`[Crucix] Retrieving Open Account Orders for ${this.userId}`)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountOrders({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret,
                state: "open"
            })
            console.log(`[Crucix] Open Account Orders for ${this.userId} was successfully retrieved`)
            this.openAccountOrders = DataCleaner.cleanOpenOrders(response.data)
            return this.openAccountOrders
        } catch(err) {
            console.error("SnapTrade Error for OPEN Account Orders: ", err.message)
            return []
        }
    }

    async RefreshHoldings() {
        console.log("[Crucix] Refreshing Holdings for", this.userId)
        try {
            const response = await this.snaptrade.connections.refreshBrokerageAuthorization({
                authorizationId: this.authId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log('[Crucix]', response.data.detail)
        } catch(err) {
            console.error("SnapTrade Error for Refresh Account Holdings: ", err.message)
        }
    }

    // ─── NEW METHOD: resolveSymbolId ──────────────────────────────────────────
    // SnapTrade's placeForceOrder requires universal_symbol_id, not a raw ticker.
    // Passing symbol:"BA" with universal_symbol_id:null was the root cause of the 400.
    async resolveSymbolId(ticker, preferredExchanges = ['NYSE', 'NASDAQ', 'BATS', 'TSX']) {
        try {
            const res = await this.snaptrade.referenceData.getSymbols({
                substring: ticker
            });

            const symbols = res?.data || [];
            if (!symbols.length) {
                console.warn(`[REDLINE] ⚠️  No symbols returned for "${ticker}".`);
                return null;
            }

            // Try preferred exchanges first for an exact ticker match
            for (const exchange of preferredExchanges) {
                const exact = symbols.find(
                    s => s.symbol === ticker && s.listing_exchange?.code === exchange
                );
                if (exact) {
                    console.log(`[REDLINE] ✅ Resolved ${ticker} → id:${exact.id} (${exchange})`);
                    return exact.id;
                }
            }

            // Fall back to any exact symbol match regardless of exchange
            const fallback = symbols.find(s => s.symbol === ticker);
            if (fallback) {
                console.log(`[REDLINE] ✅ Resolved ${ticker} → id:${fallback.id} (${fallback.listing_exchange?.code || 'unknown'})`);
                return fallback.id;
            }

            console.warn(`[REDLINE] ⚠️  Could not find exact match for "${ticker}" in symbol results.`);
            return null;

        } catch (err) {
            console.error(`[REDLINE] ❌ resolveSymbolId failed for "${ticker}":`, err.message);
            return null;
        }
    }

   /**
 * PlaceOrder — Execution Mode (Alpaca Live Rules Enforced)
 *
 * Alpaca live has three hard constraints that paper ignores:
 *   1. Extended hours → Limit orders ONLY. Market orders are rejected.
 *   2. Notional (notional_value) → Market + Day ONLY. Limit orders must use units.
 *   3. GTC + notional → rejected. GTC must always specify units.
 *
 * This method enforces all three before the payload ever leaves the process.
 */
   async PlaceOrder(data) {
    if (!data || data.action === "WAIT") return null;

    const universalSymbolId = await this.resolveSymbolId(data.symbol);

    let orderType     = data.order_type     || "Market";
    let timeInForce   = data.time_in_force  || "Day";
    let tradingSession = data.trading_session || "REGULAR";

    // ── RULE 1: Extended hours → Limit only ──────────────────────────────────
    // Alpaca rejects Market orders outside regular hours. Force Limit + keep session.
    if (tradingSession === "EXTENDED" && orderType === "Market") {
        console.warn(`[REDLINE] ⚠ Extended hours detected — forcing Market → Limit (Alpaca live rule).`);
        orderType = "Limit";
        // If no price provided, fall back to REGULAR to avoid a bad fill
        if (!data.price || parseFloat(data.price) <= 0) {
            console.warn(`[REDLINE] ⚠ No limit price for extended hours order — falling back to REGULAR session Market order.`);
            tradingSession = "REGULAR";
            orderType = "Market";
        }
    }

    // ── RULE 2: Notional → Market + Day only ─────────────────────────────────
    // Alpaca rejects notional_value on Limit orders or GTC. Must convert to units.
    const hasNotional = data.notional_value && parseFloat(data.notional_value) > 0;
    const hasUnits    = data.units && parseFloat(data.units) > 0;

    if (hasNotional && (orderType === "Limit" || timeInForce === "GTC")) {
        console.warn(`[REDLINE] ⚠ notional_value not allowed with ${orderType}/${timeInForce} on Alpaca live — switching to units.`);
        // Estimate units from notional ÷ price if available, else drop notional
        if (data.price && parseFloat(data.price) > 0) {
            const estimatedUnits = parseFloat(data.notional_value) / parseFloat(data.price);
            data = { ...data, units: estimatedUnits.toFixed(6), notional_value: null };
        } else {
            console.warn(`[REDLINE] ⚠ Cannot convert notional to units — no price available. Dropping notional_value.`);
            data = { ...data, notional_value: null };
        }
    }

    // ── Build payload ─────────────────────────────────────────────────────────
    const orderPayload = {
        userId:               this.userId,
        userSecret:           this.userSecret,
        account_id:           this.accountId,
        action:               data.action.toUpperCase(),
        universal_symbol_id:  universalSymbolId,
        order_type:           orderType,
        time_in_force:        timeInForce,
        trading_session:      tradingSession,
    };

    // Quantity: notional takes priority for Market+Day; otherwise units
    if (data.notional_value && parseFloat(data.notional_value) > 0) {
        orderPayload.notional_value = Math.floor(parseFloat(data.notional_value) * 100) / 100;
        delete orderPayload.units;
    } else if (data.units && parseFloat(data.units) > 0) {
        orderPayload.units = Math.floor(parseFloat(data.units) * 1000000) / 1000000; // 6dp for fractional
        delete orderPayload.notional_value;
    }

    // ── RULE 3: Limit orders require a price ─────────────────────────────────
    if (orderPayload.order_type === "Limit") {
        if (data.price && parseFloat(data.price) > 0) {
            orderPayload.price = parseFloat(data.price);
        } else {
            // Can't place a Limit order without a price — downgrade to Market
            console.warn(`[REDLINE] ⚠ Limit order has no price — downgrading to Market.`);
            orderPayload.order_type = "Market";
        }
    }

    // Strip all null/undefined keys — SnapTrade/Alpaca 400s on any empty field
    Object.keys(orderPayload).forEach(key => {
        if (orderPayload[key] === null || orderPayload[key] === undefined) {
            delete orderPayload[key];
        }
    });

    console.log(`[REDLINE] 📤 Placing order:`, JSON.stringify(orderPayload));

    try {
        const response = await this.snaptrade.trading.placeForceOrder(orderPayload);
        return response.data;
    } catch (error) {
        // SnapTrade SDK puts the parsed response body on error.responseBody, not error.response?.data
        const errorDetail = error.responseBody ?? error.response?.data ?? error.message;
        console.error("[REDLINE] ❌ Order failed:", JSON.stringify(errorDetail));
        console.error("[REDLINE] SnapTrade code:", errorDetail?.code, "| detail:", errorDetail?.detail);
        return null;
    }
}

    async FetchAccountBuyingPower() {
        console.log("[REDLINE] Getting Account Balance For", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountBalance({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log('[REDLINE] Returned Account Balance Successfully')
            this.currentBuyingPower = response.data[0].buying_power
            return this.currentBuyingPower
        } catch(err) {
            console.error("[REDLINE] SnapTrade Error for Getting Account Balance: ", err.message)
        }
    }

    async FetchAccountTotalValue() {
        console.log("[REDLINE] Getting Account Balance For", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserHoldings({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log('[REDLINE] Returned Account Balance Successfully')
            this.currentValue = response.data.total_value.value
            return this.currentValue
        } catch(err) {
            console.error("[REDLINE] SnapTrade Error for Getting Account Balance: ", err.message)
        }
    }

    async FetchAccountOrders24h(onlyExecuted = true) {
        console.log("[REDLINE] Getting Account Orders (24h) For ", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountRecentOrders({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret,
                onlyExecuted: onlyExecuted
            })
            console.log('[REDLINE] Got Account Orders (24h) Successfully')
            this.accountOrders24h = DataCleaner.cleanOrders(response.data)
            return this.accountOrders24h
        } catch(err) {
            console.error("[REDLINE] SnapTrade Error for Getting Account Balance: ", err.message)
        }
    }

    async FetchOrderCompliance() {
        console.log("[REDLINE] Getting Account Orders For Trade Compliance ", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountOrders({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret,
                state: "all",
                days: 7
            })
            console.log('[REDLINE] Got Account Orders (7d) Successfully')
            return response.data
        } catch(err) {
            console.error("[REDLINE] SnapTrade Error for Getting Account Balance: ", err.message)
        }
    }

   async GetLiveQuote(ticker) {
    // Keep this for validation/logging if you still want to ensure SnapTrade knows the symbol
    const universalSymbolId = await this.resolveSymbolId(ticker);
    if (!universalSymbolId) {
        throw new Error(`Cannot fetch quote — symbol ID resolution failed for "${ticker}"`);
    }

    // Call your new Yahoo Finance wrapper
    const q = await yfLive(ticker);

    if (!q) throw new Error(`No quote data returned for ${ticker}`);

    // Map Yahoo Finance fields to your established return format
    return {
        // Yahoo's "price" is the current market price (regular or post)
        price: q.price, 
        // Yahoo's chart API doesn't always provide real-time Bid/Ask. 
        // We use the current price as a safe fallback for the order logic.
        bid: q.bid || q.price,
        ask: q.ask || q.price,
        // Volume from the latest historical bar or metadata
        volume: q.volume ?? 0,
        // Keep RSI null as requested
        rsi: null, 
        // Bonus: Passing these through can help Gregor understand market context
        marketState: q.marketState ?? 0,
        changePct: q.changePct ?? 0
    };
}

    GetCurrentPortfolio() {
        return this.currentPortfolio
    }

    GetCurrentAcccountHoldings() {
        return this.currentHoldings
    }

    GetOrders24h() {
        return this.accountOrders24h
    }

    GetAccountTotalValue() {
        return this.currentValue
    }
    GetAccountBuyingPower() {
        return this.currentBuyingPower
    }
    GetOpenAccountOrders() {
        return this.openAccountOrders
    }
}
