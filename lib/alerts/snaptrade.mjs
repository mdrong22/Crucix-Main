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
    // Fix 1: Resolves universal_symbol_id via resolveSymbolId() — was always null
    // Fix 2: price only sent for Limit/Stop/StopLimit — was sending NaN for Market orders
    // Fix 3: units validated before anything fires — rejects null/NaN/zero from LLM output
    // Fix 4: symbol key removed from payload — SnapTrade rejects when both are present
    // Fix 5: Full error body logged with per-status-code hints
    async PlaceOrder(data) {
        if (!data || data.action === "WAIT") {
            console.log("[REDLINE] Execution skipped: Gregor rendered a WAIT verdict.");
            return null;
        }

        // Validate units — Gregor can return null or a string
        const units = parseFloat(data.units);
        if (!units || isNaN(units) || units <= 0) {
            console.error(`[REDLINE] ❌ Invalid units: "${data.units}". Aborting order for ${data.symbol}.`);
            return null;
        }

        console.log(`[REDLINE] Attempting ${data.action} order for ${data.symbol}...`);

        // Resolve ticker → universal_symbol_id
        const universalSymbolId = await this.resolveSymbolId(data.symbol);
        if (!universalSymbolId) {
            console.error(
                `[REDLINE] ❌ Cannot place order — symbol ID resolution failed for "${data.symbol}". ` +
                `Verify the ticker exists on a SnapTrade-supported exchange.`
            );
            return null;
        }

        // Price is only valid (and required) for Limit/Stop/StopLimit orders
        // Market orders must NOT include a price field or SnapTrade returns 400
        const requiresPrice = ["Limit", "StopLimit", "Stop"].includes(data.order_type);
        const orderPrice = requiresPrice ? parseFloat(data.price) : undefined;

        if (requiresPrice && (!orderPrice || isNaN(orderPrice) || orderPrice <= 0)) {
            console.error(
                `[REDLINE] ❌ "${data.order_type}" requires a valid price but got "${data.price}". Aborting.`
            );
            return null;
        }

        // Build the payload — universal_symbol_id replaces symbol
        const orderPayload = {
            userId: this.userId,
            userSecret: this.userSecret,
            accountId: this.accountId,  
            action: String(data.action).toUpperCase(),
            universal_symbol_id: universalSymbolId,
            order_type: String(data.order_type),
            time_in_force: String(data.time_in_force || "Day"),
            units: units,
            trading_session: String(data.trading_session || "REGULAR"),
            notional_value: data.notional_value ? Number(data.notional_value) : null,
        };

        // Only attach price when required
        if (requiresPrice && orderPrice) {
            orderPayload.price = orderPrice;
        }

        console.log(`[REDLINE] Order payload:`, JSON.stringify(orderPayload, null, 2));

        try {
            const response = await this.snaptrade.trading.placeForceOrder(orderPayload);
            const orderId = response?.data?.id || response?.data?.order_id || 'N/A';
            console.log(`[REDLINE] ✅ Order Successful: ${data.symbol} | ID: ${orderId}`);
            return response.data;

        } catch (error) {
    // SnapTrade SDK uses Axios — error shape is different from fetch
    // error.response = Axios response object { status, data, headers }
    // error.response?.data may be a Buffer, string, or object depending on SDK version
            
            const status = error?.response?.status ?? '?';
            
            // Handle Buffer response body (some SDK versions return Buffer)
            let responseBody = error?.response?.data;
            if (Buffer.isBuffer(responseBody)) {
                responseBody = responseBody.toString('utf8');
            }
            if (typeof responseBody === 'object' && responseBody !== null) {
                responseBody = JSON.stringify(responseBody);
            }
            
            const apiMessage =
                error?.response?.data?.message ||
                error?.response?.data?.detail ||
                error?.response?.data?.error ||
                error?.message ||
                'Unknown error';

            console.error(`[REDLINE] ❌ SNAPTRADE ORDER FAILED [${data.symbol}] — HTTP ${status}: ${apiMessage}`);
            console.error(`[REDLINE]    Response body: ${responseBody ?? '(empty)'}`);
            console.error(`[REDLINE]    Headers:`, JSON.stringify(error?.response?.headers ?? {}, null, 2));

            if (status === 400) {
                console.error(
                    `[REDLINE] 💡 400 hint: check these fields — ` +
                    `universal_symbol_id=${universalSymbolId}, ` +
                    `price=${orderPrice ?? 'omitted'}, units=${units}, ` +
                    `order_type=${data.order_type}, trading_session=${data.trading_session}`
                );
            } else if (status === 403) {
                console.error(`[REDLINE] 💡 403 hint: userId/userSecret mismatch or account not authorized.`);
            } else if (status === 422) {
                console.error(`[REDLINE] 💡 422 hint: Insufficient buying power or market is closed.`);
            }

            return null;
        }
    }

    async FetchAccountBuyingPower() {
        console.log("[REDLINE] Getting Account Balance For ", this.userId)
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
        console.log("[REDLINE] Getting Account Balance For ", this.userId)
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
        marketState: q.marketState,
        changePct: q.changePct
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
}
