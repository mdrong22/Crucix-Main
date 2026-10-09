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
import { createLLMProvider } from './lib/llm/index.mjs';
import { generateLLMIdeas, runPortfolioBrief, compactSweepForLLM } from './lib/llm/ideas.mjs';
import { generateLLMTheses } from './lib/llm/thesis.mjs';
import { getSetupTechnicals } from './apis/sources/alpaca.mjs';
import { OpenAIProvider } from './lib/llm/openai.mjs';
import { formatToTelegramMarkdown, escapeMd, TelegramAlerter } from './lib/alerts/telegram.mjs';
import { DiscordAlerter } from './lib/alerts/discord.mjs';
import { SnapTrade } from './lib/alerts/snaptrade.mjs';
// Single-agent proposal system (replaces the Scout/Phi/Theta/Gregor council + debate.mjs).
import { generateProposal, resolveAutoStrategy } from './lib/llm/analyst.mjs';
import { createProposal, getProposal, getPending, setStatus, attachMessageId, expireStale, hasPendingForTicker, countToday } from './lib/proposals/store.mjs';
import { calculateRemainingDayTrades, isDayTrade } from './lib/llm/council/utils/compliance.mjs';
import { DataCleaner } from './lib/llm/council/utils/cleaner.mjs';
import { resolvePositions } from './lib/llm/council/utils/positionResolver.mjs';
import { logDecisions, loadDecisions, getOpenDecisions } from './lib/llm/council/utils/decisionLogger.mjs';
import { runReviewCouncil } from './lib/llm/council/reviewCouncil.mjs';
import { startStopLossWatcher } from './lib/alerts/stopLossWatcher.mjs';
import { getSettings, updateSettings } from './lib/settings/store.mjs';
import { getStances, applyStanceUpdates, formatStancesForLLM } from './lib/stances/store.mjs';
import { generateTradeReport } from './lib/reports/tradeReport.mjs';
import { evaluatePlanProposal } from './lib/llm/planProposal.mjs';
import { generatePlanReport } from './lib/reports/planReport.mjs';
import { getDirectives, addDirective, removeDirective, clearDirectives, formatDirectivesForLLM } from './lib/directives/store.mjs';
import { buildTrackRecord } from './lib/llm/trackRecord.mjs';

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
let lastIdeasRunAt = null; // Timestamp of last successful Ideas LLM generation
let lastThesisRunAt = null; // Timestamp of last successful forward-pacing Thesis generation
let cachedTheses = [];      // Last derived theses (reused when throttled / across restarts)
let lastGoodIdeas = [];     // Last non-empty LLM idea set — reused when generation is throttled/fails
let lastStrategyResolved = null; // Concrete strategy the agent last ran under (what AUTO resolved to)

// ── Decision-cycle status (drives the RedLine "DECISION CYCLE" panel) ──────────
// stage: SIGNALS → DECIDING → (NO_ACTION | QUIET | AWAITING | EXECUTED | AUTO_EXECUTED | DENIED | EXPIRED)
let cycleStatus = { stage: 'IDLE', detail: '', ticker: null, at: null, lastSweepAt: null, nextSweepAt: null };
function setCycle(stage, detail = '', extra = {}) {
  cycleStatus = { ...cycleStatus, stage, detail, at: Date.now(), ...extra };
}

// Minimum gap between Ideas LLM calls. Market macro signals don't change every 15 min.
// At 15-min sweep intervals: 60 min = 4 sweeps skipped between runs (24 calls/day vs 96).
// Override with IDEAS_INTERVAL_MINUTES in .env.
const IDEAS_THROTTLE_MS = parseInt(process.env.IDEAS_INTERVAL_MINUTES || '60', 10) * 60 * 1000;
// Forward-pacing theses move even slower than ideas (megatrends shift over weeks). Default 60 min.
const THESIS_THROTTLE_MS = parseInt(process.env.THESIS_INTERVAL_MINUTES || '60', 10) * 60 * 1000;

// Thesis persistence — survives restarts so Scout always has the last hunting ground.
const THESES_PATH = join(RUNS_DIR, 'theses.json');
function loadThesesFromDisk() {
  try {
    if (existsSync(THESES_PATH)) {
      const j = JSON.parse(readFileSync(THESES_PATH, 'utf8'));
      if (Array.isArray(j?.theses)) { cachedTheses = j.theses; lastThesisRunAt = j.savedAt || null; }
    }
  } catch (e) { console.warn('[Thesis] Could not load cached theses:', e.message); }
}
function saveThesesToDisk(theses) {
  try { writeFileSync(THESES_PATH, JSON.stringify({ savedAt: Date.now(), theses }, null, 2)); }
  catch (e) { console.warn('[Thesis] Could not persist theses:', e.message); }
}
loadThesesFromDisk();

