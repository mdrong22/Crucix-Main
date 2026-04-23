#!/usr/bin/env node
// Crucix Intelligence Engine — Dev Server
// Serves the Jarvis dashboard, runs sweep cycle, pushes live updates via SSE

import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from './crucix.config.mjs';
import { getLocale, currentLanguage, getSupportedLocales } from './lib/i18n.mjs';
import { fullBriefing } from './apis/briefing.mjs';
import { synthesize } from './dashboard/inject.mjs';
import { MemoryManager } from './lib/delta/index.mjs';
import { createLLMProvider, GeminiProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas, runPortfolioBrief } from './lib/llm/ideas.mjs';
import { OpenAIProvider } from './lib/llm/openai.mjs';
import { formatToTelegramMarkdown, TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { SnapTrade } from './lib/alerts/snaptrade.mjs';
import { ScoutLLM } from './lib/llm/council/scout.mjs';
import { ScribePrompt } from './lib/llm/council/utils/prompts.mjs';
import { generateLocalReport } from './lib/llm/council/utils/generateReport.mjs';
import { Debate } from './lib/alerts/debate.mjs';
import { PhiLLM } from './lib/llm/council/phi.mjs';
import { ThetaLLM } from './lib/llm/council/theta.mjs';
import { GregorLLM } from './lib/llm/council/omega.mjs';
import { calculateRemainingDayTrades, isDayTrade } from './lib/llm/council/utils/compliance.mjs';
import { DataCleaner } from './lib/llm/council/utils/cleaner.mjs';
import { resolvePositions } from './lib/llm/council/utils/positionResolver.mjs';
import { logDecisions, loadDecisions, getOpenDecisions } from './lib/llm/council/utils/decisionLogger.mjs';
import { runReviewCouncil } from './lib/llm/council/reviewCouncil.mjs';
import { startStopLossWatcher } from './lib/alerts/stopLossWatcher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const RUNS_DIR = join(ROOT, 'runs');
const MEMORY_DIR = join(RUNS_DIR, 'memory');

// Ensure directories exist
for (const dir of [RUNS_DIR, MEMORY_DIR, join(MEMORY_DIR, 'cold')]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// === State ===
let currentData = null;    // Current synthesized dashboard data
let lastSweepTime = null;  // Timestamp of last sweep
let sweepStartedAt = null; // Timestamp when current/last sweep started
let sweepInProgress = false;
let currentContext = null;
let lastGeopoliticalSummary = null; // Latest geopolitical LLM summary from alert evaluator → passed to Scout

// Extracts only the structured labeled fields from Scout's briefing output.
// Gives the Scribe all analytical data in ~400 chars instead of 1500+,
// without blindly slicing mid-sentence.
function extractScoutSummary(raw) {
  const fields = [
    // ESCALATING fields
    'Ticker', 'Horizon', 'Play Type', 'Signal Score', 'Congressional Signal',
    'Rotation_Target', 'Trigger', 'The Data', 'The Story', "Scout's Note", 'Compliance',
    // DEFENSIVE fields
    'Threat', 'Urgency', 'Exit_Before', 'Thesis_Expiry',
  ];
  const lines = [];

  const target = raw.match(/PRIMARY_TARGET:\s*([A-Z]{1,5})/);
  const vix    = raw.match(/VIX:\s*([\d.]+|N\/A)/);
  if (target) lines.push(`Target: ${target[1]}`);
  if (vix)    lines.push(`VIX: ${vix[1]}`);

  for (const f of fields) {
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\*{0,2}${escaped}[:\\*]{1,3}\\s*(.+)`, 'i');
    const m  = raw.match(re);
    if (m && !lines.some(l => l.startsWith(f))) {
      lines.push(`${f}: ${m[1].trim().replace(/\*\*/g, '')}`);
    }
  }

  // Fall back to char-slice if extraction yielded too little (e.g. QUIET output)
  return lines.length >= 3
    ? `[SCOUT BRIEFING]\n${lines.join('\n')}`
    : raw.slice(0, 700) + (raw.length > 700 ? '…' : '');
}

// Trims a debate transcript for Scribe with role-aware limits.
//   Theta, Gregor — NEVER truncated (bear case, Logic block, VERDICT JSON must be verbatim)
//   Phi bull thesis — 1500 chars (generous; thesis can be condensed)
//   user/Scout turn — smart field extraction instead of char-slice
//   Phi selection turn ("Selection: TICKER") — dropped entirely (mechanical noise)
const TRANSCRIPT_CAPS = {
  Theta:  Infinity,  // 3-5 bullets + verdict — must be complete
  Gregor: Infinity,  // Logic block + VERDICT JSON — must be verbatim
  Phi:    1500,      // bull thesis
  default: 900,
};
function compactTranscript(transcript) {
  return (transcript || [])
    .filter(m => m.role !== 'system')
    .filter(m => {
      // Drop Phi's mechanical ticker-selection turn — adds zero analytical value for Scribe
      const content = String(m.content || '').trim();
      return !(m.name === 'Phi' && /^Selection:\s*[A-Z]{1,5}$/i.test(content));
    })
    .map(m => {
      const label   = m.name || m.role;
      const content = String(m.content || '');

      // Scout context: extract structured fields instead of blind truncation
      if (label === 'user') {
        return `Scout Briefing:\n${extractScoutSummary(content)}`;
      }

      const cap     = TRANSCRIPT_CAPS[label] ?? TRANSCRIPT_CAPS.default;
      const trimmed = content.length > cap
        ? content.slice(0, cap) + '…[truncated for brevity]'
        : content;
      return `${label}: ${trimmed}`;
    })
    .join('\n\n');
}

// Reads the most recent logged decision from decisions.json.
// Replaces the old in-memory lastDecision — survives restarts.
function getLastDecision() {
  try {
    const all = loadDecisions();
    if (!all.length) return null;
    const last = all[all.length - 1];
    return {
      ticker:  last.ticker,
      trigger: last.signals?.trigger || null,
      date:    last.timestamp,
    };
  } catch {
    return null;
  }
}
const startTime = Date.now();
const sseClients = new Set();

// === Delta/Memory ===
const memory = new MemoryManager(RUNS_DIR);

// === LLM + Telegram + Discord ===
const llmProvider = createLLMProvider(config.llm);

// Groq fallback for LLM ideas — uses config.fallback.apiKey (GROQ_FALLBACK_KEY in .env).
// llama-3.3-70b-versatile: LPU inference, reliable JSON output, separate API from Gemini.
const groqIdeasFallback = config.fallback?.apiKey
  ? new OpenAIProvider({
      name:    'groq',
      apiKey:  config.fallback.apiKey,
      model:   process.env.GROQ_IDEAS_MODEL || 'llama-3.3-70b-versatile',
      baseUrl: config.redline.phi.baseUrl,
    })
  : null;
if (groqIdeasFallback?.isConfigured) {
  console.log(`[Crucix] LLM ideas fallback ready: Groq / ${groqIdeasFallback.model}`);
}

const snapTrade = new SnapTrade(config.snapTrade)
const telegramAlerter = new TelegramAlerter({...config.telegram, snapTradeInstance: snapTrade});
const discordAlerter = new DiscordAlerter(config.discord || {});
const getLiveQuote = snapTrade.GetLiveQuote.bind(snapTrade);
const redLineEnabled = config.redline.enabled

// Inject shared provider pool into each agent so fallback chains work
const _providers = config.redline.providers || {};
const scout = new ScoutLLM(
  { ...config.redline.scout, durableAssets: config.redline.durableAssets || [] },
  getLiveQuote,
  groqIdeasFallback
);
const bull  = new PhiLLM({ ...(config.redline.phi   || {}), providers: _providers });
const bear  = new ThetaLLM({ ...(config.redline.theta || {}), providers: _providers });
const omega = new GregorLLM({ ...(config.redline.omega || {}), providers: _providers });
const scribe = new GeminiProvider(config.redline.scribe)

const debate = new Debate(bull, bear, omega, snapTrade, getLiveQuote)

if (llmProvider) console.log(`[Crucix] LLM enabled: ${llmProvider.name} (${llmProvider.model})`);
if (telegramAlerter.isConfigured) {
  console.log('[Crucix] Telegram alerts enabled');

  // ─── Two-Way Bot Commands ───────────────────────────────────────────────

  telegramAlerter.onCommand('/status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `🖥️ *CRUCIX STATUS*`,
      ``,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `REDLINE: ${redLineEnabled}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  telegramAlerter.onCommand('/sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    // Fire and forget — don't block the bot response
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  telegramAlerter.onCommand('/brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [
      `📋 *CRUCIX BRIEF*`,
      `_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_`,
      ``,
    ];

    // Delta direction
    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: *${delta.summary.direction.toUpperCase()}* | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical`);
      sections.push('');
    }

    // Key metrics
    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    // OSINT
    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      // Top 2 urgent
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    // Top ideas
    if (ideas.length > 0) {
      sections.push(`💡 *Top Ideas:*`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  telegramAlerter.onCommand('/portfolio', async () => {
    if (sweepInProgress) {console.log('[Crucix] Sweep already in progress, skipping'); return '🔄 Sweep already in progress. Please wait.'};
    const res = await runPortfolio().catch(err => {telegramAlerter.sendMessage("Failed to get Portfolio Briefing"); console.error('[Crucix] Manual sweep failed:', err.message)});
    return formatToTelegramMarkdown(res)
    });

  // Start polling for bot commands
  telegramAlerter.startPolling(config.telegram.botPollingInterval);
}

// === Discord Bot ===
if (discordAlerter.isConfigured) {
  console.log('[Crucix] Discord bot enabled');

  // Reuse the same command handlers as Telegram (DRY)
  discordAlerter.onCommand('status', async () => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const sourcesOk = currentData?.meta?.sourcesOk || 0;
    const sourcesTotal = currentData?.meta?.sourcesQueried || 0;
    const sourcesFailed = currentData?.meta?.sourcesFailed || 0;
    const llmStatus = llmProvider?.isConfigured ? `✅ ${llmProvider.name}` : '❌ Disabled';
    const nextSweep = lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()
      : 'pending';

    return [
      `**🖥️ CRUCIX STATUS**\n`,
      `Uptime: ${h}h ${m}m`,
      `Last sweep: ${lastSweepTime ? new Date(lastSweepTime).toLocaleTimeString() + ' UTC' : 'never'}`,
      `Next sweep: ${nextSweep} UTC`,
      `Sweep in progress: ${sweepInProgress ? '🔄 Yes' : '⏸️ No'}`,
      `Sources: ${sourcesOk}/${sourcesTotal} OK${sourcesFailed > 0 ? ` (${sourcesFailed} failed)` : ''}`,
      `LLM: ${llmStatus}`,
      `SSE clients: ${sseClients.size}`,
      `Dashboard: http://localhost:${config.port}`,
    ].join('\n');
  });

  discordAlerter.onCommand('sweep', async () => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    runSweepCycle().catch(err => console.error('[Crucix] Manual sweep failed:', err.message));
    return '🚀 Manual sweep triggered. You\'ll receive alerts if anything significant is detected.';
  });

  discordAlerter.onCommand('brief', async () => {
    if (!currentData) return '⏳ No data yet — waiting for first sweep to complete.';

    const tg = currentData.tg || {};
    const energy = currentData.energy || {};
    const metals = currentData.metals || {};
    const delta = memory.getLastDelta();
    const ideas = (currentData.ideas || []).slice(0, 3);

    const sections = [`**📋 CRUCIX BRIEF**\n_${new Date().toISOString().replace('T', ' ').substring(0, 19)} UTC_\n`];

    if (delta?.summary) {
      const dirEmoji = { 'risk-off': '📉', 'risk-on': '📈', 'mixed': '↔️' }[delta.summary.direction] || '↔️';
      sections.push(`${dirEmoji} Direction: **${delta.summary.direction.toUpperCase()}** | ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical\n`);
    }

    const vix = currentData.fred?.find(f => f.id === 'VIXCLS');
    const hy = currentData.fred?.find(f => f.id === 'BAMLH0A0HYM2');
    if (vix || energy.wti || metals.gold || metals.silver) {
      sections.push(`📊 VIX: ${vix?.value || '--'} | WTI: $${energy.wti || '--'} | Brent: $${energy.brent || '--'}`);
      sections.push(`   Gold: $${metals.gold || '--'} | Silver: $${metals.silver || '--'}${hy ? ` | HY Spread: ${hy.value}` : ''}`);
      sections.push(`   NatGas: $${energy.natgas || '--'}`);
      sections.push('');
    }

    if (tg.urgent?.length > 0) {
      sections.push(`📡 OSINT: ${tg.urgent.length} urgent signals, ${tg.posts || 0} total posts`);
      for (const p of tg.urgent.slice(0, 2)) {
        sections.push(`  • ${(p.text || '').substring(0, 80)}`);
      }
      sections.push('');
    }

    if (ideas.length > 0) {
      sections.push(`**💡 Top Ideas:**`);
      for (const idea of ideas) {
        sections.push(`  ${idea.type === 'long' ? '📈' : idea.type === 'hedge' ? '🛡️' : '👁️'} ${idea.title}`);
      }
    }

    return sections.join('\n');
  });

  discordAlerter.onCommand('portfolio', async () => {
    return '📊 Portfolio integration requires Alpaca MCP connection.\nUse the Crucix dashboard or Claude agent for portfolio queries.';
  });

  // Start the Discord bot (non-blocking — connection happens async)
  discordAlerter.start().catch(err => {
    console.error('[Crucix] Discord bot startup failed (non-fatal):', err.message);
  });
}

