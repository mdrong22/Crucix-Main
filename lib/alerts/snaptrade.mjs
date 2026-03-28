import { Snaptrade as SnapTradeSDK } from "snaptrade-typescript-sdk";
import { GetLiveQuote as yfLive } from "../../apis/sources/yfinance.mjs";

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
            this.currentPortfolio = JSON.stringify(response.data)
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

   // ─── FIXED: PlaceOrder ────────────────────────────────────────────────────
/**
 * PlaceOrder — Raw Execution Mode
 * Trusting Gregor's JSON 1:1 to bypass validation conflicts.
 */
async PlaceOrder(data) {
    if (!data || data.action === "WAIT") {
        console.log("[REDLINE] Execution skipped: WAIT verdict.");
        return null;
    }

    const universalSymbolId = await this.resolveSymbolId(data.symbol);
    if (!universalSymbolId) {
        console.error(`[REDLINE] ❌ Aborted: Could not resolve ID for ${data.symbol}`);
        return null;
    }

    // 1. DIRECT MAPPING
    // We take exactly what Gregor gave us. No manual 'isFractional' recalculation.
    const orderPayload = {
        userId: this.userId,
        userSecret: this.userSecret,
        accountId: this.accountId,
        action: String(data.action).toUpperCase(),
        universal_symbol_id: universalSymbolId,
        order_type: data.order_type || "Limit",
        time_in_force: data.time_in_force || "GTC",
        trading_session: data.trading_session || "EXTENDED",
        notational_value: data.notational_value
    };

    // 2. EXCLUSIVE FIELD LOGIC
    // SnapTrade 400s if both exist. We prioritize notational_value if it's there.
    if (data.notational_value && data.notational_value > 0) {
        orderPayload.notational_value = parseFloat(data.notational_value);
        orderPayload.units = null; 
    } else {
        orderPayload.units = parseFloat(data.units);
        orderPayload.notational_value = null;
    }

    if (orderPayload.order_type !== "Market") {
        orderPayload.price = parseFloat(data.price);
    }

    console.log(`[REDLINE] 🚀 FINAL PAYLOAD:`, JSON.stringify(orderPayload, null, 2));

    // 3. SEND
    try {
        const response = await this.snaptrade.trading.placeForceOrder(orderPayload);
        console.log(`[REDLINE] ✅ SUCCESS: ${data.symbol} Order Placed.`);
        return response.data;
    } catch (error) {
        const errData = error?.response?.data;
        console.error(`[REDLINE] ❌ SNAPTRADE REJECTED:`, JSON.stringify(errData || error.message));
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

    async FetchAccountOrders24h() {
        console.log("[REDLINE] Getting Account Orders (24h) For ", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountRecentOrders({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log('[REDLINE] Got Account Orders (24h) Successfully')
            this.accountOrders24h = response.data
            return JSON.stringify(response.data)
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
}
