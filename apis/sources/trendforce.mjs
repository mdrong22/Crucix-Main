// TrendForce + SIA + SEMI — Semiconductor pricing & industry lead indicators
// No API key required. All sources are public RSS/feeds.
//
// WHY THIS MATTERS:
//   DRAM/NAND spot pricing leads semiconductor stock moves by 4-12 weeks.
//   When memory prices bottom and start recovering, inventory destocking has ended —
//   that's the real signal that the next earnings cycle will beat estimates.
//   Mainstream financial media covers this AFTER analysts upgrade. This data comes before.
//
// Sources:
//   TrendForce  — https://www.trendforce.com/feed/
//     Weekly DRAM/NAND contract + spot pricing, utilization rates, fab capacity
//   SIA          — https://www.semiconductors.org/feed/
//     Monthly worldwide semiconductor shipment data (3-month rolling avg)
//   SEMI         — https://www.semi.org/rss.xml
//     Equipment book-to-bill ratio (B2B > 1.0 = fabs expanding orders = bullish 2-3Q out)

import '../utils/env.mjs';

const RSS_TIMEOUT_MS = 10_000;

// Keywords that indicate a pricing direction signal
const PRICE_UP_TERMS    = ['rises', 'rebound', 'recovery', 'increase', 'surge', 'uptick', 'strengthens', 'higher', 'growth', 'rally', 'shortage', 'tight supply', 'increase', 'upturn'];
const PRICE_DOWN_TERMS  = ['declines', 'falls', 'drops', 'weakness', 'oversupply', 'glut', 'inventory', 'correction', 'softens', 'pressure', 'cuts', 'lower', 'excess'];
const MEMORY_TERMS      = ['dram', 'nand', 'nor', 'memory', 'hbm', 'ddr', 'lpddr', 'mlc', 'tlc', 'qlc', 'ssd', 'flash'];
const CHIP_TERMS        = ['semiconductor', 'chip', 'wafer', 'fab', 'foundry', 'tsmc', 'samsung', 'micron', 'sk hynix', 'intel', 'nvidia', 'amd', 'utilization', 'capacity', 'shipment', 'book-to-bill', 'b2b ratio'];
const SIGNAL_TERMS      = [...MEMORY_TERMS, ...CHIP_TERMS];

// Simple RSS XML parser — mirrors pattern in inject.mjs
async function fetchRSS(url) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RSS_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Crucix/2.0 semiconductor-intelligence' },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title   = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
      const link    = (block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim();
      const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '').trim();
      const desc    = (block.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '').trim().replace(/<[^>]+>/g, '').slice(0, 300);
      if (title) items.push({ title, link, pubDate, desc });
    }
    return items;
  } catch {
    return [];
  }
}

function scoreSemiItem(item) {
  const text = `${item.title} ${item.desc}`.toLowerCase();
  const isSemi = SIGNAL_TERMS.some(t => text.includes(t));
  if (!isSemi) return null;

  const isMemory  = MEMORY_TERMS.some(t => text.includes(t));
  const priceUp   = PRICE_UP_TERMS.some(t => text.includes(t));
  const priceDown = PRICE_DOWN_TERMS.some(t => text.includes(t));

  let direction = 'NEUTRAL';
  if (priceUp && !priceDown)   direction = 'UP';
  if (priceDown && !priceUp)   direction = 'DOWN';
  if (priceUp && priceDown)    direction = 'MIXED';

  // Detect B2B ratio mentions — key leading indicator
  const b2bMatch = text.match(/book[- ]to[- ]bill[:\s]*([0-9]+\.?[0-9]*)/i);
  const b2b = b2bMatch ? parseFloat(b2bMatch[1]) : null;

  // Detect utilization rate
  const utilMatch = text.match(/utilization[:\s]*([0-9]+\.?[0-9]*)%?/i);
  const utilization = utilMatch ? parseFloat(utilMatch[1]) : null;

  return {
    title:       item.title.slice(0, 120),
    date:        item.pubDate,
    link:        item.link || null,
    isMemory,
    direction,
    b2b,
    utilization,
    snippet:     item.desc.slice(0, 200) || null,
  };
}

export async function briefing() {
  const [tfItems, siaItems, semiItems] = await Promise.all([
    fetchRSS('https://www.trendforce.com/feed/'),
    fetchRSS('https://www.semiconductors.org/feed/'),
    fetchRSS('https://www.semi.org/rss.xml'),
  ]);

  // Score and filter all items
  const allItems = [
    ...tfItems.map(i => ({ ...i, _src: 'TrendForce' })),
    ...siaItems.map(i => ({ ...i, _src: 'SIA' })),
    ...semiItems.map(i => ({ ...i, _src: 'SEMI' })),
  ];

  const scored = allItems
    .map(i => {
      const s = scoreSemiItem(i);
      return s ? { ...s, source: i._src } : null;
    })
    .filter(Boolean);

  // Separate memory pricing from general semi news
  const memorySignals = scored.filter(s => s.isMemory).slice(0, 6);
  const chipSignals   = scored.filter(s => !s.isMemory).slice(0, 6);

  // Extract B2B readings across all items
  const b2bReadings = scored.filter(s => s.b2b !== null).map(s => ({ source: s.source, b2b: s.b2b, title: s.title }));
  const latestB2B   = b2bReadings[0]?.b2b ?? null;
  const b2bBullish  = latestB2B !== null ? latestB2B > 1.0 : null;

  // Determine aggregate memory price direction from recent signals
  const directionCounts = { UP: 0, DOWN: 0, NEUTRAL: 0, MIXED: 0 };
  for (const s of memorySignals) directionCounts[s.direction]++;
  const dominantDirection = Object.entries(directionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NEUTRAL';

  // Build compact signal strings for LLM context
  const signals = [
    latestB2B !== null
      ? `SEMI B2B Ratio: ${latestB2B} (${b2bBullish ? '📈 BULLISH — fabs expanding orders, 2-3Q lead signal' : '📉 BEARISH — fabs contracting orders'})`
      : null,
    memorySignals.length > 0
      ? `Memory price direction: ${dominantDirection} (${memorySignals.length} signals)`
      : null,
    ...memorySignals.slice(0, 3).map(s => `[${s.source}][${s.direction}] ${s.title}`),
    ...chipSignals.slice(0, 3).map(s => `[${s.source}] ${s.title}`),
  ].filter(Boolean);

  return {
    source:            'TrendForce/SIA/SEMI',
    timestamp:         new Date().toISOString(),
    b2bRatio:          latestB2B,
    b2bBullish,
    memoryDirection:   dominantDirection,
    memorySignals,
    chipSignals,
    signals:           signals.length > 0 ? signals : ['No semiconductor pricing signals in current feeds'],
    totalScanned:      allItems.length,
    totalRelevant:     scored.length,
  };
}

if (process.argv[1]?.endsWith('trendforce.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
