import { Snaptrade as SnapTradeSDK } from "snaptrade-typescript-sdk";

export class SnapTrade {
    constructor(config) {
        this.clientId = config.clientId;
        this.consumerKey = config.consumerKey;
        this.userId = config.userId;
        this.userSecret = config.userSecret;
        this.accountId = config.accountId;
        this.authId = config.authId;
        this.snaptrade = new SnapTradeSDK({clientId: this.clientId, consumerKey: this.consumerKey});
        this.currentPortfolio
        this.currentHoldings
        this.currentBuyingPower
        this.currentValue

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

    async PlaceOrder(data) {
    if (!data || data.action === "WAIT") {
        console.log("[REDLINE] Execution skipped: Gregor rendered a WAIT verdict.");
        return null;
    }
    try {
        console.log(`[REDLINE] Attempting ${data.action} order for ${data.symbol}...`);
        const response = await this.snaptrade.trading.placeForceOrder({
            userId: this.userId,
            userSecret: this.userSecret,
            action: data.action,
            symbol: data.symbol,
            order_type: data.order_type,
            time_in_force: data.time_in_force,
            price: data.price || null,
            units: data.units || null
        });

        console.log(`[REDLINE] Order Successful: ${data.symbol} | ID: ${response.data?.id || 'N/A'}`);
        return response.data;

    } catch (error) {
        // 2. Capture the specific SnapTrade error details
        const errorMsg = error.response?.data?.message || error.message;
        console.error(`[REDLINE] SNAPTRADE API ERROR [${data.symbol}]:`, errorMsg);
        // Return null or re-throw depending on if you want the sweep to stop
        return null; 
    }
}
    async GetAccountBuyingPower() {
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

    async GetAccountTotalValue() {
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

    async GetAccountOrders24h() {
        console.log("[REDLINE] Getting Account Orders (24h) For ", this.userId)
        try {
            const response = await this.snaptrade.accountInformation.getUserAccountRecentOrders({
                accountId: this.accountId,
                userId: this.userId,
                userSecret: this.userSecret
            })
            console.log('[REDLINE] Got Account Orders (24h) Successfully')
            return JSON.stringify(response.data)
        } catch(err) {
            console.error("[REDLINE] SnapTrade Error for Getting Account Balance: ", err.message)
        }
    }

    GetCurrentPortfolio() {
        return this.currentPortfolio
    }

    GetCurrentAcccountHoldings() {
        return this.currentHoldings
    }

    
}