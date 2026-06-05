// Presidential & Executive Action Intelligence — broad US policy feed
// No API key required. Uses the Federal Register API (public).
//
// WHY THIS MATTERS:
//   Executive Orders and significant federal rules hit the Federal Register before major
//   media frames them, and they move whole sectors (tariffs → industrials/retail, energy
//   permits → oil/gas/uranium, defense directives → primes, drug pricing → pharma).
//   This is the TOP of Scout's macro→sector→stock funnel: "what did the president / agencies
//   just do?" — the leading catalyst that precedes the sector and stock decision.
//
// Scope (deliberately broad, unlike chipsact.mjs which is semiconductor-only):
//   - Presidential documents → executive orders (newest first)
//   - Significant agency rules/notices tagged with market-moving terms across all agencies
//
// Source:
//   Federal Register API — https://www.federalregister.gov/api/v1/documents.json
//
// No env vars required.

import { safeFetch, daysAgo } from '../utils/fetch.mjs';

const FED_REG_DOCS = 'https://www.federalregister.gov/api/v1/documents.json';

// Sector-mapping hints so the LLM can jump catalyst → sector quickly.
// Each term maps a policy theme to the sector it most directly moves.
const SECTOR_TERMS = [
  { term: 'tariff',            sector: 'Industrials/Trade' },
  { term: 'import duty',       sector: 'Industrials/Trade' },
  { term: 'export control',    sector: 'Semiconductors/Defense' },
  { term: 'sanction',          sector: 'Energy/Defense/Financials' },
  { term: 'drilling',          sector: 'Oil & Gas' },
  { term: 'pipeline',          sector: 'Energy Midstream' },
  { term: 'lng',               sector: 'Energy/NatGas' },
  { term: 'nuclear',           sector: 'Uranium/Utilities' },
  { term: 'uranium',           sector: 'Uranium' },
  { term: 'emission',          sector: 'Energy/Autos' },
  { term: 'electric vehicle',  sector: 'Autos/EV' },
  { term: 'drug pric',         sector: 'Pharma/Healthcare' },
  { term: 'medicare',          sector: 'Healthcare' },
  { term: 'defense',           sector: 'Defense' },
  { term: 'shipbuild',         sector: 'Defense/Marine' },
  { term: 'critical mineral',  sector: 'Mining/Materials' },
  { term: 'rare earth',        sector: 'Mining/Materials' },
  { term: 'steel',             sector: 'Materials/Steel' },
  { term: 'immigration',       sector: 'Labor/Agriculture/Construction' },
  { term: 'crypto',            sector: 'Crypto/Financials' },
  { term: 'digital asset',     sector: 'Crypto/Financials' },
  { term: 'artificial intelligence', sector: 'Tech/Semiconductors' },
  { term: 'data center',       sector: 'Tech/Utilities/Power' },
  { term: 'grid',              sector: 'Utilities/Power' },
];

// High-impact terms used to score significant rules for market relevance.
const HIGH_IMPACT_TERMS = [
  'tariff', 'sanction', 'export control', 'entity list', 'ban', 'restriction',
  'drilling', 'pipeline', 'lng', 'nuclear', 'uranium', 'emission', 'electric vehicle',
  'drug pric', 'medicare', 'defense', 'shipbuild', 'critical mineral', 'rare earth',
  'steel', 'crypto', 'digital asset', 'artificial intelligence', 'data center', 'grid',
  'license requirement', 'national security',
];

function mapSectors(text = '') {
  const lower = text.toLowerCase();
  const hits = SECTOR_TERMS.filter(s => lower.includes(s.term)).map(s => s.sector);
  return [...new Set(hits)];
}

function scoreImpact(text = '') {
  const lower = text.toLowerCase();
  return HIGH_IMPACT_TERMS.filter(t => lower.includes(t)).length;
}

// Federal Register's /documents.json requires `fields[]=x` array params (NOT comma-joined).
function buildFedRegQuery(base, fields) {
  const query = new URLSearchParams(base);
  for (const f of fields) query.append('fields[]', f);
  return query;
}

// ── Executive Orders — presidential documents, newest first ──────────────────
async function getExecutiveOrders() {
  const query = buildFedRegQuery({
    per_page: '12',
    order:    'newest',
    'conditions[type][]': 'PRESDOCU',
    'conditions[presidential_document_type][]': 'executive_order',
    'conditions[publication_date][gte]': daysAgo(45),
  }, ['title', 'abstract', 'publication_date', 'html_url', 'signing_date']);
  return safeFetch(`${FED_REG_DOCS}?${query}`, { timeout: 12000 });
}

// ── Significant agency rules/notices with market-moving terms (all agencies) ──
async function getSignificantRules() {
  const query = buildFedRegQuery({
    per_page: '20',
    order:    'newest',
    'conditions[type][]': 'RULE',
    'conditions[significant]': '1',
    'conditions[publication_date][gte]': daysAgo(14),
  }, ['title', 'abstract', 'publication_date', 'html_url', 'agencies', 'type']);
  return safeFetch(`${FED_REG_DOCS}?${query}`, { timeout: 12000 });
}

export async function briefing() {
  const [eoData, ruleData] = await Promise.all([
    getExecutiveOrders(),
    getSignificantRules(),
  ]);

  const executiveOrders = (eoData?.results || []).map(a => {
    const blob = `${a.title || ''} ${a.abstract || ''}`;
    return {
      title:    (a.title || '').slice(0, 140),
      abstract: (a.abstract || '').slice(0, 240),
      date:     a.signing_date || a.publication_date,
      url:      a.html_url,
      sectors:  mapSectors(blob),
      score:    scoreImpact(blob),
    };
  }).slice(0, 8);

  const rules = (ruleData?.results || []).map(a => {
    const blob = `${a.title || ''} ${a.abstract || ''}`;
    const agency = a.agencies?.[0]?.name || a.agencies?.[0]?.raw_name || '';
    return {
      title:    (a.title || '').slice(0, 140),
      abstract: (a.abstract || '').slice(0, 200),
      date:     a.publication_date,
      url:      a.html_url,
      agency:   agency.slice(0, 60),
      sectors:  mapSectors(blob),
      score:    scoreImpact(blob),
    };
  }).filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  // Compact signal strings for the LLM — catalyst + the sector it points at.
  const signals = [];
  for (const eo of executiveOrders.slice(0, 4)) {
    const sec = eo.sectors.length ? ` → ${eo.sectors.join(', ')}` : '';
    signals.push(`EO ${eo.date}: ${eo.title}${sec}`);
  }
  for (const r of rules.slice(0, 3)) {
    const sec = r.sectors.length ? ` → ${r.sectors.join(', ')}` : '';
    signals.push(`RULE ${r.date} (${r.agency}): ${r.title}${sec}`);
  }

  return {
    source:          'Presidential & Executive Actions',
    timestamp:       new Date().toISOString(),
    executiveOrders,
    rules,
    signals:         signals.length > 0 ? signals : ['No new executive orders or significant rules in current window'],
  };
}

if (process.argv[1]?.endsWith('policy.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
