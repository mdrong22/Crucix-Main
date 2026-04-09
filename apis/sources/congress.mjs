// congress.mjs — Congressional Trading Intelligence
// Pulls recent stock disclosures from House & Senate members.
// No API key required. Uses public disclosure APIs:
//   House: https://api.housestockwatcher.com/api/transactions
//   Senate: https://api.senatestockwatcher.com/api/transactions
//
// STRATEGY SIGNAL: Congress members are often ahead of major policy/contract news.
// Clustering (multiple members buying the same ticker) is highest-conviction signal.

import { safeFetch } from '../utils/fetch.mjs';

const HOUSE_API  = 'https://api.housestockwatcher.com/api/transactions';
const SENATE_API = 'https://api.senatestockwatcher.com/api/transactions';
const LOOKBACK_DAYS = 45; // How many days back to scan

// Amount range string → rough midpoint in USD for sorting/filtering
function parseAmount(amountStr = '') {
  if (!amountStr) return 0;
  const s = amountStr.toLowerCase().replace(/,/g, '').replace(/\$/g, '');
  const rangeMap = {
    '1001 - 15000':     8000,
    '15001 - 50000':    32000,
    '50001 - 100000':   75000,
    '100001 - 250000':  175000,
    '250001 - 500000':  375000,
    '500001 - 1000000': 750000,
    '1000001 - 5000000':3000000,
    'over $5,000,000':  5000000,
    '$1,000,001 +':     1000001,
  };
  for (const [key, val] of Object.entries(rangeMap)) {
    if (s.includes(key.replace(/,/g, '').replace(/\$/g, ''))) return val;
  }
  // Fallback: try to parse a number
  const num = parseFloat(s);
  return isNaN(num) ? 5000 : num;
}

function isoToDate(str) {
  if (!str) return null;
  try { return new Date(str); } catch { return null; }
}

function filterRecent(transactions, days = LOOKBACK_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return transactions.filter(t => {
    const d = isoToDate(t.transaction_date || t.transactionDate || t.date);
    return d && d >= cutoff;
  });
}

function normalizeHouse(raw) {
  return {
    chamber: 'House',
    member: raw.representative || raw.name || 'Unknown',
    ticker: (raw.ticker || '').toUpperCase().trim(),
    assetName: raw.asset_description || raw.description || '',
    type: (raw.type || raw.transaction_type || '').toLowerCase(), // 'purchase' | 'sale'
    amount: parseAmount(raw.amount),
    amountLabel: raw.amount || '',
    date: raw.transaction_date || raw.date || '',
    disclosureDate: raw.disclosure_date || '',
  };
}

function normalizeSenate(raw) {
  return {
    chamber: 'Senate',
    member: raw.senator || raw.first_name
      ? `${raw.first_name || ''} ${raw.last_name || ''}`.trim()
      : raw.name || 'Unknown',
    ticker: (raw.ticker || raw.asset_type || '').toUpperCase().trim(),
    assetName: raw.asset_name || raw.description || '',
    type: (raw.type || raw.transaction_type || '').toLowerCase(),
    amount: parseAmount(raw.amount),
    amountLabel: raw.amount || '',
    date: raw.transaction_date || raw.date || '',
    disclosureDate: raw.disclosure_date || '',
  };
}

/**
 * Aggregate normalized trades into per-ticker summaries.
 * Returns array sorted by total $ volume descending.
 */
function aggregateByTicker(trades) {
  const map = {};
  for (const t of trades) {
    if (!t.ticker || t.ticker.length < 1 || t.ticker.length > 5) continue;
    if (!map[t.ticker]) {
      map[t.ticker] = {
        ticker: t.ticker,
        assetName: t.assetName,
        purchases: [],
        sales: [],
        totalBuyVolume: 0,
        totalSellVolume: 0,
        members: new Set(),
      };
    }
    const entry = map[t.ticker];
    entry.members.add(t.member);
    entry.assetName = entry.assetName || t.assetName;
    if (t.type.includes('purchase') || t.type.includes('buy')) {
      entry.purchases.push(t);
      entry.totalBuyVolume += t.amount;
    } else if (t.type.includes('sale') || t.type.includes('sell')) {
      entry.sales.push(t);
      entry.totalSellVolume += t.amount;
    }
  }

  return Object.values(map)
    .map(e => ({
      ...e,
      members: [...e.members],
      netSentiment: e.totalBuyVolume - e.totalSellVolume,
      totalActivity: e.totalBuyVolume + e.totalSellVolume,
      buyCount: e.purchases.length,
      sellCount: e.sales.length,
    }))
    .sort((a, b) => b.totalActivity - a.totalActivity);
}