// === Express Server ===
const app = express();
app.use(express.static(join(ROOT, 'dashboard/public')));

// Serve loading page until first sweep completes, then the dashboard with injected locale
app.get('/', (req, res) => {
  if (!currentData) {
    res.sendFile(join(ROOT, 'dashboard/public/loading.html'));
  } else {
    const htmlPath = join(ROOT, 'dashboard/public/jarvis.html');
    let html = readFileSync(htmlPath, 'utf-8');
    
    // Inject locale data into the HTML
    const locale = getLocale();
    const localeScript = `<script>window.__CRUCIX_LOCALE__ = ${JSON.stringify(locale).replace(/<\/script>/gi, '<\\/script>')};</script>`;
    html = html.replace('</head>', `${localeScript}\n</head>`);
    
    res.type('html').send(html);
  }
});

// API: current data
app.get('/api/data', (req, res) => {
  if (!currentData) return res.status(503).json({ error: 'No data yet — first sweep in progress' });
  res.json(currentData);
});

// API: health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    lastSweep: lastSweepTime,
    nextSweep: lastSweepTime
      ? new Date(new Date(lastSweepTime).getTime() + config.refreshIntervalMinutes * 60000).toISOString()
      : null,
    sweepInProgress,
    sweepStartedAt,
    sourcesOk: currentData?.meta?.sourcesOk || 0,
    sourcesFailed: currentData?.meta?.sourcesFailed || 0,
    llmEnabled: !!config.llm.provider,
    llmProvider: config.llm.provider,
    telegramEnabled: !!(config.telegram.botToken && config.telegram.chatId),
    refreshIntervalMinutes: config.refreshIntervalMinutes,
    language: currentLanguage,
  });
});

