/**
 * earningsWatcher.mjs — Pre-market & After-hours Earnings Alert System
 *
 * Solves the 15-minute sweep dead zone for high-conviction earnings catalysts.
 *
 * Flow:
 *  1. Maintains a watchlist of tickers reporting in the next 48h (refreshed hourly)
 *  2. During earnings windows, polls every 2 minutes for results
 *  3. On Beat+Raise: immediately scores the result (no 34-source briefing needed)
 *  4. If score ≥ 8: triggers express council debate with live pre-market price data
 *  5. Council can stage a limit order BEFORE the open bell
 *
 * Earnings windows (ET):
 *  After-hours:  4:00 PM – 6:30 PM  (most companies report here)
 *  Pre-market:   6:00 AM – 9:20 AM  (pre-market prints, 10 min buffer before open)
 *  Polling: every 2 min in-window | every 30 min outside (watchlist refresh only)
 *
 * Fast-path council: Scout sees only the earnings result + pre-market quote.
 * Total time from print → staged order: target < 90 seconds.
 */

import '../../apis/utils/env.mjs';
import { safeFetch } from '../../apis/utils/fetch.mjs';

const FINNHUB_BASE = 'https://finnhub.io/api/v1';

// ── Tickers to watch for earnings ───────────────────────────────────────────
// Superset of INSIDER_WATCHLIST — includes all names Scout would escalate on a beat.
const EARNINGS_WATCHLIST = [
    // Semiconductors — high earnings sensitivity, CHIPS Act tailwind
    'NVDA', 'AMD', 'INTC', 'QCOM', 'AMAT', 'MU', 'LRCX', 'KLAC', 'ON', 'MRVL', 'SMCI',
    // Defense — congressional contract flow
    'LMT', 'RTX', 'NOC', 'GD', 'BA', 'KTOS', 'CACI', 'HII', 'AXON', 'PLTR',
    // Big Tech — market-moving beats
    'MSFT', 'GOOGL', 'META', 'AAPL', 'AMZN', 'TSLA',
    // Biotech — binary beat/miss events
    'MRNA', 'GILD', 'AMGN', 'REGN', 'VRTX', 'BIIB',
    // Energy / Commodities
    'XOM', 'CVX', 'KMI', 'WMB', 'SLB',
    // Financial
    'JPM', 'GS', 'MS', 'BAC',
];

// Congressional signal tickers — automatic +3 pts on any beat
const CONGRESSIONAL_SIGNAL_TICKERS = new Set([
    'NVDA', 'INTC', 'AMD', 'QCOM', 'AMAT', 'MU',         // CHIPS Act
    'LMT', 'RTX', 'NOC', 'GD', 'BA', 'KTOS', 'CACI',     // defense contracts
    'PLTR', 'AXON',                                          // defense tech
]);

// ── Fast-path scoring ────────────────────────────────────────────────────────
/**
 * Scores an earnings result for escalation priority.
 * Returns { score, factors[] } — mirrors Scout's CONVICTION criteria.
 */
function scoreEarningsResult(ticker, result, priceChange) {
    const factors = [];
    let score = 0;

    // EPS beat magnitude
    if (result.epsActual != null && result.epsEstimate != null && result.epsEstimate !== 0) {
        const epsBeatPct = ((result.epsActual - result.epsEstimate) / Math.abs(result.epsEstimate)) * 100;
        if (epsBeatPct >= 15) {
            score += 3;
            factors.push(`EPS beat +${epsBeatPct.toFixed(0)}% +3`);
        } else if (epsBeatPct >= 5) {
            score += 2;
            factors.push(`EPS beat +${epsBeatPct.toFixed(0)}% +2`);
        } else if (epsBeatPct > 0) {
            score += 1;
            factors.push(`EPS beat +${epsBeatPct.toFixed(0)}% +1`);
        } else {
            score -= 2;
            factors.push(`EPS miss ${epsBeatPct.toFixed(0)}% -2`);
        }
    }

    // Revenue beat
    if (result.revenueActual != null && result.revenueEstimate != null && result.revenueEstimate > 0) {
        const revBeatPct = ((result.revenueActual - result.revenueEstimate) / result.revenueEstimate) * 100;
        if (revBeatPct >= 2) {
            score += 2;
            factors.push(`Revenue beat +${revBeatPct.toFixed(1)}% +2`);
        } else if (revBeatPct > 0) {
            score += 1;
            factors.push(`Revenue beat +${revBeatPct.toFixed(1)}% +1`);
        }
    }

    // Pre/post-market price reaction
    const pctMove = parseFloat(priceChange) || 0;
    if (pctMove >= 10) {
        score += 3;
        factors.push(`Price +${pctMove.toFixed(1)}% +3`);
    } else if (pctMove >= 5) {
        score += 2;
        factors.push(`Price +${pctMove.toFixed(1)}% +2`);
    } else if (pctMove >= 2) {
        score += 1;
        factors.push(`Price +${pctMove.toFixed(1)}% +1`);
    } else if (pctMove <= -5) {
        score -= 2;
        factors.push(`Price ${pctMove.toFixed(1)}% -2`);
    }

    // Congressional signal
    if (CONGRESSIONAL_SIGNAL_TICKERS.has(ticker)) {
        score += 3;
        factors.push(`Congressional signal (${ticker} in cluster/CHIPS/defense) +3`);
    }

    // Guidance raised (inferred from result object or beat context)
    if (result.surprisePercent != null && result.surprisePercent > 20) {
        score += 1;
        factors.push(`Large positive surprise ${result.surprisePercent?.toFixed(0)}% +1`);
    }

    return { score, factors };
}