// Returns true if current time is within the active trading window (ET).
// Scout scans for NEW entries — no point running when the market is closed.
// Exception: always runs if there are open logged positions to monitor.
function isMarketWindow() {
  const et    = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day   = et.getDay();                           // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;            // weekends
  const h = et.getHours() + et.getMinutes() / 60;
  return h >= 9.0 && h <= 16.5;                       // 9:00 AM – 4:30 PM ET
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
// llama-3.1-8b-instant: 500K TPD free tier (vs 100K for 70B) — JSON idea generation doesn't need 70B.
// Scout uses 70B on a separate budget (GROQ_SCOUT_MODEL). Splitting models prevents ideas from
// burning Scout's entire daily token allowance before Scout runs.
const groqIdeasFallback = config.fallback?.apiKey
  ? new OpenAIProvider({
      name:    'groq',
      apiKey:  config.fallback.apiKey,
      model:   process.env.GROQ_IDEAS_MODEL || 'llama-3.3-70b-versatile', // 8b-instant was decommissioned on Groq
      baseUrl: config.fallback.baseUrl,  // Groq endpoint — NOT phi's (which was unset → hit OpenAI → 404)
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

// ── Single agent ("Claude") — reviews each sweep and proposes ONE trade for Accept/Deny. ──
// Cheaper-but-smart model (default Claude Haiku) via the existing provider factory.
// groqIdeasFallback is reused as a resilience fallback if the primary is rate-limited.
const agentProvider = createLLMProvider(config.agent);
if (agentProvider?.isConfigured) {
  console.log(`[Crucix] Analyst agent ready: ${config.agent.provider} / ${agentProvider.model}`);
  // Boot self-check — ping the agent once so a login/quota problem is obvious immediately,
  // instead of surfacing only on the first real sweep. Non-blocking.
  agentProvider.complete('Reply with only the word OK.', 'ping', { timeout: 45000, maxTokens: 16 })
    .then(r => console.log(`[Crucix] ✅ Agent self-check passed (${config.agent.provider}) — replied "${String(r.text).trim().slice(0, 20)}"`))
    .catch(e => console.warn(`[Crucix] ⚠ Agent self-check FAILED — ${e.message}\n           → proposals will use the Gemini fallback until this is resolved.`));
} else {
  console.warn('[Crucix] Analyst agent NOT configured. Proposals will use the fallback provider.');
}

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

  telegramAlerter.onCommand('/portfolio', async (_args, _msgId, chatId) => {
    if (sweepInProgress) return '🔄 Sweep already in progress. Please wait.';
    const res = await runPortfolio().catch(err => { console.error('[Crucix] /portfolio failed:', err.message); return null; });
    // Fallback so the channel always gets a reply (runPortfolio returns null before the first sweep).
    return formatToTelegramMarkdown(res) || '📊 No portfolio briefing yet — try again after the first sweep completes. (Tip: /info for a live snapshot.)';
  });

  // /info — portfolio snapshot: holdings, per-position P&L, total P&L, value, buying power.
  telegramAlerter.onCommand('/info', async () => {
    try {
      const [portfolio, buyingPower, totalValue] = await Promise.all([
        snapTrade.FetchUserTrades(),
        snapTrade.FetchAccountBuyingPower().catch(() => null),
        snapTrade.FetchAccountTotalValue().catch(() => null),
      ]);
      const num = v => Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
      const positions = Array.isArray(portfolio) ? portfolio : [];
      if (!positions.length) {
        return `📊 *PORTFOLIO*\nNo open positions.${buyingPower != null ? `\nBuying Power: $${num(buyingPower).toFixed(2)}` : ''}`;
      }
      const money = n => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
      let totalPnl = 0, totalMktVal = 0;
      // Mobile-friendly: ticker + signed % on line 1; size, P&L$, value on line 2.
      const rows = positions.map(p => {
        const units = num(p.units), price = num(p.price), avg = num(p.avg_cost);
        const mktVal = price * units, pnl = (price - avg) * units;
        totalPnl += pnl; totalMktVal += mktVal;
        const pct = avg > 0 ? ((price - avg) / avg) * 100 : 0;
        const em = pnl >= 0 ? '🟢' : '🔴';
        const qty = units < 1 ? units.toFixed(4) : String(units);
        return `${em} *${p.symbol}*  ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%\n` +
               `   ${qty} @ $${price.toFixed(2)} · ${pnl >= 0 ? '+' : ''}${money(pnl)} · $${mktVal.toFixed(2)}`;
      });
      const totEm = totalPnl >= 0 ? '🟢' : '🔴';
      return [
        `📊 *PORTFOLIO* · ${positions.length} pos`,
        ...rows,
        `━━━━━━━━━━`,
        `${totEm} *Total P&L  ${totalPnl >= 0 ? '+' : ''}${money(totalPnl)}*`,
        `Holdings  $${totalMktVal.toFixed(2)}`,
        totalValue != null ? `Account  $${num(totalValue).toFixed(2)}` : '',
        buyingPower != null ? `Buying Pwr  $${num(buyingPower).toFixed(2)}` : '',
      ].filter(Boolean).join('\n');
    } catch (err) {
      console.error('[Telegram] /info failed:', err.message);
      return '⚠️ Could not fetch portfolio info.';
    }
  });

  // /plan — show the agent's current living plan (stance book + standing directives).
  telegramAlerter.onCommand('/plan', async () => {
    const list = getStances();
    const dirs = getDirectives();
    const dirBlock = dirs.length
      ? `🧭 *Directives*\n` + dirs.map(d => `• ${escapeMd(d.text)}`).join('\n') + '\n\n'
      : '';
    if (!list.length) return dirBlock + '📋 *Living Plan* — empty. The agent writes it on the next sweep.';
    const lines = list.map(s => {
      const c = s.confidence != null ? ` ${s.confidence}%` : '';
      // Escape LLM free-text so stray * _ [ ` don't break Telegram Markdown parsing.
      const detail = [s.thesis, s.plan ? `entry: ${s.plan}` : '', s.exit ? `sell: ${s.exit}` : '']
        .filter(Boolean).map(escapeMd).join(' · ');
      return `${s.held ? '★' : '•'} *${escapeMd(s.ticker)}*  ${escapeMd(s.stance)}${c}` + (detail ? `\n   ${detail}` : '');
    });
    return dirBlock + `📋 *Living Plan* · ${list.length}\n` + lines.join('\n');
  });

  // /propose <idea> — user proposes an edit to the living plan; agent accepts/denies/partials.
  // (A leading "plan" is tolerated for back-compat: "/propose plan buy more NVDA".)
  telegramAlerter.onCommand('/propose', async (args, _msgId, chatId) => {
    let q = String(args || '').trim();
    if (/^plan\b/i.test(q)) q = q.replace(/^plan\b[:,\s]*/i, '').trim();
    if (!q) return 'Usage: `/propose <your idea>` — e.g. `/propose start watching URA for a uranium squeeze`';
    // Interim "evaluating" message goes to the SAME channel the command came from.
    await telegramAlerter.sendMessage('🤔 Evaluating your plan proposal…', { chatId });
    const r = await handlePlanProposal(q);
    if (!r.ok) return `⚠️ ${r.error}`;
    const emoji = r.verdict === 'ACCEPT' ? '✅' : r.verdict === 'PARTIAL' ? '〜' : '⛔';
    const bits = [];
    if (r.applied) bits.push(`${r.applied} stance change(s)`);
    if (r.directiveAdded) bits.push('new directive');
    const changes = bits.length ? `\n_Applied ${bits.join(' + ')} — live next sweep._` : '';
    return `${emoji} *${r.verdict}*${r.summary ? ` — ${escapeMd(r.summary)}` : ''}\n${escapeMd(r.reasoning)}${changes}`;
  });

  // Inline Accept/Deny buttons on proposal cards route here.
  telegramAlerter.onCallback(async (action, id, ctx) => {
    if (action === 'accept') return await acceptProposal(id, ctx);
    if (action === 'deny')   return await denyProposal(id, ctx);
  });

  // Start polling for bot commands + callback buttons
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
// RedLine page settings — Auto Trade toggle + allowed investment horizons.
app.get('/api/settings', (req, res) => {
  try { res.json(getSettings()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings', express.json(), (req, res) => {
  try {
    const next = updateSettings(req.body || {});
    console.log(`[Settings] Updated — autoTrade=${next.autoTrade} | types=${next.investmentTypes.join(',')}`);
    res.json(next);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Decision-cycle status for the RedLine "DECISION CYCLE" panel.
app.get('/api/cycle', (req, res) => {
  try {
    const s = getSettings();
    res.json({
      ...cycleStatus,
      sourcesOk:      currentData?.meta?.sourcesOk ?? null,
      sourcesTotal:   currentData?.meta?.sourcesQueried ?? null,
      proposalsToday: countToday('NEW_BUY'),
      dailyCap:       config.maxProposalsPerDay || 0,
      autoTrade:      s.autoTrade,
      investmentTypes: s.investmentTypes,
      strategyMode:   s.strategyMode,
      strategyEffective: lastStrategyResolved,   // what AUTO last resolved to (null until first run)
      refreshMinutes: config.refreshIntervalMinutes,
      marketOpen:     isMarketWindow(),
      serverTime:     Date.now(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The agent's living plan per stock — its cross-sweep memory (WATCH/ACCUMULATE/HOLD/…).
app.get('/api/stances', (req, res) => {
  try { res.json(getStances()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// User proposes an edit to the living plan → agent accepts/denies/partially accepts.
app.post('/api/propose-plan', express.json(), async (req, res) => {
  try {
    const result = await handlePlanProposal(req.body?.query);
    res.status(result.ok ? 200 : 400).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Standing user directives (general instructions the agent follows each sweep).
app.get('/api/directives', (req, res) => {
  try { res.json(getDirectives()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/directives/:id', (req, res) => {
  try { res.json(removeDirective(req.params.id)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/directives', (req, res) => {
  try { res.json(clearDirectives()); } catch (e) { res.status(500).json({ error: e.message }); }
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
  setCycle('SIGNALS', 'Gathering intelligence…', { lastSweepAt: Date.now(), ticker: null });
  broadcast({ type: 'sweep_start', timestamp: sweepStartedAt });
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[Crucix] Starting sweep at ${new Date().toLocaleTimeString()}`);
  console.log(`${'='.repeat(60)}`);

  try {
    // Prelim: Refresh User Trades
    // 1. Run the full briefing sweep
    // RefreshHoldings dropped — SnapTrade deprecated that endpoint (was returning 403). Holdings are
    // read fresh via FetchUserTrades each sweep anyway; no manual brokerage refresh needed.
    const rawData = await fullBriefing()
    // 2. Save to runs/latest.json
    writeFileSync(join(RUNS_DIR, 'latest.json'), JSON.stringify(rawData, null, 2));
    lastSweepTime = new Date().toISOString();

    // 3. Synthesize into dashboard format
    console.log('[Crucix] Synthesizing dashboard data...');
    const [synthesized, userPortfolio, accountOrders ]= await Promise.all([synthesize(rawData), snapTrade.FetchUserTrades(), snapTrade.getBuyDates()]);

    // 4. Delta computation + memory
    const delta = memory.addRun(synthesized);
    synthesized.delta = delta;
    // 5. LLM-powered trade ideas — throttled + delta-gated to reduce Gemini quota burn.
    //
    // THROTTLE: minimum IDEAS_THROTTLE_MS between LLM calls (default 60 min = 24 calls/day vs 96).
    //   Market macro signals don't change materially every 15 minutes.
    //
    // DELTA GATE: if nothing significant changed since last sweep, reuse the previous ideas set.
    //   Skips the LLM call entirely — Scout still gets the cached context for debate.
    //
    // Both gates must clear for a new call to fire.
    if (llmProvider?.isConfigured) {
      const ideasElapsed   = lastIdeasRunAt ? Date.now() - lastIdeasRunAt : Infinity;
      const ideasThrottled = ideasElapsed < IDEAS_THROTTLE_MS;
      const criticalChg    = delta?.summary?.criticalChanges ?? 0;
      const totalChg       = delta?.summary?.totalChanges    ?? 0;
      const newSignals     = delta?.signals?.new?.length     ?? 0;
      const ideasDeltaQuiet = criticalChg === 0 && totalChg < 3 && newSignals === 0;

      // NOTE: memory.getLastRun() is unreliable here — addRun() already unshifted THIS sweep onto
      // the stack (and compacts before ideas are set), so it returns the current empty run. We keep
      // the last successful idea set in a persistent module var (lastGoodIdeas) instead, so every
      // reuse path (throttled, quiet, failed) shows real ideas rather than a blank panel.
      if (ideasThrottled || ideasDeltaQuiet) {
        // Reuse last good ideas — preserve context for the dashboard/agent (no LLM call).
        synthesized.ideas = lastGoodIdeas;
        synthesized.ideasSource = lastGoodIdeas.length ? 'cached' : 'none';
        // Rebuild context from fresh sweep data so the agent still sees current news.
        currentContext = compactSweepForLLM(synthesized, delta, synthesized.ideas);
        const why = ideasThrottled
          ? `throttled — ${Math.round((IDEAS_THROTTLE_MS - ideasElapsed) / 60000)}m until next run`
          : `delta quiet (${totalChg} changes, ${criticalChg} critical)`;
        console.log(`[Crucix] Ideas ${why}. Reusing ${synthesized.ideas.length} cached ideas. Context rebuilt fresh.`);
      } else {
        try {
          console.log(`[Crucix] Generating LLM trade ideas (${Number.isFinite(ideasElapsed) ? Math.round(ideasElapsed / 60000) + 'm' : 'first run'} since last run, delta: ${totalChg} changes, ${criticalChg} critical)...`);
          const ideasResult = await generateLLMIdeas(llmProvider, synthesized, delta, lastGoodIdeas, userPortfolio, accountOrders, groqIdeasFallback);
          if (ideasResult?.llmIdeas?.length > 0) {
            const { llmIdeas, context } = ideasResult;
            currentContext  = context;
            lastIdeasRunAt  = Date.now();
            synthesized.ideas = llmIdeas;
            synthesized.ideasSource = 'llm';
            lastGoodIdeas = llmIdeas;   // remember for future reuse
            console.log(`[Crucix] LLM generated ${llmIdeas.length} ideas`);
          } else {
            // Generation failed/empty — keep the last good ideas so the dashboard never goes blank.
            synthesized.ideas = lastGoodIdeas;
            synthesized.ideasSource = lastGoodIdeas.length ? 'cached-fallback' : 'llm-failed';
            if (ideasResult?.context) currentContext = ideasResult.context;
            console.warn(`[Crucix] LLM ideas empty/failed — reusing ${lastGoodIdeas.length} prior idea(s).`);
          }
        } catch (llmErr) {
          console.error('[Crucix] LLM ideas failed (non-fatal):', llmErr.message);
          synthesized.ideas = lastGoodIdeas;
          synthesized.ideasSource = lastGoodIdeas.length ? 'cached-fallback' : 'llm-failed';
        }
      }
    } else {
      synthesized.ideas = [];
      synthesized.ideasSource = 'disabled';
    }

    // 5b. Forward-pacing THESES — auto-derived megatrend → unpriced-rung map (throttled like ideas).
    // The thesis is the hunting ground; Scout's setup scan (getSetupTechnicals) pulls the trigger.
    if (llmProvider?.isConfigured) {
      const thesisElapsed   = lastThesisRunAt ? Date.now() - lastThesisRunAt : Infinity;
      const thesisThrottled = thesisElapsed < THESIS_THROTTLE_MS;
      const criticalChg     = delta?.summary?.criticalChanges ?? 0;
      const totalChg        = delta?.summary?.totalChanges    ?? 0;
      const thesisDeltaQuiet = criticalChg === 0 && totalChg < 3;
      if (thesisThrottled || thesisDeltaQuiet) {
        synthesized.theses = cachedTheses;
        if (cachedTheses.length) console.log(`[Thesis] Reusing ${cachedTheses.length} cached theses (${thesisThrottled ? 'throttled' : 'delta quiet'}).`);
      } else {
        try {
          const newTheses = await generateLLMTheses(llmProvider, synthesized, delta, cachedTheses, groqIdeasFallback);
          if (newTheses?.length) {
            cachedTheses    = newTheses;
            lastThesisRunAt = Date.now();
            saveThesesToDisk(newTheses);
          }
          synthesized.theses = cachedTheses; // fall back to prior on a null result
        } catch (thErr) {
          console.error('[Thesis] Generation failed (non-fatal):', thErr.message);
          synthesized.theses = cachedTheses;
        }
      }
    } else {
      synthesized.theses = [];
    }

    // 5c. SPY reference for relative-strength in the setup scan — fetched ONCE per sweep,
    // passed to Scout via currentData so per-ticker setup calls don't each re-fetch SPY.
    try {
      const spySetup = await getSetupTechnicals('SPY');
      synthesized.spyRef = spySetup ? { ret1m: spySetup.ret1m, ret3m: spySetup.ret3m } : null;
    } catch { synthesized.spyRef = null; }

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
    if (redLineEnabled && currentContext) {
      const openPositionCount = getOpenDecisions().length;
      const criticalChanges   = delta?.summary?.criticalChanges ?? 0;
      const totalChanges      = delta?.summary?.totalChanges     ?? 0;
      const newSignals        = delta?.signals?.new?.length       ?? 0;

      // Delta gate: skip when no open positions AND nothing significant changed.
      const isQuietDelta = openPositionCount === 0 && criticalChanges === 0 && totalChanges < 3 && newSignals === 0;

      // Market-hours gate: we don't trade after hours, so there's no point spending an LLM call on a
      // proposal that couldn't be acted on. Hard stop-losses still run on their own watcher.
      const inWindow = isMarketWindow();

      if (!inWindow) {
        console.log(`[PROPOSAL] 🌙 Market closed — no LLM call (we don't trade after hours). Stop-losses still active. Next window: 9:00 AM ET.`);
        setCycle('QUIET', 'Market closed — standing by (no after-hours trading)');
      } else if (isQuietDelta) {
        console.log(`[PROPOSAL] 🔇 Delta gate — no open positions, no critical changes (${totalChanges} total). Agent skipped.`);
        setCycle('QUIET', `Quiet — ${totalChanges} changes, nothing actionable`);
      } else {
        if (openPositionCount > 0) {
          console.log(`[PROPOSAL] Agent running — ${openPositionCount} open position(s) to monitor.`);
        }
        await runProposalCycle(currentContext);
      }
    }
    cycleStatus.nextSweepAt = Date.now() + config.refreshIntervalMinutes * 60000;
    console.log(`[Crucix] Next sweep at ${new Date(cycleStatus.nextSweepAt).toLocaleTimeString()}`);


  } catch (err) {
    console.error('[Crucix] Sweep failed:', err.message);
    broadcast({ type: 'sweep_error', error: err.message });
  } finally {
    sweepInProgress = false;
  }
}

async function runPortfolio() {
  // Uses currentData from the last sweep — no redundant fullBriefing() re-run.
  // This saves ~25 API source calls and the synthesize+delta pipeline on every /portfolio invocation.
  console.log('[Crucix] Generating Portfolio Report (using cached sweep data)...');
  telegramAlerter.sendMessage('Generating Portfolio Report ...');

  if (!currentData) {
    const msg = '⏳ No sweep data yet — please wait for the first sweep to complete.';
    telegramAlerter.sendMessage(msg);
    return null;
  }

  const delta        = memory.getLastDelta ? memory.getLastDelta() : null;
  const previousIdeas = memory.getLastRun?.()?.ideas || [];

  try {
    const [accountOrders, portfolio] = await Promise.all([
      snapTrade.getBuyDates(),
      snapTrade.FetchUserTrades(),
    ]);
    const result = await runPortfolioBrief(
      llmProvider, currentData, delta, previousIdeas,
      portfolio, accountOrders  // pass the array; runPortfolioBrief cleans it via stringifyPortfolio
    );
    console.log('[Crucix] Portfolio Report created at', new Date().toISOString());
    return result?.text ?? null;
  } catch (err) {
    console.error('[Crucix] Portfolio report failed:', err.message);
    return null;
  }
}

// ── Price-safety guard (migrated from the retired debate.mjs) ──────────────────
// Blocks orders whose price is implausibly far from the live quote (hallucination guard).
function _isPriceSafe(orderPrice, livePrice, action = null, orderType = null, maxDriftPct = 0.15) {
  if (!orderPrice || !livePrice) return true;
  const drift = Math.abs(livePrice - orderPrice) / livePrice;
  if (orderType === 'Limit') {
    if (action === 'BUY'  && orderPrice <= livePrice) return true;  // below market ✓
    if (action === 'SELL' && orderPrice >= livePrice) return true;  // above market ✓
    return drift <= maxDriftPct;
  }
  return drift <= 0.02; // market/unknown: must be near live
}

function formatProposalCard(p) {
  // timeZoneName:'short' auto-renders CST in winter / CDT during daylight saving.
  const expCt = new Date(p.expiresAt).toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  });
  const priceStr = p.price ? `$${p.price}` : (p.order_type === 'Market' ? 'market' : 'TBD');
  const qty = p.units ? ` × ${p.units}` : (p.notional_value ? ` ($${p.notional_value})` : '');
  const conf = Number.isFinite(Number(p.confidence)) ? `${Math.round(Number(p.confidence))}%` : String(p.confidence);
  const modelLine = p.model ? `🤖 Model: ${p.provider ? `${p.provider}/` : ''}${p.model}` : '';
  const sourcesLine = Array.isArray(p.sources) && p.sources.length
    ? `📎 Based on: ${p.sources.join(' · ')}` : '';
  return [
    `${p.action === 'MAINTENANCE' ? '🛠' : '📈'} *${p.title}*`,
    ``,
    p.desc,
    ``,
    `*${p.side} ${p.ticker}* — ${p.order_type} @ ${priceStr}${qty} · ${p.time_in_force}`,
    p.stopLoss ? `🛑 Hard stop: $${p.stopLoss} (auto-sells, no approval, if breached)` : '',
    p.bearCase ? `🐻 Bear case: ${p.bearCase}` : '',
    `🎯 Confidence: ${conf}${p.horizon ? ` · ${p.horizon}` : ''}`,
    sourcesLine,
    `⌛ Expires: ${expCt}`,
    modelLine,
  ].filter(Boolean).join('\n');
}

// ── Proposal cycle — the single-agent replacement for the council. ─────────────
// Runs each sweep (behind the same delta/market gates that fronted the old council):
//   expire stale cards → gather state → ask the agent for ONE proposal → send Accept/Deny card.
async function runProposalCycle(context) {
  // 1. Expire stale proposals — their Telegram cards disappear.
  try {
    const expired = expireStale();
    for (const e of expired) {
      if (e.telegramMessageId) await telegramAlerter.deleteMessage(e.telegramMessageId, telegramAlerter.proposalsChatId);
      console.log(`[PROPOSAL] ⌛ Expired & removed: ${e.ticker} (${e.action})`);
    }
  } catch (err) { console.error('[PROPOSAL] expireStale failed:', err.message); }

  if (!agentProvider?.isConfigured) return;

  // 2. Gather account state (same primitives the council used).
  const [buyingPower, openAccountOrders, orderCompliance, orders24h, portfolio] = await Promise.all([
    snapTrade.FetchAccountBuyingPower(),
    snapTrade.FetchOpenAccountOrders(),
    snapTrade.FetchOrderCompliance(),
    snapTrade.FetchAccountOrders24h(true),
    snapTrade.FetchUserTrades(),
  ]);
  const remaining = calculateRemainingDayTrades(orderCompliance);
  console.log(`[PROPOSAL] 📊 DAY TRADES REMAINING: ${remaining}/3 | Open logged positions: ${getOpenDecisions().length}`);
  const priorPending = getPending();

  // RedLine-page settings: Auto Trade toggle + allowed investment horizons.
  const settings = getSettings();

  // Daily new-buy budget — quality over quantity. Maintenance/exits are exempt.
  const dailyCap    = config.maxProposalsPerDay || 0;              // 0 = disabled
  const buysToday   = countToday('NEW_BUY');
  const buysLeft    = dailyCap > 0 ? Math.max(0, dailyCap - buysToday) : Infinity;
  if (dailyCap > 0 && buysLeft === 0) {
    // No new-buy budget left today, but still let the agent surface urgent MAINTENANCE.
    console.log(`[PROPOSAL] Daily new-buy cap reached (${buysToday}/${dailyCap}) — new entries paused, maintenance still active.`);
  }

  // Min buying-power floor (user setting). Parse BP robustly (SnapTrade may return a string).
  const minBP = Number(settings.minBuyingPower) || 0;
  const bpNum = Number(String(buyingPower ?? '').replace(/[^0-9.\-]/g, ''));
  const bpBelowFloor = minBP > 0 && Number.isFinite(bpNum) && bpNum < minBP;
  if (bpBelowFloor) {
    console.log(`[PROPOSAL] Buying power $${bpNum} below your $${minBP} floor — agent restricted to MAINTENANCE only.`);
  }

  // 3. Single agent → at most one proposal, constrained to the allowed horizons + daily budget.
  // Fallback = the same Gemini provider the ideas pass uses (proven working) so a transient
  // Claude Code failure (e.g. a usage-limit window) still yields a proposal.
  setCycle('DECIDING', 'Claude reviewing the sweep…');
  const analystFallback = (llmProvider?.isConfigured ? llmProvider : null) || groqIdeasFallback;
  const heldTickers = (Array.isArray(portfolio) ? portfolio : []).map(p => p?.symbol).filter(Boolean);

  // Strategy mode — AUTO resolves to a concrete mode from live conditions (VIX, regime, dislocation).
  const strategyAuto = settings.strategyMode === 'AUTO';
  let effectiveStrategy = settings.strategyMode;
  if (strategyAuto) {
    const vix = Number(currentData?.fred?.find(f => f.id === 'VIXCLS')?.value
      ?? currentData?.yfinance?.quotes?.find?.(q => q.symbol === '^VIX')?.price) || null;
    const direction = currentData?.delta?.summary?.direction || null;
    const moverCount = (currentData?.movers?.losers?.length || 0) + (currentData?.movers?.gainers?.length || 0);
    effectiveStrategy = resolveAutoStrategy({ vix, direction, moverCount });
    console.log(`[PROPOSAL] 🎚 Strategy AUTO → ${effectiveStrategy} (VIX ${vix ?? '?'}, ${direction || 'n/a'}, ${moverCount} movers).`);
  }
  lastStrategyResolved = effectiveStrategy;

  const proposal = await generateProposal(
    agentProvider, currentData, portfolio, openAccountOrders,
    buyingPower, remaining, priorPending, analystFallback, settings.investmentTypes,
    { buysLeft, buysToday, dailyCap, minBuyingPower: minBP, bpBelowFloor, strategyMode: effectiveStrategy, strategyAuto },
    formatStancesForLLM(), buildTrackRecord(), formatDirectivesForLLM()
  );

  // Persist the agent's living plan (stance book) EVERY cycle — even on NO_ACTION, the revised
  // stances are its memory for next sweep. heldTickers keep owned positions pinned + uncapped.
  if (proposal?.stanceUpdates?.length || heldTickers.length) {
    try {
      const book = applyStanceUpdates(proposal?.stanceUpdates || [], heldTickers);
      if (proposal?.stanceUpdates?.length) console.log(`[STANCE] Updated ${proposal.stanceUpdates.length} stance(s); book now tracks ${book.length}.`);
    } catch (err) { console.error('[STANCE] applyStanceUpdates failed:', err.message); }
  }

  if (!proposal || proposal.action === 'NO_ACTION') {
    console.log(`[PROPOSAL] No proposal this cycle${proposal?.desc ? ` — ${proposal.desc}` : ''}.`);
    setCycle('NO_ACTION', (proposal?.desc || 'No trade worth proposing this cycle').slice(0, 140));
    return;
  }

  // 4a. Enforce the investment-type filter (a NEW_BUY outside the allowed horizons is dropped;
  //     MAINTENANCE/exits are always allowed — you must be able to manage what you already hold).
  if (proposal.action === 'NEW_BUY' && proposal.horizon && !settings.investmentTypes.includes(proposal.horizon)) {
    console.log(`[PROPOSAL] Skipped — ${proposal.ticker} (${proposal.horizon}) not in allowed types [${settings.investmentTypes.join(',')}].`);
    return;
  }

  // 4a2. Hard daily cap — a NEW_BUY beyond the day's budget is dropped (exits/maintenance exempt).
  if (proposal.action === 'NEW_BUY' && dailyCap > 0 && buysToday >= dailyCap) {
    console.log(`[PROPOSAL] Dropped — ${proposal.ticker}: daily new-buy cap ${buysToday}/${dailyCap} already reached.`);
    return;
  }

  // 4a3. Minimum buying-power floor (backstop) — below it, the agent may still manage positions
  //      (MAINTENANCE) but new entries are blocked. bpNum/bpBelowFloor computed above.
  if (proposal.action === 'NEW_BUY' && bpBelowFloor) {
    console.log(`[PROPOSAL] Dropped — ${proposal.ticker}: buying power $${bpNum} below minimum $${minBP}.`);
    setCycle('NO_ACTION', `Buying power $${bpNum} below your $${minBP} floor — new buys paused`);
    return;
  }

  // 4b. Don't repeat a ticker already pending.
  if (hasPendingForTicker(proposal.ticker)) {
    console.log(`[PROPOSAL] Skipped — ${proposal.ticker} already has a pending proposal.`);
    return;
  }

  const rec = createProposal(proposal);

  // 5a. AUTO-TRADE ON → execute immediately, no Accept/Deny (hard stop-losses still apply).
  if (settings.autoTrade) {
    console.log(`[PROPOSAL] 🤖 Auto-Trade ON — executing ${rec.action} ${rec.ticker} without approval.`);
    await telegramAlerter.sendMessage(
      `🤖 *AUTO-TRADE (no approval)*\n${formatProposalCard(rec)}`,
      { chatId: telegramAlerter.proposalsChatId }
    );
    setCycle('AUTO_EXECUTED', `${rec.action} ${rec.ticker} — auto-traded (no approval)`, { ticker: rec.ticker });
    await acceptProposal(rec.id, { chatId: telegramAlerter.proposalsChatId, auto: true });
    return;
  }

  // 5b. AUTO-TRADE OFF → deliver the Accept/Deny card to the dedicated proposals channel.
  const replyMarkup = { inline_keyboard: [[
    { text: '✅ Accept', callback_data: `accept:${rec.id}` },
    { text: '❌ Deny',   callback_data: `deny:${rec.id}` },
  ]] };
  const sent = await telegramAlerter.sendMessage(formatProposalCard(rec), {
    chatId: telegramAlerter.proposalsChatId, replyMarkup,
  });
  if (sent?.messageId) attachMessageId(rec.id, sent.messageId);
  setCycle('AWAITING', `${rec.action} ${rec.ticker} — awaiting your Accept/Deny`, { ticker: rec.ticker });
  console.log(`[PROPOSAL] 📬 Sent ${rec.action} ${rec.ticker} (expires ${rec.expiresAt}) — awaiting Accept/Deny.`);
}

// ── Accept handler — the ONLY path that places a live order. ───────────────────
async function acceptProposal(id, ctx) {
  const p = getProposal(id);
  if (!p) return 'Not found';
  if (p.status !== 'PENDING') return `Already ${p.status.toLowerCase()}`;
  if (new Date(p.expiresAt).getTime() <= Date.now()) {
    setStatus(id, 'EXPIRED');
    if (p.telegramMessageId) await telegramAlerter.deleteMessage(p.telegramMessageId, ctx?.chatId);
    return 'Expired';
  }

  // Fresh compliance + live price for the mechanical guards.
  let remaining = 1, stringifiedOrders24h = '[]', livePrice = null;
  try {
    const [comp, o24, quote] = await Promise.all([
      snapTrade.FetchOrderCompliance(),
      snapTrade.FetchAccountOrders24h(true),
      getLiveQuote(p.ticker).catch(() => null),
    ]);
    remaining = calculateRemainingDayTrades(comp);
    stringifiedOrders24h = DataCleaner.stringifyOrders(o24);
    livePrice = quote?.price ?? null;
  } catch (e) { console.warn('[PROPOSAL] compliance/quote fetch failed:', e.message); }

  const trade = {
    symbol:         p.ticker,
    action:         p.side,
    order_type:     p.order_type || 'Limit',
    price:          p.price ?? undefined,
    units:          p.units ?? undefined,
    notional_value: p.notional_value ?? undefined,
    time_in_force:  p.time_in_force || 'Day',
    stopLossPrice:  p.stopLoss ?? null, // persisted by logDecisions → enforced by the hard stop-loss watcher
  };

  // Migrated mechanical guards (from the retired debate.mjs):
  if (trade.units != null && !Number.isInteger(trade.units)) trade.time_in_force = 'Day'; // fractional → Day
  if (livePrice && !_isPriceSafe(trade.price, livePrice, trade.action, trade.order_type)) {
    setStatus(id, 'FAILED', { error: 'price-safety' });
    await telegramAlerter.editMessageText(p.telegramMessageId,
      `⚠️ *${p.title}* — BLOCKED\nProposed price $${trade.price} is too far from live $${livePrice}. Not placed.`,
      { chatId: ctx?.chatId });
    return 'Blocked: price';
  }
  if (isDayTrade(trade, remaining, stringifiedOrders24h)) {
    setStatus(id, 'FAILED', { error: 'pdt' });
    await telegramAlerter.editMessageText(p.telegramMessageId,
      `⛔ *${p.title}* — BLOCKED\nPDT limit — would be a day trade with 0 remaining. Not placed.`,
      { chatId: ctx?.chatId });
    return 'Blocked: PDT';
  }

  setStatus(id, 'ACCEPTED');
  console.log(`[PROPOSAL] ✅ Accepted — placing ${trade.action} ${trade.symbol}`);
  const orderRes = await snapTrade.PlaceOrder(trade);
  if (!orderRes) {
    setStatus(id, 'FAILED', { error: 'order-rejected' });
    await telegramAlerter.editMessageText(p.telegramMessageId,
      `❌ *${p.title}* — ORDER FAILED\nSnapTrade rejected ${trade.action} ${trade.symbol}.`,
      { chatId: ctx?.chatId });
    return 'Order failed';
  }

  const orderId = orderRes?.brokerage_order_id || orderRes?.id || null;
  setStatus(id, 'EXECUTED', { orderId });
  try {
    const liveVix = currentData?.fred?.find(f => f.id === 'VIXCLS')?.value
      ?? currentData?.yfinance?.quotes?.find?.(q => q.symbol === '^VIX')?.price ?? 'N/A';
    logDecisions([trade], p.desc || p.title, liveVix, remaining, { horizon: p.horizon || 'SWING', trigger: p.action, signalScore: null });
  } catch (err) { console.error('[DecisionLogger] Failed to log accepted trade:', err.message); }

  // Per-trade report for the dashboard report viewer (restored for the single-agent model).
  try { generateTradeReport(p, { auto: !!ctx?.auto, orderId }); }
  catch (err) { console.error('[TradeReport] generation failed:', err.message); }

  setCycle(ctx?.auto ? 'AUTO_EXECUTED' : 'EXECUTED', `${trade.action} ${trade.symbol} placed`, { ticker: trade.symbol });
  // News-channel alert only for AUTO-trades — a manual Accept already edits its own card to ✅,
  // so a second broadcast to the news channel would be redundant noise.
  if (ctx?.auto) telegramAlerter.sendTradeAlert?.(trade);
  await telegramAlerter.editMessageText(p.telegramMessageId,
    `✅ *${p.title}* — EXECUTED\n${trade.action} ${trade.symbol} @ ${trade.price ? `$${trade.price}` : trade.order_type} placed.`,
    { chatId: ctx?.chatId });
  return 'Executed ✅';
}

// ── Deny handler ──────────────────────────────────────────────────────────────
async function denyProposal(id, ctx) {
  const p = getProposal(id);
  if (!p) return 'Not found';
  if (p.status !== 'PENDING') return `Already ${p.status.toLowerCase()}`;
  setStatus(id, 'DENIED');
  setCycle('DENIED', `${p.ticker} — you denied it`, { ticker: p.ticker });
  await telegramAlerter.editMessageText(p.telegramMessageId,
    `❌ *${p.title}* — DENIED\nNo order placed.`, { chatId: ctx?.chatId });
  console.log(`[PROPOSAL] ❌ Denied — ${p.ticker}`);
  return 'Denied';
}

// ── User plan proposal — evaluate a user's proposed edit to the living plan. ────
// Shared by the dashboard modal (/api/propose-plan) and the Telegram /propose command.
// On ACCEPT/PARTIAL, the stance updates are applied to the book (held flags preserved) and
// take effect on the next sweep. Always writes a report to the dashboard report viewer.
async function handlePlanProposal(query) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'Empty proposal.' };
  if (!agentProvider?.isConfigured && !llmProvider?.isConfigured) return { ok: false, error: 'No LLM provider configured.' };

  const fallback = (llmProvider?.isConfigured ? llmProvider : null) || groqIdeasFallback;
  const result = await evaluatePlanProposal(agentProvider, q, formatStancesForLLM(), fallback);
  if (!result) return { ok: false, error: 'Could not evaluate the proposal (LLM unavailable).' };

  let applied = 0, directiveAdded = false;
  if (result.verdict !== 'DENY') {
    if (result.stanceUpdates?.length) {
      try {
        // Preserve current held flags (a plan edit never changes holdings).
        const held = getStances().filter(s => s.held).map(s => s.ticker);
        applyStanceUpdates(result.stanceUpdates, held);
        applied = result.stanceUpdates.length;
      } catch (err) { console.error('[PlanProposal] applyStanceUpdates failed:', err.message); }
    }
    if (result.directive) {
      try { addDirective(result.directive); directiveAdded = true; }
      catch (err) { console.error('[PlanProposal] addDirective failed:', err.message); }
    }
  }

  let reportFile = null;
  try { reportFile = generatePlanReport({ query: q, ...result }); }
  catch (err) { console.error('[PlanProposal] report failed:', err.message); }

  console.log(`[PlanProposal] ${result.verdict} — "${q.slice(0, 60)}" → ${applied} stance change(s)${directiveAdded ? ' + directive' : ''}.`);
  return { ok: true, ...result, applied, directiveAdded, reportFile };
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

    // ── HARD stop-loss watcher — the deliberate exception to the approval model. ──
    // Runs on a fast independent timer and force-sells (market, no Accept/Deny) any open
    // position that breaches its stop. A stop-loss that needs approval is not a stop-loss.
    // Discretionary exits still go through MAINTENANCE proposals; only stops bypass approval.
    startStopLossWatcher(snapTrade, telegramAlerter);
  });
}

/**
 * Schedules the Review Mode to fire at 4:30 PM ET daily.
 * On startup, checks if today's review has already run; if not, fires immediately.
 * Uses a simple polling interval (every minute) to avoid timezone complexity.
 */
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