// API: available locales
app.get('/api/locales', (req, res) => {
  res.json({
    current: currentLanguage,
    supported: getSupportedLocales(),
  });
});

app.get('/api/redline', async (req, res) => {
  try {
    const yfinanceQuotes = currentData?.yfinance?.quotes ?? null;

    // Fetch all data points. Note: currentPort and orders24h are now OBJECTS/ARRAYS, not strings.
    const [currentPort, accountHoldings, orders24h, totalVal, buyPower] = await Promise.all([
      snapTrade.FetchUserTrades(), 
      snapTrade.getBuyDates(), 
      snapTrade.FetchAccountOrders24h(false), 
      snapTrade.FetchAccountTotalValue(), 
      snapTrade.FetchAccountBuyingPower(),
    ]);
    // Since snapTrade.FetchAccountOrders24h() now returns a cleaned array, 
    // we don't need to JSON.parse it here anymore.
    const normalizedOrders = Array.isArray(orders24h) ? orders24h : [];
    res.json({
      // Account data - All fields sent as native JSON for the frontend to consume
      currentPortfolio: currentPort,           // Now an array of cleaned position objects
      accountCurrentHoldings: (accountHoldings), // Raw details for history/dates
      accountOrders24h: { 
        orders: normalizedOrders 
      },                                   // Normalized structure { orders: [] }
      accountTotalValue: totalVal,
      buyingPower: buyPower || 0,

      // Market data
      yfinance: {
        quotes: yfinanceQuotes,
      },
    });
  } catch (error) {
    console.error("[REDLINE API] Fatal Error:", error.message);
    res.status(500).json({ error: "Internal Server Error", details: error.message });
  }
});
// List all reports (.html and .md for inline viewing; .docx listed for download)
app.get('/api/reports', (req, res) => {
  try {
    const dir = join(process.cwd(), 'reports');
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md') || f.endsWith('.txt') || f.endsWith('.html') || f.endsWith('.docx'))
      .sort()
      .reverse(); // newest first
    res.json({ reports: files });
  } catch (err) {
    res.json({ reports: [] });
  }
});

// Read a single report by filename (text/html only — use /download for .docx)
app.get('/api/reports/:filename', (req, res) => {
  try {
    const safe = req.params.filename.replace(/[^a-zA-Z0-9._\-]/g, '');
    if (safe.endsWith('.docx')) {
      return res.status(400).json({ error: 'Use /api/reports/download/:filename for .docx files.' });
    }
    const content = readFileSync(join(process.cwd(), 'reports', safe), 'utf8');
    res.json({ content });
  } catch (err) {
    res.status(404).json({ error: 'Report not found' });
  }
});

// Download a .docx report as binary
app.get('/api/reports/download/:filename', (req, res) => {
  try {
    const safe = req.params.filename.replace(/[^a-zA-Z0-9._\-]/g, '');
    const filePath = join(process.cwd(), 'reports', safe);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.sendFile(filePath);
  } catch (err) {
    res.status(500).json({ error: 'Download failed' });
  }
});

// Delete a report (and its .docx twin if it exists)
app.delete('/api/reports/:filename', (req, res) => {
  try {
    const safe = req.params.filename.replace(/[^a-zA-Z0-9._\-]/g, '');
    const dir  = join(process.cwd(), 'reports');
    const filePath = join(dir, safe);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    unlinkSync(filePath);
    // If deleting an HTML review, also remove the .docx twin
    if (safe.endsWith('.html')) {
      const twin = join(dir, safe.replace('.html', '.docx'));
      if (existsSync(twin)) unlinkSync(twin);
    }
    console.log(`[Reports] Deleted: ${safe}`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Delete failed: ' + err.message });
  }
});

// SSE: live updates
app.get('/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('data: {"type":"connected"}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(msg); } catch { sseClients.delete(client); }
  }
}