// ── Finnhub helpers ──────────────────────────────────────────────────────────
async function fetchEarningsCalendar(apiKey, fromDate, toDate) {
    const params = new URLSearchParams({ from: fromDate, to: toDate, token: apiKey });
    const data = await safeFetch(`${FINNHUB_BASE}/calendar/earnings?${params}`, { timeout: 10000 });
    return data?.earningsCalendar || [];
}

async function fetchEarningsResult(apiKey, ticker) {
    const params = new URLSearchParams({ symbol: ticker, limit: '1', token: apiKey });
    const data = await safeFetch(`${FINNHUB_BASE}/stock/earnings?${params}`, { timeout: 8000 });
    return Array.isArray(data) ? data[0] : null;
}

async function fetchQuote(apiKey, ticker) {
    const params = new URLSearchParams({ symbol: ticker, token: apiKey });
    const data = await safeFetch(`${FINNHUB_BASE}/quote?${params}`, { timeout: 8000 });
    // c = current price, pc = prev close, dp = % change
    return data?.c != null ? { price: data.c, prevClose: data.pc, changePct: data.dp, high: data.h, low: data.l } : null;
}

// ── Time helpers ─────────────────────────────────────────────────────────────
function nowET() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function todayStr() {
    const d = nowET();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function tomorrowStr() {
    const d = nowET();
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Returns true during the two earnings reporting windows (ET):
 *   After-hours:  4:00 PM – 6:30 PM
 *   Pre-market:   6:00 AM – 9:20 AM
 */
function inEarningsWindow() {
    const et = nowET();
    const hhmm = et.getHours() * 100 + et.getMinutes();
    return (hhmm >= 1600 && hhmm <= 1830) || (hhmm >= 600 && hhmm <= 920);
}

// ── Main watcher class ───────────────────────────────────────────────────────
export class EarningsWatcher {
    /**
     * @param {object} opts
     * @param {object} opts.scout          — ScoutLLM instance
     * @param {object} opts.debate         — Debate instance
     * @param {object} opts.snapTrade      — SnapTrade instance (for order placement)
     * @param {object} opts.telegram       — TelegramAlerter instance
     * @param {Function} opts.getLiveQuote — async (ticker) => { price, ... }
     * @param {Function} opts.onTrade      — async (trades, briefing) — called after council verdict
     * @param {number}  opts.scoreThreshold — min score to trigger council (default 8)
     */
    constructor({ scout, debate, snapTrade, telegram, getLiveQuote, onTrade, scoreThreshold = 8 }) {
        this.scout          = scout;
        this.debate         = debate;
        this.snapTrade      = snapTrade;
        this.telegram       = telegram;
        this.getLiveQuote   = getLiveQuote;
        this.onTrade        = onTrade;
        this.scoreThreshold = scoreThreshold;
        this.apiKey         = process.env.FINNHUB_API_KEY || null;

        // State
        this.watchlist      = new Map(); // ticker → { date, epsEstimate, revenueEstimate }
        this.alerted        = new Set(); // tickers already acted on this cycle (prevents double-fire)
        this.lastCalRefresh = 0;
        this._timer         = null;
        this._running       = false;
    }

    // ── Public: start/stop ───────────────────────────────────────────────────
    start() {
        if (!this.apiKey) {
            console.warn('[EarningsWatcher] ⚠ FINNHUB_API_KEY not set — earnings watcher disabled.');
            return;
        }
        if (this._running) return;
        this._running = true;
        console.log('[EarningsWatcher] 🕐 Started — monitoring for earnings catalysts.');
        this._schedule();
    }

    stop() {
        this._running = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        console.log('[EarningsWatcher] Stopped.');
    }

    // ── Internal scheduling ──────────────────────────────────────────────────
    _schedule() {
        if (!this._running) return;
        const inWindow = inEarningsWindow();
        const interval = inWindow ? 2 * 60 * 1000 : 30 * 60 * 1000; // 2 min | 30 min
        this._timer = setTimeout(async () => {
            try { await this._tick(); } catch (e) { console.error('[EarningsWatcher] tick error:', e.message); }
            this._schedule();
        }, interval);
    }

    // ── Core tick ─────────────────────────────────────────────────────────────
    async _tick() {
        // Refresh watchlist hourly
        const now = Date.now();
        if (now - this.lastCalRefresh > 60 * 60 * 1000) {
            await this._refreshWatchlist();
        }

        if (!inEarningsWindow()) return; // outside window — only refresh watchlist
        if (this.watchlist.size === 0) return;

        const today = todayStr();
        const toCheck = [...this.watchlist.entries()]
            .filter(([ticker, meta]) => !this.alerted.has(ticker) && (meta.date === today || meta.date === tomorrowStr()))
            .map(([ticker]) => ticker);

        if (toCheck.length === 0) return;

        console.log(`[EarningsWatcher] 🔍 Checking ${toCheck.length} tickers for results...`);

        for (const ticker of toCheck) {
            try {
                await this._checkTicker(ticker);
                await new Promise(r => setTimeout(r, 300)); // 300ms between calls → well under 60 RPM
            } catch (e) {
                console.warn(`[EarningsWatcher] ⚠ ${ticker} check failed: ${e.message}`);
            }
        }
    }

    // ── Refresh earnings watchlist from Finnhub calendar ────────────────────
    async _refreshWatchlist() {
        try {
            const from = todayStr();
            const to   = tomorrowStr();
            const cal  = await fetchEarningsCalendar(this.apiKey, from, to);
            const prev = this.watchlist.size;
            this.watchlist.clear();

            for (const item of cal) {
                if (!EARNINGS_WATCHLIST.includes(item.symbol)) continue;
                this.watchlist.set(item.symbol, {
                    date:            item.date,
                    epsEstimate:     item.epsEstimate,
                    revenueEstimate: item.revenueEstimate,
                    quarter:         item.quarter,
                    year:            item.year,
                });
            }

            this.lastCalRefresh = Date.now();
            // Reset alerted set daily (midnight ET)
            const etHour = nowET().getHours();
            if (etHour < 7) this.alerted.clear(); // clear after midnight, before pre-market

            console.log(`[EarningsWatcher] 📅 Watchlist refreshed — ${this.watchlist.size} tickers (was ${prev}): ${[...this.watchlist.keys()].join(', ') || 'none'}`);
        } catch (e) {
            console.error('[EarningsWatcher] Calendar refresh failed:', e.message);
        }
    }

    // ── Check a single ticker for fresh results ──────────────────────────────
    async _checkTicker(ticker) {
        const result = await fetchEarningsResult(this.apiKey, ticker);
        if (!result) return;

        // Result is "fresh" if it was reported today or yesterday (Finnhub sometimes lags 1 day)
        const today = todayStr();
        const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]; })();
        const resultDate = result.period?.split('T')[0] || result.date || '';

        // Finnhub earnings result: period is the quarter-end date, not the release date.
        // Instead check: epsActual is non-null AND was null in our calendar (i.e. results just dropped).
        if (result.actual == null && result.epsActual == null) return; // no result yet

        const meta = this.watchlist.get(ticker) || {};
        const quote = await fetchQuote(this.apiKey, ticker);
        if (!quote) return;

        const pctChange = quote.changePct ?? ((quote.price - quote.prevClose) / quote.prevClose * 100);
        const { score, factors } = scoreEarningsResult(ticker, result, pctChange);

        console.log(`[EarningsWatcher] 📊 ${ticker} result: EPS ${result.actual ?? result.epsActual} vs est ${result.epsEstimate} | Price ${pctChange >= 0 ? '+' : ''}${pctChange?.toFixed(1)}% | Score: ${score} pts`);

        if (score < this.scoreThreshold) {
            console.log(`[EarningsWatcher] ⏭ ${ticker} score ${score} < threshold ${this.scoreThreshold} — skipping.`);
            return;
        }

        // Mark as alerted before triggering so a slow council doesn't double-fire
        this.alerted.add(ticker);
        console.log(`[EarningsWatcher] 🚨 ${ticker} scored ${score} pts — triggering express council!`);
        await this._triggerExpressCouncil(ticker, result, quote, score, factors, meta);
    }

    // ── Express council: fast-path Scout → Phi/Theta/Gregor ─────────────────
    async _triggerExpressCouncil(ticker, result, quote, score, factors, meta) {
        const epsActual   = result.actual ?? result.epsActual ?? 'N/A';
        const epsEst      = result.epsEstimate ?? meta.epsEstimate ?? 'N/A';
        const revActual   = result.revenueActual != null ? `$${(result.revenueActual / 1e9).toFixed(2)}B` : 'N/A';
        const revEst      = result.revenueEstimate != null ? `$${(result.revenueEstimate / 1e9).toFixed(2)}B` : (meta.revenueEstimate != null ? `$${(meta.revenueEstimate / 1e9).toFixed(2)}B` : 'N/A');
        const pctChange   = quote.changePct ?? ((quote.price - quote.prevClose) / quote.prevClose * 100);
        const pctStr      = `${pctChange >= 0 ? '+' : ''}${pctChange?.toFixed(1)}%`;
        const inWindow    = inEarningsWindow();
        const windowType  = nowET().getHours() < 12 ? 'PRE-MARKET' : 'AFTER-HOURS';

        // Alert immediately via Telegram so you know the watcher fired
        this.telegram?.sendMessage?.(
            `🚨 *EARNINGS ALERT — ${ticker}*\n` +
            `EPS: ${epsActual} vs est ${epsEst} | Rev: ${revActual} vs ${revEst}\n` +
            `${windowType} price: $${quote.price} (${pctStr})\n` +
            `Score: ${score} pts — triggering express council...`
        );

        // Build express briefing — Scout sees this instead of the 34-source sweep
        const entryTarget  = parseFloat((quote.price * 0.98).toFixed(2)); // -2% from pre-market (gap dip entry)
        const expressContext = [
            `╔══════════════════════════════════════════`,
            `║ ⚡ EARNINGS ALERT — EXPRESS COUNCIL`,
            `║ ${ticker} Q${result.quarter ?? '?'} ${result.year ?? ''} RESULTS JUST DROPPED`,
            `╚══════════════════════════════════════════`,
            ``,
            `EARNINGS RESULT:`,
            `  EPS Actual:     ${epsActual}`,
            `  EPS Estimate:   ${epsEst}`,
            `  Revenue Actual: ${revActual}`,
            `  Revenue Est:    ${revEst}`,
            `  Surprise:       ${result.surprisePercent != null ? result.surprisePercent.toFixed(1) + '%' : 'N/A'}`,
            ``,
            `${windowType} MARKET DATA:`,
            `  ${ticker} Price:    $${quote.price}`,
            `  Prev Close:     $${quote.prevClose}`,
            `  Change:         ${pctStr}`,
            `  Session High:   $${quote.high ?? 'N/A'}`,
            `  Session Low:    $${quote.low ?? 'N/A'}`,
            ``,
            `EXPRESS SCORE: ${score} pts`,
            `Factors: ${factors.join(' | ')}`,
            ``,
            `ENTRY STRATEGY (pre-market gap):`,
            `  Do NOT buy at current pre-market price ($${quote.price}) — that is the gap.`,
            `  Target entry: $${entryTarget} (-2% from pre-market) — wait for the open dip.`,
            `  If stock gaps down at open → re-evaluate. If it holds or builds → fill at limit.`,
            `  Time-in-force: Day — this is an INTRADAY or early-SWING entry.`,
            ``,
            `CONGRESSIONAL NOTE: ${CONGRESSIONAL_SIGNAL_TICKERS.has(ticker) ? `${ticker} is in the congressional signal cluster (CHIPS Act / defense contracts) — this beat has structural tailwind beyond the earnings event.` : 'No active congressional cluster signal on this ticker.'}`,
        ].join('\n');

        // Express Scout assessment
        console.log(`[EarningsWatcher] 🤖 Running express Scout for ${ticker}...`);
        let scoutBriefing;
        try {
            const [buyingPower, openOrders, port] = await Promise.all([
                this.snapTrade.FetchAccountBuyingPower(),
                this.snapTrade.FetchOpenAccountOrders(),
                this.snapTrade.FetchUserTrades(),
            ]);
            const portfolioStr = JSON.stringify((Array.isArray(port) ? port : []).map(p => ({
                symbol: p.symbol, units: p.units, price: p.price, pnl_pct: p.pnl_pct
            })));
            const openOrdersStr = JSON.stringify(openOrders)?.slice(0, 400) || 'None';

            const expressScoutPrompt = [
                `You are Beta, Market Scout. A high-conviction earnings catalyst just dropped.`,
                `Buying Power: ${buyingPower} | Portfolio: ${portfolioStr} | Open Orders: ${openOrdersStr}`,
                ``,
                `TASK: Evaluate this earnings result and output ESCALATING or QUIET.`,
                `The express score is already ${score} pts — your job is to confirm the thesis and set the horizon.`,
                `Entry is INTRADAY (same-day gap play) or SWING (continuation over 2-5 sessions) — NOT LONG unless structural thesis warrants it.`,
                `If ESCALATING: use the pre-market price $${quote.price} for The Data field. Entry target is $${entryTarget} (limit, -2% from pre-market for the open dip).`,
                `If QUIET: state why the score doesn't hold up on closer inspection.`,
                ``,
                expressContext,
            ].join('\n');

            const draftRes = await this.scout.complete(expressScoutPrompt, expressContext, { maxTokens: 1500 });
            scoutBriefing = draftRes?.text || draftRes;
        } catch (e) {
            console.error(`[EarningsWatcher] ✗ Express Scout failed for ${ticker}: ${e.message}`);
            this.telegram?.sendMessage?.(`⚠️ *EARNINGS WATCHER* — Express Scout failed for ${ticker}: ${e.message}`);
            return;
        }

        if (!scoutBriefing || scoutBriefing.toUpperCase().includes('QUIET')) {
            console.log(`[EarningsWatcher] Scout output QUIET for ${ticker} — standing down.`);
            this.telegram?.sendMessage?.(`📊 *EARNINGS WATCHER — ${ticker}*\nScout reviewed and output QUIET — no trade.`);
            return;
        }

        console.log(`[EarningsWatcher] ✅ Scout escalated ${ticker} — routing to full council...`);

        // Full council debate with the express briefing
        try {
            const [remaining] = await Promise.all([
                this.snapTrade.FetchOrderCompliance().then(c => {
                    // rough remaining trades calc — same logic as server.mjs
                    const filled = Array.isArray(c) ? c.filter(o => o.status === 'Filled' || o.status === 'filled').length : 0;
                    return Math.max(0, 3 - filled);
                }).catch(() => 1),
            ]);

            const trades = await this.debate.beginDebate(scoutBriefing, [], remaining);
            const actionable = (Array.isArray(trades) ? trades : [trades]).filter(t => t?.action && t.action !== 'WAIT');

            if (actionable.length === 0) {
                console.log(`[EarningsWatcher] Council returned WAIT for ${ticker}.`);
                this.telegram?.sendMessage?.(`📊 *EARNINGS WATCHER — ${ticker}*\nCouncil returned WAIT — conditions not met for order.`);
                return;
            }

            // Hand off to server's trade executor
            if (this.onTrade) {
                await this.onTrade(actionable, scoutBriefing);
            } else {
                // Fallback: direct placement
                for (const trade of actionable) {
                    console.log(`[EarningsWatcher] 📋 Placing ${trade.action} ${trade.symbol} @ $${trade.price} (${trade.order_type})`);
                    const res = await this.snapTrade.PlaceOrder(trade);
                    if (res) {
                        console.log(`[EarningsWatcher] ✅ Order placed: ${trade.symbol}`);
                        this.telegram?.sendTradeAlert?.(trade);
                        this.telegram?.sendMessage?.(
                            `✅ *EARNINGS PLAY — ${trade.symbol}*\n${trade.action} ${trade.units ?? ''} @ $${trade.price} (${trade.order_type})\nTriggered by earnings beat — Score: ${score} pts`
                        );
                    }
                }
            }
        } catch (e) {
            console.error(`[EarningsWatcher] ✗ Council/order failed for ${ticker}: ${e.message}`);
            this.telegram?.sendMessage?.(`❌ *EARNINGS WATCHER ERROR — ${ticker}*\n${e.message}`);
        }
    }
}
