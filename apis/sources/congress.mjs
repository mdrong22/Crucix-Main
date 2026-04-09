// congress.mjs — Congressional Trading Intelligence
// Pulls recent stock disclosures from House & Senate members.
// No API key required. Uses public disclosure APIs:
//   House:  https://housestockwatcher.com/api/transactions
//   Senate: https://senatestockwatcher.com/api/transactions
//
// RESPONSE STRUCTURE (both APIs):
//   Top-level: array of FILER objects (one per member per filing day)
//   Each filer: { representative|first_name+last_name, transactions: [ ...flat trade objects ] }
//   Senate transactions may have ticker === "--" for unidentified assets — these are skipped.
//
// STRATEGY SIGNAL: Congress members are often ahead of major policy/contract news.
// Clustering (multiple members buying the same ticker) is highest-conviction signal.

import { safeFetch } from '../utils/fetch.mjs';

// Primary URLs (no api. subdomain — that's the correct base)
const HOUSE_API  = 'https://housestockwatcher.com/api/transactions';
const SENATE_API = 'https://senatestockwatcher.com/api/transactions';
const LOOKBACK_DAYS = 45;

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseAmount(amountStr = '') {
  if (!amountStr) return 0;
  const s = amountStr.toLowerCase().replace(/,/g, '').replace(/\$/g, '').trim();
  // Named ranges used in STOCK Act disclosures
  const rangeMap = [
    ['over 5000000',    5_000_000],
    ['1000001',        3_000_000],  // $1M–$5M, use midpoint
    ['500001',           750_000],
    ['250001',           375_000],
    ['100001',           175_000],
    ['50001',             75_000],
    ['15001',             32_000],
    ['1001',               8_000],
  ];
  for (const [key, val] of rangeMap) {
    if (s.includes(key)) return val;
  }
  const num = parseFloat(s);
  return isNaN(num) ? 5_000 : num;
}

function isoToDate(str) {
  if (!str) return null;
  try { return new Date(str); } catch { return null; }
}

function isValidTicker(t) {
  if (!t) return false;
  const clean = t.trim().toUpperCase();
  if (clean === '--' || clean === 'N/A' || clean === '') return false;
  return /^[A-Z]{1,5}$/.test(clean);
}

function filterRecent(trades, days = LOOKBACK_DAYS) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return trades.filter(t => {
    const d = isoToDate(t.transaction_date || t.transactionDate || t.date);
    return d && d >= cutoff;
  });
}

// ─── Flatteners ─────────────────────────────────────────────────────────────
// Both APIs return: [ { member_fields..., transactions: [ ...trades ] } ]
// We flatten into a single array of enriched trade objects.

function flattenHouse(raw) {
  if (!Array.isArray(raw)) return [];
  const flat = [];
  for (const filer of raw) {
    // Handle both nested { transactions: [...] } and already-flat objects
    const trades = Array.isArray(filer.transactions) ? filer.transactions : [filer];
    const member = filer.representative || filer.name ||
      `${filer.first_name || ''} ${filer.last_name || ''}`.trim() || 'Unknown';
    for (const t of trades) {
      if (!isValidTicker(t.ticker)) continue;
      flat.push({
        chamber:        'House',
        member,
        ticker:         t.ticker.trim().toUpperCase(),
        assetName:      t.asset_description || t.description || '',
        type:           (t.type || t.transaction_type || '').toLowerCase(),
        amount:         parseAmount(t.amount),
        amountLabel:    t.amount || '',
        date:           t.transaction_date || t.date || '',
        disclosureDate: t.disclosure_date || filer.disclosure_date || '',
      });
    }
  }
  return flat;
}

function flattenSenate(raw) {
  if (!Array.isArray(raw)) return [];
  const flat = [];
  for (const filer of raw) {
    const trades = Array.isArray(filer.transactions) ? filer.transactions : [filer];
    const member = `${filer.first_name || ''} ${filer.last_name || ''}`.trim()
      || filer.senator || filer.name || filer.office || 'Unknown';
    for (const t of trades) {
      if (!isValidTicker(t.ticker)) continue;
      flat.push({
        chamber:        'Senate',
        member,
        ticker:         t.ticker.trim().toUpperCase(),
        assetName:      t.asset_description || t.asset_name || t.description || '',
        type:           (t.type || t.transaction_type || '').toLowerCase(),
        amount:         parseAmount(t.amount),
        amountLabel:    t.amount || '',
        date:           t.transaction_date || t.date || '',
        disclosureDate: t.disclosure_date || filer.date_recieved || filer.date_received || '',
      });
    }
  }
  return flat;
}

// ─── Response unwrapper ──────────────────────────────────────────────────────
// Handles: raw array, { data: [] }, { transactions: [] }, { rawText: '...' }

function unwrap(val) {
  if (!val || val.error) return null;
  if (Array.isArray(val)) return val;
  if (Array.isArray(val.data)) return val.data;
  if (Array.isArray(val.transactions)) return val.transactions;
  // safeFetch returns { rawText } when JSON.parse fails — log and skip
  if (val.rawText) {
    console.warn('[Congress] Non-JSON response received (HTML/text):', val.rawText.slice(0, 120));
    return null;
  }
  return null;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

function aggregateByTicker(trades) {
  const map = {};
  for (const t of trades) {
    if (!isValidTicker(t.ticker)) continue;
    const key = t.ticker;
    if (!map[key]) {
      map[key] = {
        ticker: key,
        assetName: t.assetName,
        purchases: [],
        sales: [],
        totalBuyVolume: 0,
        totalSellVolume: 0,
        members: new Set(),
      };
    }
    const entry = map[key];
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
      members:       [...e.members],
      netSentiment:  e.totalBuyVolume - e.totalSellVolume,
      totalActivity: e.totalBuyVolume + e.totalSellVolume,
      buyCount:      e.purchases.length,
      sellCount:     e.sales.length,
    }))
    .sort((a, b) => b.totalActivity - a.totalActivity);
}

