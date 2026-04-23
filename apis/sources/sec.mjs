// SEC EDGAR — Insider transactions (Form 4) and material events (8-K)
// No API key required. Set SEC_USER_AGENT in .env (SEC policy requires email contact).
// Default user-agent used if unset — may be rate-limited under heavy load.
//
// What this catches:
//   Form 4  — executive/director buy transactions: smart money ahead of announcements
//   8-K     — material events: contract awards, FDA approvals, guidance changes, M&A
//
// EDGAR REST API: https://data.sec.gov/submissions/CIK{padded_cik}.json
// No auth required, but SEC asks for a descriptive User-Agent with contact info.
// Set SEC_USER_AGENT="YourAppName contact@yourdomain.com" in .env

import { safeFetch, daysAgo } from '../utils/fetch.mjs';
import '../utils/env.mjs';

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';

// Watchlist: { ticker, cik } for companies most likely to produce market-moving filings.
// CIKs are stable — never change. Add more as needed.
const WATCHLIST = [
  // Semiconductors / AI infrastructure
  { ticker: 'NVDA',  cik: '1045810' },
  { ticker: 'AMD',   cik: '2488'    },
  { ticker: 'INTC',  cik: '50863'   },
  { ticker: 'QCOM',  cik: '804328'  },
  { ticker: 'AMAT',  cik: '796343'  },
  { ticker: 'KLAC',  cik: '319201'  },
  { ticker: 'LRCX',  cik: '707549'  },
  { ticker: 'MU',    cik: '723254'  },
  // Big Tech
  { ticker: 'MSFT',  cik: '789019'  },
  { ticker: 'GOOGL', cik: '1652044' },
  { ticker: 'META',  cik: '1326801' },
  { ticker: 'AAPL',  cik: '320193'  },
  { ticker: 'AMZN',  cik: '1018724' },
  // Defense
  { ticker: 'LMT',   cik: '936468'  },
  { ticker: 'RTX',   cik: '101830'  },
  { ticker: 'NOC',   cik: '1133421' },
  { ticker: 'GD',    cik: '40533'   },
  { ticker: 'BA',    cik: '12927'   },
  { ticker: 'CACI',  cik: '16058'   },
  // Biotech / Pharma
  { ticker: 'MRNA',  cik: '1682852' },
  { ticker: 'GILD',  cik: '882095'  },
  { ticker: 'AMGN',  cik: '318154'  },
  { ticker: 'REGN',  cik: '872589'  },
  { ticker: 'VRTX',  cik: '875320'  },
  // Energy
  { ticker: 'XOM',   cik: '34088'   },
  { ticker: 'CVX',   cik: '93410'   },
  { ticker: 'KMI',   cik: '1110805' },
  { ticker: 'WMB',   cik: '107263'  },
];

const LOOKBACK_DAYS = 3;

function padCik(cik) {
  return cik.toString().padStart(10, '0');
}

function userAgent() {
  return process.env.SEC_USER_AGENT || 'Crucix Intelligence Engine contact@crucix.io';
}

// Pull recent filings for a single company, return filtered 8-Ks and Form 4s
async function getRecentFilings(ticker, cik) {
  const url     = `${SUBMISSIONS_BASE}/CIK${padCik(cik)}.json`;
  const headers = { 'User-Agent': userAgent(), 'Accept': 'application/json' };
  const data    = await safeFetch(url, { timeout: 10000, headers });

  if (data?.error || !data?.filings?.recent) return null;

  const { form, filingDate, accessionNumber, primaryDocument } = data.filings.recent;
  if (!Array.isArray(form)) return null;

  const cutoff  = daysAgo(LOOKBACK_DAYS);
  const results = { eightK: [], form4: [] };

  for (let i = 0; i < form.length; i++) {
    const date = filingDate[i];
    if (!date || date < cutoff) break; // filings are newest-first; stop early

    const ftype = form[i];
    const acc   = (accessionNumber[i] || '').replace(/-/g, '');
    const doc   = primaryDocument[i] || '';
    const url_  = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc}/${doc}`;

    if (ftype === '8-K') {
      results.eightK.push({ ticker, date, url: url_, accession: accessionNumber[i] });
    } else if (ftype === '4') {
      // Form 4 = insider transaction — surfaced as a signal regardless of buy/sell
      // (parsing the XML to determine direction would require another HTTP call)
      results.form4.push({ ticker, date, url: url_, accession: accessionNumber[i] });
    }
  }

  return results;
}

export async function briefing() {
  const since    = daysAgo(LOOKBACK_DAYS);
  const eightKs  = [];
  const form4s   = [];
  const signals  = [];
  const errors   = [];

  // Fetch all companies in parallel — EDGAR is reliable and allows concurrent reads
  const results = await Promise.all(
    WATCHLIST.map(({ ticker, cik }) => getRecentFilings(ticker, cik))
  );

  for (let i = 0; i < WATCHLIST.length; i++) {
    const r = results[i];
    if (!r) { errors.push(WATCHLIST[i].ticker); continue; }
    eightKs.push(...r.eightK);
    form4s.push(...r.form4);
  }

  // Signal generation
  for (const f of eightKs) {
    signals.push(`8-K MATERIAL EVENT: ${f.ticker} filed on ${f.date} — ${f.url}`);
  }

  // Group Form 4s by ticker — multiple filings in a day is a stronger signal
  const form4ByTicker = {};
  for (const f of form4s) {
    (form4ByTicker[f.ticker] = form4ByTicker[f.ticker] || []).push(f);
  }
  for (const [ticker, filings] of Object.entries(form4ByTicker)) {
    const count = filings.length;
    signals.push(`INSIDER ACTIVITY: ${ticker} — ${count} Form 4 filing${count > 1 ? 's' : ''} in last ${LOOKBACK_DAYS}d (buy or sell — verify filing)`);
  }

  return {
    source:        'SEC EDGAR',
    timestamp:     new Date().toISOString(),
    window:        `${since} to today`,
    watchlist_size: WATCHLIST.length,
    eight_k_count: eightKs.length,
    form4_count:   form4s.length,
    eight_k_filings: eightKs,
    form4_filings: form4s,
    signals:       signals.length > 0 ? signals : [`No 8-K or Form 4 activity for watchlist in last ${LOOKBACK_DAYS} days`],
    errors:        errors.length > 0  ? errors  : [],
  };
}

if (process.argv[1]?.endsWith('sec.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