// === Sweep Cycle ===
async function runSweepCycle() {
  if (sweepInProgress) {
    console.log('[Crucix] Sweep already in progress, skipping');
    return;
  }

  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // Prelim: Refresh User Trades
    // 1. Run the full briefing sweep
    const [rawData] = await Promise.all([fullBriefing(), snapTrade.RefreshHoldings()])
    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const [synthesized, userPortfolio, accountOrders ]= await Promise.all([synthesize(rawData), snapTrade.FetchUserTrades(), snapTrade.getBuyDates()]);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;
    // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
    if (llmProvider?.isConfigured) {
      try {
        console.log('[Crucix] Generating LLM trade ideas...');
        
        const previousIdeas = memory.getLastRun()?.ideas || [];
        const ideasResult = await generateLLMIdeas(llmProvider, synthesized, delta, previousIdeas, JSON.stringify(userPortfolio), accountOrders, groqIdeasFallback);
        if (ideasResult) {
          const { llmIdeas, context } = ideasResult;
          currentContext = context;
          if (llmIdeas) {
            synthesized.ideas = llmIdeas;
            synthesized.ideasSource = 'llm';
            console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
          } else {
            synthesized.ideas = [];
            synthesized.ideasSource = 'llm-failed';
          }
        } else {
          // generateLLMIdeas returned null — model failed, preserve last known context for debate
          synthesized.ideas = [];
          synthesized.ideasSource = 'llm-failed';
          console.warn('[Crucix] LLM ideas returned null — sweep continues, using prior context for debate.');
        }
      } catch (llmErr) {
        console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
        synthesized.ideas = [];
        synthesized.ideasSource = 'llm-failed';
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 6. Alert evaluation — Telegram + Discord (LLM with rule-based fallback, multi-tier, semantic dedup)
    if (delta?.summary?.totalChanges > 0) {
      if (telegramAlerter.isConfigured) {
        telegramAlerter.evaluateAndAlert(llmProvider, delta, memory)
          .then(() => {
            // Capture the latest geopolitical summary for Scout context next cycle
            if (telegramAlerter.lastGeopoliticalSummary) {
              lastGeopoliticalSummary = telegramAlerter.lastGeopoliticalSummary;
              console.log('[Crucix] Geopolitical summary updated from Telegram evaluator');
            }
          })
          .catch(err => {
            console.error('[Crucix] Telegram alert error:', err.message);
          });
      }
      if (discordAlerter.isConfigured) {
        discordAlerter.evaluateAndAlert(llmProvider, delta, memory).catch(err => {
          console.error('[Crucix] Discord alert error:', err.message);
        });
      }
    }

    // Prune old alerted signals
    memory.pruneAlertedSignals();

    currentData = synthesized;

    // 6. Push to all connected browsers
    broadcast({ type: 'update', data: currentData });

    console.log(`[Crucix] Sweep complete — ${currentData.meta.sourcesOk}/${currentData.meta.sourcesQueried} sources OK`);
    console.log(`[Crucix] ${currentData.ideas.length} ideas (${synthesized.ideasSource}) | ${currentData.news.length} news | ${currentData.newsFeed.length} feed items`);
    if (delta?.summary) console.log(`[Crucix] Delta: ${delta.summary.totalChanges} changes, ${delta.summary.criticalChanges} critical, direction: ${delta.summary.direction}`);
    if(redLineEnabled && currentContext) await CheckDebateCycle(currentContext)
    console.log(`[Crucix] Next sweep at ${new Date(Date.now() + config.refreshIntervalMinutes * 60000).toLocaleTimeString()}`);


  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

async function runPortfolio() {
  console.log('[Crucix] Generating Report...')
  telegramAlerter.sendMessage('Generating Report ...')
  sweepInProgress = true;
  sweepStartedAt = new Date().toISOString();
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // 1. Run the full briefing sweep
    const rawData = await fullBriefing();

    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const synthesized = await synthesize(rawData);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;
    const previousIdeas = memory.getLastRun()?.ideas || [];
  // 5. LLM-powered trade ideas (LLM-only feature) — isolated so failures don't kill sweep
  if (llmProvider?.isConfigured) {
    let result;
    try {
    const [accountOrders, portfolio] = await Promise.all([snapTrade.getBuyDates(),snapTrade.FetchUserTrades()]);
    result = await runPortfolioBrief(llmProvider, synthesized, delta, previousIdeas, JSON.stringify(portfolio), accountOrders )
    return result.text
    } catch(err) {
      console.error("Failed to get Portfolio Briefing: ", err.message, '\n', (result?.text ?? '(no result)'))
    }
    finally {
      console.log("[Crucix] Report Created at", new Date().toISOString())
      console.log(`${'='.repeat(60)}`)
      sweepInProgress = false;
    }
  }
} catch (err) {
  console.error('[Crucix] Sweep failed:', err.message);
  broadcast({ type: 'sweep_error', error: err.message });
} finally {
  sweepInProgress = false;
}
}

async function CheckDebateCycle(context) {
  const [buyingPower, openAccountOrders, orderCompliance, orders24h] = await Promise.all([
      snapTrade.FetchAccountBuyingPower(),
      snapTrade.FetchOpenAccountOrders(),
      snapTrade.FetchOrderCompliance(),
      snapTrade.FetchAccountOrders24h(true)
  ]);
  const stringifiedOrders24h = DataCleaner.stringifyOrders(orders24h)
  const remaining = calculateRemainingDayTrades(orderCompliance)
  const isRestricted = remaining === 0;
  console.log(`[REDLINE] 📊 DAY TRADES REMAINING: ${remaining}/3`);
  if (isRestricted) {
      console.warn("[REDLINE] 🛡️ PDT PROTECTION ACTIVE: Bot is restricted to Overnight Holds.");
  }
  const lastDecision = getLastDecision();
  console.log(`[REDLINE] Last decision → Ticker: ${lastDecision?.ticker || 'None'} | Trigger: ${lastDecision?.trigger || 'None'} | Date: ${lastDecision?.date || 'None'}`);

  const openPositionCount = getOpenDecisions().length;
  console.log(`[REDLINE] Open logged positions: ${openPositionCount}`);

  const result = await scout.assessInfo(
      context,
      currentData,
      snapTrade.GetCurrentPortfolio(),
      lastDecision,
      buyingPower,
      openAccountOrders,
      remaining,
      stringifiedOrders24h,
      openPositionCount,
      lastGeopoliticalSummary
  );

  console.log(`[SCOUT] ${result}`);
  if (!result) return;

  // SCOUT "QUIET" CHECK
  if (result.toUpperCase().includes("QUIET")) {
      console.log(`[REDLINE] Scout Status: QUIET. Standing down.`);
      return;
  }

  // SCOUT "TRADE AROUND" CHECK — durable asset with temporary headwind or profit-taking opportunity.
  // Instead of selling at a loss, place a GTC SELL at breakeven/R1 and re-enter lower next sweep.
  if (result.toUpperCase().includes("STATUS: TRADE AROUND")) {
      const taTickerMatch    = result.match(/[-\s]*Ticker:\s*([A-Z]{1,5})/i);
      const taTicker         = taTickerMatch?.[1]?.toUpperCase() || 'UNKNOWN';
      const sellTargetMatch  = result.match(/Sell_Target:\s*\$?([\d.]+)/i);
      const reentryMatch     = result.match(/Reentry_Target:\s*\$?([\d.]+)/i);
      const unitsToSellMatch = result.match(/Units_To_Sell[^:]*:\s*[^=\n]*=?\s*([\d.]+)/i);
      const unitsRemainingMatch = result.match(/Units_Remaining[^:]*:\s*[^=\n]*=?\s*([\d.]+)/i);
      const scenarioMatch    = result.match(/Scenario:\s*(UNDERWATER|PARTIAL[_\s]EXIT|PROFIT[_\s]TAKE|BREAKEVEN[_\s]EXIT)/i);
      const sellTarget       = sellTargetMatch    ? parseFloat(sellTargetMatch[1])    : null;
      const reentryTarget    = reentryMatch       ? parseFloat(reentryMatch[1])       : null;
      const unitsToSell      = unitsToSellMatch   ? parseFloat(unitsToSellMatch[1])   : null;
      const unitsRemaining   = unitsRemainingMatch? parseFloat(unitsRemainingMatch[1]): null;
      const scenario         = scenarioMatch?.[1]?.toUpperCase().replace(/[\s]/, '_') || 'UNDERWATER';
      const isPartialExit    = scenario === 'PARTIAL_EXIT';

      const scenarioEmoji = scenario === 'PROFIT_TAKE' ? '💰' : scenario === 'BREAKEVEN_EXIT' ? '🚪' : isPartialExit ? '🎯' : '🔄';
      console.log(`[REDLINE] ${scenarioEmoji} TRADE AROUND — ${taTicker} | Scenario: ${scenario} | Sell: $${sellTarget ?? '?'}${isPartialExit ? ` | Units: ${unitsToSell ?? '?'} (${unitsRemaining ?? '?'} free-ride remaining)` : ` | Reentry: $${reentryTarget ?? '?'}`}`);

      const scenarioInstruction = isPartialExit
          ? `PARTIAL EXIT: Sell exactly ${unitsToSell ?? 'Units_To_Sell'} units to recover full original cost basis. The remaining ${unitsRemaining ?? 'Units_Remaining'} units cost $0 — they ride free. Phi: confirm sell price $${sellTarget} is achievable. Theta: confirm this is the right exit size — flag if units math looks wrong. Gregor: SELL exactly ${unitsToSell ?? 'Units_To_Sell'} units at $${sellTarget} GTC Limit. DO NOT sell all units — only the calculated recovery amount.`
          : scenario === 'PROFIT_TAKE'
          ? `Lock in gains and re-enter lower. Position is up >15% — don't ride it back to flat.`
          : scenario === 'BREAKEVEN_EXIT'
          ? `Original catalyst resolved — full exit at current price to free capital. Phi: confirm thesis is depleted. Theta: confirm no continuation. If either finds intact thesis, output WAIT.`
          : `Exit at breakeven or better — do NOT sell at current loss.`;

      const tradeAroundBriefing = [
          result,
          ``,
          `⚡ TRADE AROUND MODE (${scenario}): Scout identified a held position for exit management.`,
          `Scenario context: ${scenarioInstruction}`,
          isPartialExit
              ? `Gregor SELL INSTRUCTION: units = ${unitsToSell ?? 'Units_To_Sell from Scout output'} | price = $${sellTarget ?? 'Sell_Target'} | order_type = Limit | time_in_force = GTC`
              : `Gregor: place a GTC SELL Limit at $${sellTarget ?? 'Scout stated target'}.`,
          `  - order_type MUST be Limit (not Market) — we are working the order, not dumping.`,
          `  - time_in_force MUST be GTC.`,
          ...(!isPartialExit ? [`  - DO NOT place a re-entry BUY now — re-entry at $${reentryTarget ?? 'Reentry_Target'} handled next sweep after fill.`] : [
              `  - DO NOT sell all units — only ${unitsToSell ?? 'calculated recovery amount'} units.`,
              `  - DO NOT place a re-entry BUY — remaining ${unitsRemaining ?? '?'} units are already held as the free-ride position.`,
          ]),
      ].join('\n');

      const taResult  = await debate.beginDebate(tradeAroundBriefing, context, remaining);
      const taTrades  = Array.isArray(taResult) ? taResult : [taResult];
      const taActions = taTrades.filter(t => t && t.action && t.action !== 'WAIT');

      if (taActions.length === 0) {
          console.log(`[REDLINE] 🔄 TRADE AROUND debate returned WAIT — no order placed for ${taTicker}.`);
          //telegramAlerter.sendMessage?.(`🔄 *TRADE AROUND WAIT — ${taTicker}*\nCouncil could not confirm Sell Target $${sellTarget} is reachable. Monitoring.`);
          return;
      }

      for (const trade of taActions) {
          if (isDayTrade(trade, remaining, stringifiedOrders24h)) {
              console.error(`[CRITICAL] CIRCUIT BREAKER: TRADE AROUND ${trade.action} on ${trade.symbol} blocked — PDT limit.`);
              continue;
          }
          // Hard-enforce GTC Limit — TRADE AROUND is never a market dump
          if (trade.action === 'SELL') {
              trade.order_type    = 'Limit';
              trade.time_in_force = 'GTC';
              // Always use Scout's sell target — Gregor's no-candle pricing rules are irrelevant here
              if (sellTarget) trade.price = sellTarget;

              // PARTIAL_EXIT: hard-clamp units to Scout's calculated recovery amount.
              // Gregor may output all units — mechanical override ensures only the
              // cost-recovery portion is sold, leaving the free-ride remainder intact.
              if (isPartialExit && unitsToSell != null) {
                  if (trade.units == null || Math.abs(trade.units - unitsToSell) > 0.001) {
                      console.log(`[REDLINE] 🎯 PARTIAL_EXIT unit clamp: ${trade.symbol} — overriding Gregor's ${trade.units ?? 'null'} units → ${unitsToSell} (cost-recovery amount). Remainder: ${unitsRemaining ?? '?'} free-ride shares stay.`);
                      trade.units = unitsToSell;
                  }
                  // Fractional partial sells must use Day tif per SnapTrade rules
                  if (!Number.isInteger(unitsToSell)) trade.time_in_force = 'Day';
              }
          }

          const freeRideNote = isPartialExit ? ` | Free-ride remainder: ${unitsRemaining ?? '?'} shares` : ` | Re-entry: $${reentryTarget ?? 'TBD'}`;
          console.log(`[REDLINE] ${scenarioEmoji} Placing TRADE AROUND GTC SELL (${scenario}): ${trade.symbol} @ $${trade.price} × ${trade.units ?? 'all'} units`);
          const orderRes = await snapTrade.PlaceOrder(trade);
          if (!orderRes) { console.error(`[REDLINE] ❌ TRADE AROUND order failed for ${trade.symbol}.`); continue; }
          console.log(`[REDLINE] ${scenarioEmoji} TRADE AROUND placed ✅: ${trade.symbol} @ $${trade.price}${freeRideNote}`);

          const tgLabel = isPartialExit
              ? `🎯 *Partial Exit — ${trade.symbol}*\nSelling ${unitsToSell} units @ $${trade.price} (GTC Limit).\n${unitsRemaining ?? '?'} shares remain as free-ride position (zero cost basis).`
              : scenario === 'PROFIT_TAKE'
              ? `💰 *Profit Take — ${trade.symbol}*\nGTC SELL @ $${trade.price}.\nRe-entry: $${reentryTarget ?? 'TBD'} next sweep.`
              : scenario === 'BREAKEVEN_EXIT'
              ? `🚪 *Breakeven Exit — ${trade.symbol}*\nGTC SELL @ $${trade.price}.\nRe-entry: $${reentryTarget ?? 'TBD'} next sweep.`
              : `🔄 *Trade Around — ${trade.symbol}*\nGTC SELL @ $${trade.price}.\nRe-entry: $${reentryTarget ?? 'TBD'} next sweep.`;
          telegramAlerter.sendMessage?.(tgLabel);
          telegramAlerter.sendTradeAlert(trade);
          try {
              const liveVix = currentData?.fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
              logDecisions([trade], result, liveVix, remaining, {
                  horizon: 'SWING',
                  trigger: `TRADE_AROUND_${scenario}@${sellTarget}`,
                  signalScore: null,
              });
          } catch (err) { console.error('[DecisionLogger] Failed to log TRADE AROUND:', err.message); }
          await runScribeReport(trade, `${scenarioEmoji} TRADE AROUND (${scenario})`);
      }
      return;
  }

  // SCOUT "DEFENSIVE" CHECK — held position threatened, route to exit debate
  if (result.toUpperCase().includes("STATUS: DEFENSIVE")) {
      const urgencyMatch  = result.match(/Urgency:\s*(IMMEDIATE|SWING|WATCH)/i);
      const defUrgency    = urgencyMatch?.[1]?.toUpperCase() || 'IMMEDIATE';
      const defTickerMatch = result.match(/[-\s]*Ticker:\s*([A-Z]{1,5})/i);
      const defTicker     = defTickerMatch?.[1]?.toUpperCase() || 'UNKNOWN';
      const defThreatMatch = result.match(/Threat:\s*(.+)/i);
      const defThreat     = defThreatMatch?.[1]?.trim().slice(0, 120) || '(no threat summary)';
      console.log(`[REDLINE] 🛡 Scout Status: DEFENSIVE | Ticker: ${defTicker} | Urgency: ${defUrgency}`);

      // WATCH = monitor only — threat is real but not imminent enough to act now.
      // Debating and potentially executing on a WATCH signal wastes a trade and ignores Scout's judgement.
      if (defUrgency === 'WATCH') {
          console.log(`[REDLINE] 🛡 DEFENSIVE WATCH — no debate triggered. Alerting and standing by.`);
          telegramAlerter.sendMessage?.(
              `🛡 *DEFENSIVE WATCH — ${defTicker}*\n${defThreat}…\n_Scout flagged a threat but recommends holding. No order placed._`
          );
          return;
      }

      // SWING = threat is building, debate with HOLD bias — Phi must make a concrete case to hold.
      // IMMEDIATE = exit debate with EXIT bias — default to SELL unless Phi has a hard counter.
      console.log(`[REDLINE] 🛡 DEFENSIVE ${defUrgency} — routing to exit debate...`);

      const defensiveBriefing = [
          result,
          ``,
          `⚠ DEFENSIVE MODE: Scout has identified a held position facing imminent downside.`,
          `Council objective: determine whether to EXIT before the threat materialises.`,
          `Phi argues HOLD (why the thesis survives or threat is wrong). Theta argues EXIT (why the threat is real and imminent).`,
          `Gregor: default bias is SELL — exit before the market prices it in. Hold only if Phi provides a concrete counter to the specific threat.`,
          `URGENCY: ${defUrgency}. ${defUrgency === 'IMMEDIATE'
              ? 'Use order_type=Market tif=Day — guaranteed exit, price optimisation is secondary.'
              : 'Limit@current price acceptable — urgency allows time to work the order.'}`,
      ].join('\n');

      const defResult  = await debate.beginDebate(defensiveBriefing, context, remaining);
      const defTrades  = Array.isArray(defResult) ? defResult : [defResult];
      const defActions = defTrades.filter(t => t && t.action && t.action !== 'WAIT');

      if (defActions.length === 0) {
          console.log(`[REDLINE] 🛡 Defensive debate returned WAIT — holding position.`);
          return;
      }

      for (const trade of defActions) {
          if (isDayTrade(trade, remaining, stringifiedOrders24h)) {
              console.error(`[CRITICAL] CIRCUIT BREAKER: Defensive ${trade.action} on ${trade.symbol} blocked — PDT limit.`);
              continue;
          }

          // IMMEDIATE urgency → force Market order so the exit is guaranteed.
          // A SELL Limit at current price can sit unfilled if price ticks down before execution.
          if (defUrgency === 'IMMEDIATE' && trade.action === 'SELL' && trade.order_type === 'Limit') {
              console.log(`[REDLINE] 🛡 IMMEDIATE urgency — overriding Limit→Market for guaranteed exit on ${trade.symbol}.`);
              trade.order_type = 'Market';
              trade.price      = null;
          }

          console.log(`[REDLINE] 🛡 Defensive ${trade.action} ${trade.symbol} @ $${trade.price ?? 'market'} (${trade.order_type})`);
          const orderRes = await snapTrade.PlaceOrder(trade);
          if (!orderRes) { console.error(`[REDLINE] ❌ Defensive order failed for ${trade.symbol}.`); continue; }
          console.log(`[REDLINE] 🛡 Defensive order executed ✅: ${trade.symbol}`);
          telegramAlerter.sendTradeAlert(trade);

          // Log with DEFENSIVE horizon override — extractSignals can't find standard Scout fields here
          try {
              const liveVix = currentData?.fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
              const threatMatch = result.match(/Threat:\s*(.+)/i);
              logDecisions([trade], result, liveVix, remaining, {
                  horizon:     'DEFENSIVE',
                  trigger:     defUrgency,
                  signalScore: null,
              });
          } catch (err) { console.error('[DecisionLogger] Failed to log defensive trade:', err.message); }

          // Scribe post-mortem — same as regular trades
          await runScribeReport(trade, '🛡 DEFENSIVE');
      }
      return;
  }

  // SCOUT "AVERAGE_DOWN" CHECK — held durable asset at support, thesis intact, adding lowers cost basis
  if (result.toUpperCase().includes("STATUS: AVERAGE_DOWN")) {
      const adTickerMatch   = result.match(/[-\s]*Ticker:\s*([A-Z]{1,5})/i);
      const adTicker        = adTickerMatch?.[1]?.toUpperCase() || 'UNKNOWN';
      const addPriceMatch   = result.match(/Add_Price:\s*\$?([\d.]+)/i);
      const newAvgCostMatch = result.match(/New_Avg_Cost:\s*\$?([\d.]+)/i);
      const supportMatch    = result.match(/Support_Level:\s*(.+)/i);
      const addPrice        = addPriceMatch   ? parseFloat(addPriceMatch[1])   : null;
      const newAvgCost      = newAvgCostMatch ? parseFloat(newAvgCostMatch[1]) : null;
      const supportLevel    = supportMatch?.[1]?.trim().slice(0, 60) || '(unknown)';

      console.log(`[REDLINE] 📉 AVERAGE DOWN — ${adTicker} | Add Price: $${addPrice ?? '?'} | New Avg Cost: $${newAvgCost ?? '?'}`);

      const avgDownBriefing = [
          result,
          ``,
          `📉 AVERAGE DOWN MODE: Scout identified a held durable asset at support with intact thesis.`,
          `Council objective: validate that adding at this price lowers cost basis with acceptable risk.`,
          `Support: ${supportLevel}`,
          `Phi: confirm the support level is real and the structural thesis remains intact. Show updated bull case with new avg cost.`,
          `Theta: confirm a defined stop level exists below support. Flag immediately if S1/S2 is undefined or thesis is structurally broken — REJECT if stop cannot be defined.`,
          `Gregor: place GTC BUY Limit at $${addPrice ?? 'Add_Price from Scout output'}.`,
          `  - order_type MUST be Limit — we are adding at support, not chasing at market.`,
          `  - time_in_force MUST be GTC — support test may take 1-3 sessions to fill.`,
          `  - price MUST be $${addPrice ?? 'Add_Price'}.`,
          `  - Size to achieve New_Avg_Cost of $${newAvgCost ?? 'stated in Scout output'}.`,
          `  - If council cannot confirm support is real or thesis is intact → output WAIT.`,
      ].join('\n');

      const adResult  = await debate.beginDebate(avgDownBriefing, context, remaining);
      const adTrades  = Array.isArray(adResult) ? adResult : [adResult];
      const adActions = adTrades.filter(t => t && t.action && t.action !== 'WAIT');

      if (adActions.length === 0) {
          console.log(`[REDLINE] 📉 AVERAGE DOWN debate returned WAIT — no order placed for ${adTicker}.`);
          return;
      }

      for (const trade of adActions) {
          if (isDayTrade(trade, remaining, stringifiedOrders24h)) {
              console.error(`[CRITICAL] CIRCUIT BREAKER: AVERAGE DOWN ${trade.action} on ${trade.symbol} blocked — PDT limit.`);
              continue;
          }

          // Hard-enforce GTC Limit — we are adding at support, not market buying
          if (trade.action === 'BUY') {
              trade.order_type    = 'Limit';
              trade.time_in_force = 'GTC';
              if (addPrice) trade.price = addPrice;
          }

          console.log(`[REDLINE] 📉 Placing AVERAGE DOWN GTC BUY: ${trade.symbol} @ $${trade.price}`);
          const orderRes = await snapTrade.PlaceOrder(trade);
          if (!orderRes) { console.error(`[REDLINE] ❌ AVERAGE DOWN order failed for ${trade.symbol}.`); continue; }
          console.log(`[REDLINE] 📉 AVERAGE DOWN GTC BUY placed ✅: ${trade.symbol} @ $${trade.price} | New Avg Cost target: $${newAvgCost ?? 'TBD'}`);
          telegramAlerter.sendMessage?.(
              `📉 *AVERAGE DOWN — ${trade.symbol}*\nGTC BUY Limit @ $${trade.price} placed.\nNew avg cost after fill: $${newAvgCost ?? 'TBD'}`
          );
          telegramAlerter.sendTradeAlert(trade);
          try {
              const liveVix = currentData?.fred?.find(f => f.id === 'VIXCLS')?.value ?? 'N/A';
              logDecisions([trade], result, liveVix, remaining, {
                  horizon:     'SWING',
                  trigger:     `AVERAGE_DOWN@${addPrice}`,
                  signalScore: null,
              });
          } catch (err) { console.error('[DecisionLogger] Failed to log AVERAGE DOWN:', err.message); }
          await runScribeReport(trade, '📉 AVERAGE DOWN');
      }
      return;
  }

  // 3. ESCALATE TO COUNCIL
  console.log("[REDLINE] SCOUT DETECTED OPPORTUNITY. ESCALATING TO COUNCIL...");
  let debateResult = await debate.beginDebate(result, context, remaining);
  
  const trades = Array.isArray(debateResult) ? debateResult : [debateResult];
  const actionableTrades = trades.filter(t => t && t.action && t.action !== "WAIT");

  // 4. COUNCIL "WAIT" HANDLING
  if (actionableTrades.length === 0) {
      console.log("[REDLINE] Council returned no actionable trades (Verdict: WAIT).");
      // lastDecision IS ALREADY SAVED ABOVE, so we can safely exit here.
      return;
  }

  // 5. EXECUTION LOOP (Actionable trades only)
    for (const trade of actionableTrades) {
      if (isDayTrade(trade, remaining, stringifiedOrders24h)) {
        console.error(`[CRITICAL] CIRCUIT BREAKER: Blocked ${trade.action} on ${trade.symbol}. Already traded today & 0 day trades left.`);
        continue; 
      }
        console.log(`[REDLINE] Execution Triggered: ${trade.action} ${trade.symbol}`);
        const orderRes = await snapTrade.PlaceOrder(trade);
        
      if (!orderRes) {
          console.error(`[REDLINE] ❌ Order failed for ${trade.symbol}.`);
          break;
      }
      console.log(`[REDLINE] Order Executed ✅: ${trade.symbol}`);
      telegramAlerter.sendTradeAlert(trade);

      // Log to decisions.json only after confirmed execution
      try {
        // VIX: try FRED (daily value) → yfinance ^VIX quote → N/A
        const liveVix = currentData?.fred?.find(f => f.id === 'VIXCLS')?.value
            ?? currentData?.yfinance?.quotes?.find?.(q => q.symbol === '^VIX')?.price
            ?? 'N/A';
        logDecisions([trade], result, liveVix, remaining);
      } catch (err) {
        console.error('[DecisionLogger] Failed to log executed trade:', err.message);
      }

      // Reporting — Scribe post-mortem
      await runScribeReport(trade);
  }
}
// === Startup ===
async function start() {
  const port = config.port;
  const HOST = '0.0.0.0'
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║           CRUCIX INTELLIGENCE ENGINE         ║
  ║          Local Palantir · 26 Sources         ║
  ╠══════════════════════════════════════════════╣
  ║  Dashboard:  http://localhost:${port}${' '.repeat(15 - String(port).length)}║
  ║  Health:     http://localhost:${port}/api/health${' '.repeat(4 - String(port).length)}║
  ║  Refresh:    Every ${config.refreshIntervalMinutes} min${' '.repeat(22 - String(config.refreshIntervalMinutes).length)}║
  ║  LLM:        ${(config.llm.provider || 'disabled').padEnd(32)}║
  ║  Telegram:   ${config.telegram.botToken ? 'enabled' : 'disabled'}${' '.repeat(config.telegram.botToken ? 25 : 24)}║
  ║  Discord:    ${config.discord?.botToken ? 'enabled' : config.discord?.webhookUrl ? 'webhook only' : 'disabled'}${' '.repeat(config.discord?.botToken ? 24 : config.discord?.webhookUrl ? 20 : 24)}║
  ║  SnapTrade:  ${config.snapTrade?.accountId ? 'enabled' : 'disabled'}${' '.repeat(config.snapTrade.accountId ? 25 : 24)}║
  ║  REDLINE:    ${redLineEnabled ? 'enabled' : 'disabled'}${' '.repeat(redLineEnabled ? 25 : 24)}║
  ╚══════════════════════════════════════════════╝
  `);

  const server = app.listen(port, HOST);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n[Crucix] FATAL: Port ${port} is already in use!`);
      console.error(`[Crucix] A previous Crucix instance may still be running.`);
      console.error(`[Crucix] Fix:  taskkill /F /IM node.exe   (Windows)`);
      console.error(`[Crucix]       kill $(lsof -ti:${port})   (macOS/Linux)`);
      console.error(`[Crucix] Or change PORT in .env\n`);
    } else {
      console.error(`[Crucix] Server error:`, err.stack || err.message);
    }
    process.exit(1);
  });

  server.on('listening', async () => {
    console.log(`[Crucix] Server running on http://localhost:${port}`);

    // Auto-open browser
    // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
    // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
    const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                    process.platform === 'darwin' ? 'open' : 'xdg-open';
    exec(`${openCmd} "http://localhost:${port}"`, (err) => {
      if (err) console.log('[Crucix] Could not auto-open browser:', err.message);
    });

    // Try to load existing data first for instant display (await so dashboard shows immediately)
    try {
      const existing = JSON.parse(readFileSync(join(RUNS_DIR, 'latest.json'), 'utf8'));
      const data = await synthesize(existing);
      currentData = data;
      console.log('[Crucix] Loaded existing data from runs/latest.json — dashboard ready instantly');
      broadcast({ type: 'update', data: currentData });
    } catch {
      console.log('[Crucix] No existing data found — first sweep required');
    }

    // Run first sweep (refreshes data in background)
    console.log('[Crucix] Running initial sweep...');
    runSweepCycle().catch(err => {
      console.error('[Crucix] Initial sweep failed:', err.message || err);
    });

    // Schedule recurring sweeps
    setInterval(runSweepCycle, config.refreshIntervalMinutes * 60 * 1000);

    // ── Review Mode — runs once daily after market close (4:30 PM ET) ──────
    // Resolves open positions against live portfolio, then generates a
    // performance review report if new data exists since the last review.
    scheduleReviewMode();

    // ── Stop-Loss Watcher — runs every 90s, completely independent of council ──
    // Fires hard exits on open logged positions when stop-loss, trailing stop,
    // or INTRADAY EOD thresholds are breached. No LLM involved.
    startStopLossWatcher(snapTrade, telegramAlerter);
  });
}

