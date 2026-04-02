/**
 * Processes raw SnapTrade order history to find remaining day trades.
 * @param {Array} orderHistory - The .data array from FetchOrderCompliance()
 * @returns {number} - Number of day trades remaining (0-3)
 */
export function calculateRemainingDayTrades(orderHistory) {
    if (!Array.isArray(orderHistory)) return 3;

    const dayTradeLog = {};

    // 1. Group executed orders by date and symbol
    orderHistory
        .filter(order => order.status === "EXECUTED")
        .forEach(order => {
            // Use the execution time, converted to local date string (YYYY-MM-DD)
            const execDate = new Date(order.time_executed).toISOString().split('T')[0];
            const symbol = order.universal_symbol.symbol;
            const action = order.action; // "BUY" or "SELL"

            if (!dayTradeLog[execDate]) dayTradeLog[execDate] = {};
            if (!dayTradeLog[execDate][symbol]) dayTradeLog[execDate][symbol] = new Set();

            dayTradeLog[execDate][symbol].add(action);
        });

    // 2. Count how many symbols had both BUY and SELL on the same day
    let tradesUsed = 0;
    for (const date in dayTradeLog) {
        for (const symbol in dayTradeLog[date]) {
            const actions = dayTradeLog[date][symbol];
            if (actions.has("BUY") && actions.has("SELL")) {
                tradesUsed++;
                console.log(`[COMPLIANCE] Found Day Trade: ${symbol} on ${date}`);
            }
        }
    }

    // 3. Return remaining (min 0)
    const remaining = Math.max(0, 3 - tradesUsed);
    return remaining;
}