export async function briefing() {
  const results = await Promise.allSettled([
    safeFetch(HOUSE_API,  { timeout: 15000 }),
    safeFetch(SENATE_API, { timeout: 15000 }),
  ]);

  const allTrades = [];
  let houseOk = false, senateOk = false;

  // House — safeFetch never throws; returns { error } on failure or the parsed JSON on success
  const houseVal = results[0].status === 'fulfilled' ? results[0].value : null;
  if (Array.isArray(houseVal)) {
    const recent = filterRecent(houseVal);
    allTrades.push(...recent.map(normalizeHouse));
    houseOk = true;
  } else {
    console.warn('[Congress] House API failed or returned non-array:', houseVal?.error || 'unknown');
  }

  // Senate
  const senateVal = results[1].status === 'fulfilled' ? results[1].value : null;
  if (Array.isArray(senateVal)) {
    const recent = filterRecent(senateVal);
    allTrades.push(...recent.map(normalizeSenate));
    senateOk = true;
  } else {
    console.warn('[Congress] Senate API failed or returned non-array:', senateVal?.error || 'unknown');
  }

  if (allTrades.length === 0) {
    return {
      status: 'unavailable',
      message: 'No congressional trade data retrieved.',
      houseOk,
      senateOk,
      topBuys: [],
      topSells: [],
      heavyHitters: [],
      summary: 'Congressional data unavailable this cycle.',
    };
  }

  const byTicker = aggregateByTicker(allTrades);

  // Top buys: sorted by buy volume, net positive sentiment, min 2 members for conviction
  const topBuys = byTicker
    .filter(t => t.totalBuyVolume > 0 && t.netSentiment > 0)
    .sort((a, b) => b.totalBuyVolume - a.totalBuyVolume)
    .slice(0, 10)
    .map(t => ({
      ticker: t.ticker,
      assetName: t.assetName,
      members: t.members,
      memberCount: t.members.length,
      totalBuyVolume: t.totalBuyVolume,
      buyCount: t.buyCount,
      clustered: t.members.length >= 2, // Multiple members = highest conviction
    }));

  // Top sells: distribution signal
  const topSells = byTicker
    .filter(t => t.totalSellVolume > 0 && t.netSentiment < 0)
    .sort((a, b) => b.totalSellVolume - a.totalSellVolume)
    .slice(0, 5)
    .map(t => ({
      ticker: t.ticker,
      members: t.members,
      memberCount: t.members.length,
      totalSellVolume: t.totalSellVolume,
      sellCount: t.sellCount,
    }));

  // Heavy hitters: individual members with largest single trades
  const bigTrades = allTrades
    .filter(t => t.amount >= 100000 && (t.type.includes('purchase') || t.type.includes('buy')))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map(t => ({
      member: t.member,
      chamber: t.chamber,
      ticker: t.ticker,
      amountLabel: t.amountLabel,
      amount: t.amount,
      date: t.date,
    }));

  // Human-readable summary for LLM injection
  const buyLines = topBuys.slice(0, 5).map(t =>
    `  ${t.ticker}${t.clustered ? ' ⭐CLUSTERED' : ''}: ${t.memberCount} member(s) bought ~$${(t.totalBuyVolume/1000).toFixed(0)}k across ${t.buyCount} trade(s)`
  ).join('\n');

  const sellLines = topSells.slice(0, 3).map(t =>
    `  ${t.ticker}: ${t.memberCount} member(s) sold ~$${(t.totalSellVolume/1000).toFixed(0)}k`
  ).join('\n');

  const hitLines = bigTrades.slice(0, 5).map(t =>
    `  ${t.member} (${t.chamber}): BUY ${t.ticker} — ${t.amountLabel} on ${t.date}`
  ).join('\n');

  const summary = [
    `=== CONGRESSIONAL TRADING INTEL (Last ${LOOKBACK_DAYS} days) ===`,
    `Sources: ${houseOk ? 'House ✓' : 'House ✗'} | ${senateOk ? 'Senate ✓' : 'Senate ✗'} | ${allTrades.length} total disclosures`,
    ``,
    `📈 TOP CONGRESSIONAL BUYS (clustered = multiple members, highest conviction):`,
    buyLines || '  (none)',
    ``,
    `📉 TOP CONGRESSIONAL SELLS (distribution signal — caution):`,
    sellLines || '  (none)',
    ``,
    `💰 HEAVY HITTERS (individual trades >$100k):`,
    hitLines || '  (none)',
    ``,
    `NOTE: Congress members often front-run policy decisions, contracts, and regulatory changes.`,
    `Clustered buys across chambers = strongest signal. Use as confirmation, not sole trigger.`,
  ].join('\n');

  return {
    status: 'ok',
    houseOk,
    senateOk,
    totalDisclosures: allTrades.length,
    lookbackDays: LOOKBACK_DAYS,
    topBuys,
    topSells,
    heavyHitters: bigTrades,
    byTicker: byTicker.slice(0, 20),
    summary,
  };
}