/**
 * Schedules the Review Mode to fire at 4:30 PM ET daily.
 * On startup, checks if today's review has already run; if not, fires immediately.
 * Uses a simple polling interval (every minute) to avoid timezone complexity.
 */
// ── Scribe post-mortem helper — reused by both ESCALATING and DEFENSIVE branches ──
async function runScribeReport(trade, label = '') {
  try {
    const cleanTranscript = compactTranscript(trade.transcript);
    console.log(`[SCRIBE] ${label ? label + ' ' : ''}Transcript compacted to ${cleanTranscript.length} chars`);
    console.log(`[REDLINE] Cooling down for 10s before Scribe...`);
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log(`[REDLINE] Initializing Scribe...`);
    let scribeRes;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        scribeRes = await scribe.complete(ScribePrompt, cleanTranscript, { maxTokens: 6000 }, true);
        break;
      } catch (err) {
        const is429 = err.message?.includes('429') || err.message?.includes('quota');
        if (is429 && attempt < 3) {
          console.warn(`[SCRIBE] 429 rate limit (attempt ${attempt}/3) — waiting 30s...`);
          await new Promise(r => setTimeout(r, 30000));
        } else { throw err; }
      }
    }
    await generateLocalReport(trade.symbol, cleanTranscript, scribeRes.text);
    console.log(`[SCRIBE] ✅ Report generated for ${trade.symbol}`);
  } catch (e) {
    console.log('SCRIBE FAILED: ', e.message);
  }
}

