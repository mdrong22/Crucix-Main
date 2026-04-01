/**
 * data_cleaner.mjs — Token Optimization Utilities
 * Specifically designed to strip SnapTrade's verbose JSON into 
 * lean strings for LLM context and dashboard rendering.
 */

export const DataCleaner = {
  /**
   * Cleans the getUserAccountPositions response.
   * Input: Raw SnapTrade JSON Array or String
   * Output: Array of lean objects { symbol, units, price, avg_cost, pnl_pct, value }
   */
  cleanPortfolio(rawPortfolio) {
    try {
      let data = rawPortfolio;
      if (typeof rawPortfolio === 'string') {
        // Safety check: If it's a string but doesn't look like JSON (starts with '[' or '{'),
        // it might be a previously stringified portfolio. Return empty to avoid crash.
        const trimmed = rawPortfolio.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.warn("[CLEANER] Received non-JSON string for portfolio cleaning. Returning empty.");
          return [];
        }
        data = JSON.parse(rawPortfolio);
      }
      
      if (!Array.isArray(data)) return [];

      return data.map(pos => {
        // Deeply nested symbol extraction
        const ticker = pos.symbol?.symbol?.symbol || pos.symbol?.symbol || "UNKNOWN";
        const units = parseFloat(pos.fractional_units || pos.units || 0);
        const price = parseFloat(pos.price || 0);
        const avgPrice = parseFloat(pos.average_purchase_price || 0);
        const pnlPct = parseFloat(pos.open_pnl || 0) * 100;

        return {
          symbol: ticker,
          units: units.toFixed(6),
          price: price.toFixed(2),
          avg_cost: avgPrice.toFixed(2),
          pnl_pct: pnlPct.toFixed(2) + "%",
          value: (units * price).toFixed(2)
        };
      });
    } catch (e) {
      console.error("[CLEANER] Portfolio parse failed:", e.message);
      return [];
    }
  },

  /**
   * Converts the cleaned portfolio into a tight string for the LLM.
   * Safety: Checks if input is an array to prevent .map errors.
   */
  stringifyPortfolio(cleanedData) {
    if (!Array.isArray(cleanedData) || cleanedData.length === 0) return "No active holdings.";
    return cleanedData
      .map(p => `${p.symbol}: ${p.units} shares @ $${p.price} (PnL: ${p.pnl_pct})`)
      .join(" | ");
  },

  /**
   * Cleans the Recent Orders (24h) response.
   * Handles SnapTrade's { orders: [] } wrapper or direct arrays.
   */
  cleanOrders(rawData) {
    try {
      let data = rawData;
      if (typeof rawData === 'string') {
        const trimmed = rawData.trim();
        // If it starts with "BUY" or "SELL", it's already stringified.
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.warn("[CLEANER] Received pre-stringified orders. Returning empty array for re-cleaning.");
          return [];
        }
        data = JSON.parse(rawData);
      }

      const orders = Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
      
      return orders.map(order => ({
        symbol: order.universal_symbol?.symbol || order.symbol || 'UNKNOWN',
        action: order.action, // BUY/SELL
        status: order.status, // EXECUTED/OPEN/CANCELED
        type: order.order_type, // Market/Limit
        // Use filled_quantity for executed orders, total_quantity for pending
        units: parseFloat(order.filled_quantity || order.total_quantity || 0),
        price: parseFloat(order.execution_price || order.limit_price || 0),
        time: order.time_executed || order.time_placed
      }));
    } catch (e) {
      console.error("[CLEANER] Orders clean failed:", e.message);
      return [];
    }
  },

  /**
   * Converts cleaned orders into a compact string for the LLM.
   * Safety: Checks if input is an array to prevent .map errors.
   */
  stringifyOrders(cleanedOrders) {
    if (!Array.isArray(cleanedOrders) || cleanedOrders.length === 0) return "None";
    
    return cleanedOrders
      .map(o => `${o.action} ${o.units.toFixed(4)} ${o.symbol} @ $${o.price.toFixed(2)} [${o.status}]`)
      .join(' | ');
  },

  /**
 * Data Cleaner for SnapTrade Open Orders
 * Extracts vital trading data and discards the deep nested metadata.
 */
  cleanOpenOrders(rawData) {
    try {
      let data = rawData;
      if (typeof rawData === 'string') {
        const trimmed = rawData.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.warn("[CLEANER] Received pre-stringified orders. Returning empty array.");
          return [];
        }
        data = JSON.parse(rawData);
      }

      const orders = Array.isArray(data?.orders) ? data.orders : (Array.isArray(data) ? data : []);
      
      return orders.map(order => ({
        symbol: order.universal_symbol?.symbol || order.symbol || 'UNKNOWN',
        action: order.action,
        status: order.status,
        type: order.order_type || order.type,
        units: parseFloat(order.filled_quantity || order.open_quantity || order.total_quantity || 0),
        price: parseFloat(order.execution_price || order.limit_price || 0),
        time: order.time_executed || order.time_placed,
        id: order.brokerage_order_id || 'N/A'
      }));
    } catch (e) {
      console.error("[CLEANER] Orders clean failed:", e.message);
      return [];
    }
  },

  /**
   * Converts cleaned orders into a compact string for the LLM.
   */
  stringifyOpenOrders(cleanedOrders) {
    // Safety check: ensure input is an array before mapping
    const orders = Array.isArray(cleanedOrders) ? cleanedOrders : [];
    if (orders.length === 0) return "NO_OPEN_ORDERS";
    
    return orders
      .map(o => `[${o.status}] ${o.action} ${o.symbol} | Type: ${o.type} | Price: $${o.price.toFixed(2)} | ID: ...${o.id.slice(-6)}`)
      .join(' | ');
  }
};
