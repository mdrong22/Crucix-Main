// Hacker News — Tech community intelligence (no API key required)
// HN is often the first place AI model leaks, semiconductor news, and tech
// product launches surface — hours ahead of mainstream financial media.
// API: https://hacker-news.firebaseio.com/v0/

import { safeFetch } from '../utils/fetch.mjs';

const BASE = 'https://hacker-news.firebaseio.com/v0';
const FETCH_TOP_N = 60; // scan top 60 stories

// Keywords that suggest financial/market relevance
// Grouped so we can score higher when multiple categories hit
const SIGNAL_GROUPS = {
  ai_model:      ['llm', 'gpt', 'gemini', 'claude', 'llama', 'model release', 'benchmark', 'training run', 'foundation model', 'inference', 'weights'],
  semiconductor: ['nvidia', 'nvda', 'amd', 'intel', 'tsmc', 'arm', 'gpu', 'chip', 'semiconductor', 'wafer', 'fab', 'h100', 'b200', 'blackwell'],
  catalyst:      ['ipo', 'acquisition', 'merger', 'earnings', 'revenue', 'guidance', 'valuation', 'funding round', 'series', 'unicorn'],
  policy:        ['regulation', 'antitrust', 'ban', 'sanction', 'export control', 'tariff', 'congress', 'fda', 'sec', 'doj'],
  company:       ['openai', 'anthropic', 'google deepmind', 'microsoft', 'meta ai', 'apple', 'amazon', 'spacex', 'tesla'],
};

function scoreStory(story) {
  if (!story?.title) return { total: 0, groups: [] };
  const title = story.title.toLowerCase();
  const text  = `${title} ${(story.text || '').toLowerCase().slice(0, 300)}`;
  let total = 0;
  const groups = [];
  for (const [group, kws] of Object.entries(SIGNAL_GROUPS)) {
    const hit = kws.some(kw => text.includes(kw));
    if (hit) { total++; groups.push(group); }
  }
  return { total, groups };
}

export async function briefing() {
  const topIds = await safeFetch(`${BASE}/topstories.json`, { timeout: 10000 });
  const newIds = await safeFetch(`${BASE}/newstories.json`,  { timeout: 10000 });

  if (!Array.isArray(topIds)) {
    return { source: 'HackerNews', timestamp: new Date().toISOString(), status: 'error', message: 'Failed to fetch story IDs' };
  }

  // Merge top + new, deduplicate, take first FETCH_TOP_N
  const combined = [...new Set([...topIds.slice(0, FETCH_TOP_N / 2), ...(Array.isArray(newIds) ? newIds.slice(0, FETCH_TOP_N / 2) : [])])].slice(0, FETCH_TOP_N);

  const stories = await Promise.all(
    combined.map(id => safeFetch(`${BASE}/item/${id}.json`, { timeout: 5000 }))
  );

  const relevant = stories
    .filter(s => s && !s.error && s.title)
    .map(s => {
      const { total, groups } = scoreStory(s);
      return {
        title:     s.title,
        url:       s.url || `https://news.ycombinator.com/item?id=${s.id}`,
        hn_score:  s.score  ?? 0,
        comments:  s.descendants ?? 0,
        age_h:     Math.round((Date.now() / 1000 - (s.time || 0)) / 3600),
        relevance: total,
        groups,
      };
    })
    .filter(s => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || b.hn_score - a.hn_score);

  const signals = relevant.slice(0, 8).map(s =>
    `HN[score=${s.hn_score},${s.comments}c,${s.age_h}h ago][${s.groups.join('+')}] ${s.title}`
  );

  return {
    source:           'HackerNews',
    timestamp:        new Date().toISOString(),
    scanned:          combined.length,
    relevant_count:   relevant.length,
    top_stories:      relevant.slice(0, 10),
    signals:          signals.length > 0 ? signals : ['No financially relevant HN stories in top scan'],
  };
}

if (process.argv[1]?.endsWith('hackernews.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