function scheduleReviewMode() {
  // Seed from reviewState.json so restarts don't re-trigger a review that already ran today
  const REVIEW_STATE_PATH = join(ROOT, 'runs', 'reviewState.json');
  let lastReviewDate = (() => {
    try {
      if (existsSync(REVIEW_STATE_PATH)) {
        const state = JSON.parse(readFileSync(REVIEW_STATE_PATH, 'utf8'));
        if (state.lastReviewAt) {
          const et = new Date(
            new Date(state.lastReviewAt).toLocaleString('en-US', { timeZone: 'America/New_York' })
          );
          return et.toISOString().slice(0, 10);
        }
      }
    } catch { /* no state yet */ }
    return null;
  })();

  async function runReview() {
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et    = new Date(etStr);
    const today = et.toISOString().slice(0, 10);
    const hour  = et.getHours();
    const min   = et.getMinutes();

    // Gate 1: must be 4:30 PM ET or later — always enforced, never skipped on startup
    if (hour < 16 || (hour === 16 && min < 30)) return;
    // Gate 2: only once per calendar day
    if (lastReviewDate === today) return;

    console.log('[Review] Market close review starting...');
    lastReviewDate = today;

    try {
      // Phase 2 — reconcile open positions against live portfolio
      const resolverSummary = await resolvePositions(snapTrade);
      console.log(`[Review] Resolver complete — resolved: ${resolverSummary.resolved}, updated: ${resolverSummary.updated}`);

      // Phase 3 — run strategic review council (computes stats, writes lastReview.json, generates report)
      const reviewResult = await runReviewCouncil();
      if (reviewResult?.reportFile) {
        const { stats, reportFile } = reviewResult;
        const wrPct = (stats.winRate * 100).toFixed(0);
        const pf    = stats.profitFactor === 999 ? '∞' : stats.profitFactor.toFixed(2);
        console.log(`[Review] Performance review generated: ${reportFile}`);
        telegramAlerter.sendMessage?.(
          `◈ RedLine Review complete\n` +
          `Win Rate: ${wrPct}% | Profit Factor: ${pf}\n` +
          `Resolved: ${stats.resolved} / ${stats.totalDecisions} decisions\n` +
          `Report: ${reportFile}`
        );
      } else if (reviewResult) {
        console.log('[Review] lastReview.json updated — no new report generated (no new resolved decisions).');
      } else {
        console.log('[Review] No resolved decisions — review skipped.');
      }
    } catch (err) {
      console.error('[Review] Review Mode failed:', err.message);
    }
  }

  // Check every minute whether it's time to run the review
  setInterval(runReview, 60 * 1000);
  // Also attempt on startup (will skip if before 4:30 PM ET)
  runReview();
}

// Graceful error handling — log full stack traces for diagnosis
process.on('unhandledRejection', (err) => {
  console.error('[Crucix] Unhandled rejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[Crucix] Uncaught exception:', err?.stack || err?.message || err);
});

start().catch(err => {
  console.error('[Crucix] FATAL — Server failed to start:', err?.stack || err?.message || err);
  process.exit(1);
});
