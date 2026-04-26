// CHIPS Act + BIS Export Controls — US Semiconductor Policy Intelligence
// No API key required. Uses Federal Register API (public) + USAspending CHIPS grants.
//
// WHY THIS MATTERS:
//   CHIPS Act grant awards signal long-term fab investment that leads revenue by years.
//   BIS export control actions (new China restrictions, entity list additions) are
//   immediate catalysts — these announcements move semiconductor stocks the same day.
//   Both are government data that hits the Federal Register before major media covers it.
//
// Sources:
//   Federal Register API — https://www.federalregister.gov/api/v1/articles.json
//     Covers: BIS export control rules, CHIPS Office awards, Commerce Dept semiconductor policy
//   USAspending Grants API — https://api.usaspending.gov/api/v2/search/spending_by_award/
//     Covers: CHIPS Act direct grant awards to Intel, TSMC, Micron, Samsung, etc.
//
// No env vars required.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const FED_REG_BASE    = 'https://www.federalregister.gov/api/v1/articles.json';
const USASPENDING_BASE = 'https://api.usaspending.gov/api/v2';

// ── Federal Register: BIS export controls & CHIPS policy ────────────────────
async function fetchFedRegArticles(params) {
  const query = new URLSearchParams({
    per_page: '10',
    order:    'newest',
    fields:   ['title', 'abstract', 'publication_date', 'html_url', 'agencies', 'type'].join(','),
    ...params,
  });
  return safeFetch(`${FED_REG_BASE}?${query}`, { timeout: 12000 });
}

async function getBISExportControls() {
  // BIS = Bureau of Industry and Security — issues export control regulations
  return fetchFedRegArticles({
    'conditions[agencies][]':   'bureau-of-industry-and-security',
    'conditions[term]':         'semiconductor export control entity list',
    'conditions[publication_date][gte]': daysAgo(30),
  });
}

async function getCHIPSPolicyNews() {
  // Commerce Department CHIPS office announcements + broader chip policy
  return fetchFedRegArticles({
    'conditions[term]':         'CHIPS Act semiconductor manufacturing',
    'conditions[publication_date][gte]': daysAgo(45),
  });
}

// ── USAspending: CHIPS Act direct grants ─────────────────────────────────────
// CHIPS Act awards are a specific category — keyword "CHIPS" in the program title
// and agency = Commerce Department
async function getCHIPSGrants() {
  const body = {
    filters: {
      keywords:        ['CHIPS Act', 'semiconductor manufacturing', 'CHIPS for America'],
      time_period:     [{ start_date: daysAgo(90), end_date: daysAgo(0) }],
      award_type_codes: ['02', '03', '04', '05'], // Grant codes
    },
    fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Description', 'Awarding Agency', 'Start Date'],
    limit:  10,
    sort:   'Award Amount',
    order:  'desc',
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(`${USASPENDING_BASE}/search/spending_by_award/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { results: [], error: `HTTP ${res.status}` };
    return res.json();
  } catch (e) {
    return { results: [], error: e.message };
  }
}

// Score an article for market-moving potential
const HIGH_IMPACT_TERMS = [
  'entity list', 'export control', 'restriction', 'ban', 'license requirement',
  'chips act', 'grant award', 'direct funding', 'subsidy', 'intel', 'tsmc', 'micron',
  'samsung', 'qualcomm', 'advanced packaging', 'fab', 'foundry', 'wafer',
];

function scoreArticle(title = '', abstract = '') {
  const text = `${title} ${abstract}`.toLowerCase();
  const hits = HIGH_IMPACT_TERMS.filter(t => text.includes(t));
  const isBIS    = text.includes('export') || text.includes('entity list') || text.includes('restriction');
  const isCHIPS  = text.includes('chips act') || text.includes('grant') || text.includes('subsidy');
  return { score: hits.length, isBIS, isCHIPS };
}

export async function briefing() {
  const [bisData, chipsPolicy, chipsGrants] = await Promise.all([
    getBISExportControls(),
    getCHIPSPolicyNews(),
    getCHIPSGrants(),
  ]);

  // Process Federal Register articles
  const bisArticles = (bisData?.results || []).map(a => {
    const { score, isBIS } = scoreArticle(a.title, a.abstract);
    return {
      title:       (a.title || '').slice(0, 120),
      abstract:    (a.abstract || '').slice(0, 250),
      date:        a.publication_date,
      url:         a.html_url,
      type:        'BIS_EXPORT_CONTROL',
      score,
    };
  }).filter(a => a.score > 0).slice(0, 5);

  const chipsPolicyArticles = (chipsPolicy?.results || []).map(a => {
    const { score } = scoreArticle(a.title, a.abstract);
    return {
      title:       (a.title || '').slice(0, 120),
      abstract:    (a.abstract || '').slice(0, 250),
      date:        a.publication_date,
      url:         a.html_url,
      type:        'CHIPS_POLICY',
      score,
    };
  }).filter(a => a.score > 0).slice(0, 5);

  // Process USAspending grant awards
  const grantAwards = (chipsGrants?.results || []).map(r => ({
    recipient:   r['Recipient Name'] || 'Unknown',
    amount:      r['Award Amount']    || 0,
    description: (r['Description']   || '').slice(0, 150),
    agency:      r['Awarding Agency'] || '',
    date:        r['Start Date']      || '',
    amountM:     Math.round((r['Award Amount'] || 0) / 1e6),
  })).slice(0, 8);

  // Total CHIPS grant funding in window
  const totalGrantsM = grantAwards.reduce((sum, g) => sum + g.amountM, 0);

  // Signal strings for LLM
  const signals = [];
  if (bisArticles.length > 0) {
    signals.push(`BIS EXPORT CONTROLS (${bisArticles.length} recent actions):`);
    bisArticles.slice(0, 2).forEach(a => signals.push(`  • ${a.date}: ${a.title}`));
  }
  if (grantAwards.length > 0) {
    signals.push(`CHIPS ACT GRANTS: $${totalGrantsM}M awarded to ${grantAwards.length} recipients (90d window)`);
    grantAwards.slice(0, 3).forEach(g => signals.push(`  • $${g.amountM}M → ${g.recipient} (${g.date})`));
  }
  if (chipsPolicyArticles.length > 0) {
    signals.push(`CHIPS POLICY (${chipsPolicyArticles.length} recent FR articles):`);
    chipsPolicyArticles.slice(0, 2).forEach(a => signals.push(`  • ${a.date}: ${a.title}`));
  }

  return {
    source:              'CHIPS Act / BIS Export Controls',
    timestamp:           new Date().toISOString(),
    bisExportControls:   bisArticles,
    chipsPolicyArticles,
    chipsGrantAwards:    grantAwards,
    totalGrantsM,
    signals:             signals.length > 0 ? signals : ['No new CHIPS Act or export control actions in current window'],
  };
}

if (process.argv[1]?.endsWith('chipsact.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
