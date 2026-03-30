/**
 * data_cleaner.mjs — Token Optimization Utilities
 * Specifically designed to strip SnapTrade's verbose JSON into 
 * lean strings for LLM context.
 */

export const DataCleaner = {
    /**
     * Cleans the getUserAccountPositions response.
     * Input: Raw SnapTrade JSON Array
     * Output: Array of lean objects { symbol, units, price, avg_cost, pnl_pct }
     */
    cleanPortfolio(rawPortfolio) {
      try {
        const data = typeof rawPortfolio === 'string' ? JSON.parse(rawPortfolio) : rawPortfolio;
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
     */
    stringifyPortfolio(cleanedData) {
      if (!cleanedData || cleanedData.length === 0) return "No active holdings.";
      return cleanedData
        .map(p => `${p.symbol}: ${p.units} shares @ $${p.price} (PnL: ${p.pnl_pct})`)
        .join(" | ");
    },
  
    /**
     * Cleans the Recent Orders (24h) response.
     */
    cleanOrders(rawOrders) {
      try {
        const data = typeof rawOrders === 'string' ? JSON.parse(rawOrders) : rawOrders;
        if (!Array.isArray(data)) return [];
  
        return data.slice(0, 5).map(o => {
          return {
            symbol: o.symbol?.symbol || "UNK",
            action: o.action,
            status: o.status,
            type: o.order_type
          };
        });
      } catch (e) {
        return [];
      }
    }
  };