// ─── Main ────────────────────────────────────────────────────────────────────

export async function briefing() {
  const [houseRes, senateRes] = await Promise.allSettled([
    safeFetch(HOUSE_API,  { timeout: 20000 }),
    safeFetch(SENATE_API, { timeout: 20000 }),
  ]);

  const allTrades = [];
  let houseOk = false, senateOk = false;

  // House
  const houseRaw = unwrap(houseRes.status === 'fulfilled' ? houseRes.value : null);
  if (houseRaw) {
    const flat   = flattenHouse(houseRaw);
    const recent = filterRecent(flat);
    allTrades.push(...recent);
    houseOk = recent.length > 0;
    console.log(`[Congress] House: ${houseRaw.length} filers → ${flat.length} trades → ${recent.length} in last ${LOOKBACK_DAYS}d`);
  } else {
    const err = houseRes.status === 'fulfilled' ? houseRes.value?.error : houseRes.reason?.message;
    console.warn('[Congress] House API failed:', err || 'unknown');
  }

  // Senate
  const senateRaw = unwrap(senateRes.status === 'fulfilled' ? senateRes.value : null);
  if (senateRaw) {
    const flat   = flattenSenate(senateRaw);
    const recent = filterRecent(flat);
    allTrades.push(...recent);
    senateOk = recent.length > 0;
    console.log(`[Congress] Senate: ${senateRaw.length} filers → ${flat.length} trades → ${recent.length} in last ${LOOKBACK_DAYS}d`);
  } else {
    const err = senateRes.status === 'fulfilled' ? senateRes.value?.error : senateRes.reason?.message;
    console.warn('[Congress] Senate API failed:', err || 'unknown');
  }

  if (allTrades.length === 0) {
    return {
      status:  'unavailable',
      message: 'No congressional trade data retrieved.',
      houseOk, senateOk,
      topBuys: [], topSells: [], heavyHitters: [],
      summary: 'Congressional data unavailable this cycle.',
    };
  }

  const byTicker = aggregateByTicker(allTrades);

  const topBuys = byTicker
    .filter(t => t.totalBuyVolume > 0 && t.netSentiment > 0)
    .sort((a, b) => b.totalBuyVolume - a.totalBuyVolume)
    .slice(0, 10)
    .map(t => ({
      ticker:         t.ticker,
      assetName:      t.assetName,
      members:        t.members,
      memberCount:    t.members.length,
      totalBuyVolume: t.totalBuyVolume,
      buyCount:       t.buyCount,
      clustered:      t.members.length >= 2,
    }));

  const topSells = byTicker
    .filter(t => t.totalSellVolume > 0 && t.netSentiment < 0)
    .sort((a, b) => b.totalSellVolume - a.totalSellVolume)
    .slice(0, 5)
    .map(t => ({
      ticker:          t.ticker,
      members:         t.members,
      memberCount:     t.members.length,
      totalSellVolume: t.totalSellVolume,
      sellCount:       t.sellCount,
    }));

  const heavyHitters = allTrades
    .filter(t => t.amount >= 100_000 && (t.type.includes('purchase') || t.type.includes('buy')))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 8)
    .map(t => ({
      member: t.member, chamber: t.chamber,
      ticker: t.ticker, amountLabel: t.amountLabel,
      amount: t.amount, date: t.date,
    }));

  const buyLines = topBuys.slice(0, 5).map(t =>
    `  ${t.ticker}${t.clustered ? ' ⭐CLUSTERED' : ''}: ${t.memberCount} member(s) ~$${(t.totalBuyVolume / 1000).toFixed(0)}k across ${t.buyCount} trade(s)`
  ).join('\n');

  const sellLines = topSells.slice(0, 3).map(t =>
    `  ${t.ticker}: ${t.memberCount} member(s) sold ~$${(t.totalSellVolume / 1000).toFixed(0)}k`
  ).join('\n');

  const hitLines = heavyHitters.slice(0, 5).map(t =>
    `  ${t.member} (${t.chamber}): BUY ${t.ticker} — ${t.amountLabel} on ${t.date}`
  ).join('\n');

  const summary = [
    `=== CONGRESSIONAL TRADING INTEL (Last ${LOOKBACK_DAYS} days) ===`,
    `Sources: ${houseOk ? 'House ✓' : 'House ✗'} | ${senateOk ? 'Senate ✓' : 'Senate ✗'} | ${allTrades.length} total valid disclosures`,
    ``,
    `📈 TOP CONGRESSIONAL BUYS (⭐CLUSTERED = multiple members, highest conviction):`,
    buyLines  || '  (none)',
    ``,
    `📉 TOP CONGRESSIONAL SELLS (distribution signal — caution on these tickers):`,
    sellLines || '  (none)',
    ``,
    `💰 HEAVY HITTERS (individual trades >$100k):`,
    hitLines  || '  (none)',
    ``,
    `NOTE: Congress often positions ahead of policy shifts, contracts & regulatory approvals.`,
    `Clustered buys across chambers = strongest forward-looking signal.`,
  ].join('\n');

  return {
    status: 'ok',
    houseOk, senateOk,
    totalDisclosures: allTrades.length,
    lookbackDays:     LOOKBACK_DAYS,
    topBuys, topSells, heavyHitters,
    byTicker: byTicker.slice(0, 20),
    summary,
  };
}
