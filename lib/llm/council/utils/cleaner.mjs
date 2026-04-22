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
        const trimmed = rawPortfolio.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.warn("[CLEANER] Received non-JSON string for portfolio cleaning. Returning empty.");
          return [];
        }
        data = JSON.parse(rawPortfolio);
      }
      
      if (!Array.isArray(data)) return [];

      return data.map(pos => {
        const ticker   = pos.symbol?.symbol?.symbol || pos.symbol?.symbol || "UNKNOWN";
        const units    = parseFloat(pos.fractional_units || pos.units || 0);
        const price    = parseFloat(pos.price || 0);
        const avgPrice = parseFloat(pos.average_purchase_price || 0);

        // Compute P&L from first principles — SnapTrade's open_pnl field is a dollar
        // value, not a ratio. Never multiply it by 100 or the LLM gets e.g. -90% from -$0.90.
        const pnlPct = avgPrice > 0 ? ((price - avgPrice) / avgPrice) * 100 : 0;

        return {
          symbol:   ticker,
          units:    units.toFixed(6),
          price:    price.toFixed(2),
          avg_cost: avgPrice.toFixed(2),
          pnl_pct:  pnlPct.toFixed(2) + "%",
          value:    (units * price).toFixed(2)
        };
      });
    } catch (e) {
      console.error("[CLEANER] Portfolio parse failed:", e.message);
      return [];
    }
  },

  /**
   * Converts the cleaned portfolio into a tight string for the LLM.
   * Includes avg_cost (breakeven) and pnl_dollar so the council can reason about
   * cost basis, trade-around targets, and rotation decisions without guessing.
   */
  stringifyPortfolio(cleanedData) {
    if (!Array.isArray(cleanedData) || cleanedData.length === 0) return "No active holdings.";
    return cleanedData
      .map(p => {
        const units    = parseFloat(p.units)    || 0;
        const price    = parseFloat(p.price)    || 0;
        const avgCost  = parseFloat(p.avg_cost) || 0;
        const pnlDollar = ((price - avgCost) * units).toFixed(2);
        const sign     = parseFloat(pnlDollar) >= 0 ? '+' : '';
        return `${p.symbol}: ${p.units} shares @ $${p.price} | cost=$${p.avg_cost} | PnL: ${p.pnl_pct} (${sign}$${pnlDollar})`;
      })
      .join(" | ");
  },

  /**
   * Cleans the Recent Orders (24h) response.
   */
  cleanOrders(rawData) {
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
        type: order.order_type || 'Market',
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
   */
  stringifyOrders(cleanedOrders) {
    if (!Array.isArray(cleanedOrders) || cleanedOrders.length === 0) return "None";
    return cleanedOrders
      .map(o => `${o.action} ${o.units.toFixed(4)} ${o.symbol} @ $${o.price.toFixed(2)} [${o.status}] ${o.time}`)
      .join(' | ');
  },

  /**
   * Cleans Open/Working Orders specifically.
   */
  cleanOpenOrders(rawData) {
    try {
      let data = rawData;
      if (typeof rawData === 'string') {
        const trimmed = rawData.trim();
        if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
          console.warn("[CLEANER] Received pre-stringified open orders. Returning empty array.");
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
      console.error("[CLEANER] Open Orders clean failed:", e.message);
      return [];
    }
  },

  /**
   * Converts cleaned open orders into a compact string for the LLM.
   */
  stringifyOpenOrders(cleanedOrders) {
    const orders = Array.isArray(cleanedOrders) ? cleanedOrders : [];
    if (orders.length === 0) return "NO_OPEN_ORDERS";

    return orders
      .map(o => {
        const price = o.price || o.limit_price || 0;
        const idStr = String(o.id || "000000");
        return `[${o.status || 'OPEN'}] ${o.action} ${o.symbol} | Type: ${o.type} | Price: $${Number(price).toFixed(2)} | ID: ...${idStr.slice(-6)}`;
      })
      .join(' | ');
  },

  /**
   * Cleans the congressional trading data from congress.mjs briefing output.
   * Input: currentData.congress (raw briefing object)
   * Output: lean structured object ready for stringification
   */
  cleanCongress(raw) {
    try {
      if (!raw || raw.status === 'unavailable' || raw.status === 'error') {
        return { available: false, sources: 'House ✗ | Senate ✗', topBuys: [], topSells: [], heavyHitters: [] };
      }

      const sources = `${raw.houseOk ? 'House ✓' : 'House ✗'} | ${raw.senateOk ? 'Senate ✓' : 'Senate ✗'} | ${raw.totalDisclosures ?? 0} disclosures (last ${raw.lookbackDays ?? 45}d)`;

      const topBuys = (Array.isArray(raw.topBuys) ? raw.topBuys : [])
        .slice(0, 8)
        .map(b => ({
          ticker:      String(b.ticker || '').toUpperCase().trim(),
          memberCount: Number(b.memberCount ?? b.members?.length ?? 0),
          clustered:   Boolean(b.clustered),
          volumeK:     Math.round((b.totalBuyVolume ?? 0) / 1000),
          buyCount:    Number(b.buyCount ?? 0),
          members:     Array.isArray(b.members) ? b.members.slice(0, 4).join(', ') : '',
        }))
        .filter(b => b.ticker.length >= 1 && b.ticker.length <= 5);

      const topSells = (Array.isArray(raw.topSells) ? raw.topSells : [])
        .slice(0, 4)
        .map(s => ({
          ticker:      String(s.ticker || '').toUpperCase().trim(),
          memberCount: Number(s.memberCount ?? s.members?.length ?? 0),
          volumeK:     Math.round((s.totalSellVolume ?? 0) / 1000),
          sellCount:   Number(s.sellCount ?? 0),
        }))
        .filter(s => s.ticker.length >= 1 && s.ticker.length <= 5);

      const heavyHitters = (Array.isArray(raw.heavyHitters) ? raw.heavyHitters : [])
        .slice(0, 5)
        .map(h => ({
          member:      String(h.member || 'Unknown'),
          chamber:     String(h.chamber || ''),
          ticker:      String(h.ticker || '').toUpperCase().trim(),
          amountLabel: String(h.amountLabel || ''),
          date:        String(h.date || ''),
        }))
        .filter(h => h.ticker.length >= 1 && h.ticker.length <= 5);

      return { available: true, sources, topBuys, topSells, heavyHitters };

    } catch (e) {
      console.error('[CLEANER] Congress clean failed:', e.message);
      return { available: false, sources: 'parse error', topBuys: [], topSells: [], heavyHitters: [] };
    }
  },

  /**
   * Converts cleaned congressional data into a compact string for LLM injection.
   * Token-efficient: no redundant prose, no JSON blobs.
   */
  stringifyCongress(cleaned) {
    if (!cleaned || !cleaned.available) {
      return 'Congressional trading data unavailable this cycle.';
    }

    const lines = [`CONGRESSIONAL TRADES | ${cleaned.sources}`];

    if (cleaned.topBuys.length > 0) {
      lines.push('BUYS:');
      for (const b of cleaned.topBuys) {
        const flag    = b.clustered ? ' [CLUSTER⭐]' : '';
        const members = b.members   ? ` (${b.members})` : '';
        lines.push(`  ${b.ticker}${flag} — ${b.memberCount} member(s) ~$${b.volumeK}k × ${b.buyCount} trade(s)${members}`);
      }
    } else {
      lines.push('BUYS: none in lookback window');
    }

    if (cleaned.topSells.length > 0) {
      lines.push('SELLS (distribution signal):');
      for (const s of cleaned.topSells) {
        lines.push(`  ${s.ticker} — ${s.memberCount} member(s) ~$${s.volumeK}k × ${s.sellCount} trade(s)`);
      }
    }

    if (cleaned.heavyHitters.length > 0) {
      lines.push('HEAVY HITTERS (>$100k single trades):');
      for (const h of cleaned.heavyHitters) {
        lines.push(`  ${h.member} (${h.chamber}): BUY ${h.ticker} ${h.amountLabel} on ${h.date}`);
      }
    }

    // Derive clustered tickers for quick Scout reference
    const clustered = cleaned.topBuys.filter(b => b.clustered).map(b => b.ticker);
    if (clustered.length > 0) {
      lines.push(`CLUSTER ALERT: ${clustered.join(', ')} — multiple members, highest conviction → consider LONG horizon`);
    }

    return lines.join('\n');
  },
};