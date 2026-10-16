# Crucix — Data Sources & Keys

All keys live in `.env` (loaded by `apis/utils/env.mjs`). The sweep runs ~39 sources every
`REFRESH_INTERVAL_MINUTES`; most are **keyless**. A missing data key doesn't stop the agent — that
signal just goes dark (and now logs that it's unavailable instead of pretending there's "no data").

## Target architecture (multitenant)

Two tiers. Keys split cleanly along them:

- **🗄️ Data server (one, shared).** Runs the ~39 OSINT/market sources + the ideas/thesis LLM and
  writes the synthesized sweep to a **database**. Market and geopolitical data is identical for
  everyone, so every data-source key lives here **once** — never duplicated per user.
- **🧑 RedLine instance (per user/tenant).** Reads the latest sweep **from the DB** (no data-source
  keys needed) and brings only the user's own stuff: their **agent LLM**, their **brokerage**, and
  their **alert channels**.

> So a new user only brings keys to the **RedLine end** (§1). The data-source keys (§2) belong to
> the shared data server and are set up once.

---

## 1. RedLine instance — what each user brings 🧑

| Purpose | Env var(s) | Required | Where / notes |
|---|---|---|---|
| **Trading agent** (Claude) | `AGENT_PROVIDER`, `ANTHROPIC_API_KEY`, `AGENT_MODEL` | ✅ (one of) | Default `claude-code` runs on a Claude **subscription** via the `claude` CLI — needs `claude login` on the host, **no key**. For multitenant/pay-per-token: `AGENT_PROVIDER=anthropic` + each user's `ANTHROPIC_API_KEY`. `AGENT_MODEL=sonnet` (default) or `haiku`. |
| **Brokerage — app** | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | ✅ to trade | Your SnapTrade developer app. Shared across tenants (one per deployment). [snaptrade.com](https://snaptrade.com). |
| **Brokerage — user** | `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`, `SNAPTRADE_ACCOUNT_ID`, `SNAPTRADE_AUTH_ID` | ✅ to trade | Per end-user registration + account — the actual per-tenant secret. |
| **Alerts bot** | `TELEGRAM_BOT_TOKEN` | Recommended | One bot via [@BotFather](https://t.me/BotFather); can be shared. |
| **Alert channels** | `TELEGRAM_CHAT_ID`, `PROPOSALS_CHAT_ID` | Recommended | `CHAT_ID` = news/status; `PROPOSALS_CHAT_ID` = Accept/Deny cards (falls back to `CHAT_ID`). Per user. |
| Alerts (alt) | `DISCORD_BOT_TOKEN` / `DISCORD_WEBHOOK_URL` + `DISCORD_CHANNEL_ID`, `DISCORD_GUILD_ID` | Optional | Discord instead of / alongside Telegram. |

**Minimum to go live:** `claude login` (or `ANTHROPIC_API_KEY`) · SnapTrade app + user creds · a
Telegram bot + chat IDs. Nothing from §2 is needed on a RedLine instance — the data arrives via the DB.

---

## 2. Data server — the shared sweep 🗄️

Set up **once** on the central data server. Every key here is free-tier unless noted.

### LLM for the shared brief
| Purpose | Env var(s) | Notes |
|---|---|---|
| Ideas + thesis generation | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | Market-wide macro brief + forward-pacing theses (not user-specific). Fallback `gemini-2.5-flash-lite`. |
| Ideas fallback | `GROQ_FALLBACK_KEY` (`GROQ_FALLBACK_BASE_URL` preset) | Used when the primary ideas LLM fails. [console.groq.com](https://console.groq.com). |

### Market & financial data
| Signal | Env var | Get it at | Notes |
|---|---|---|---|
| Economic indicators (VIX, rates, spreads) | `FRED_API_KEY` | [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys) | Free. |
| Energy (EIA oil/gas/inventories) | `EIA_API_KEY` | [eia.gov/opendata](https://www.eia.gov/opendata/) | Free. |
| Labor (BLS CPI/PPI/payrolls) | `BLS_API_KEY` | [bls.gov/developers](https://www.bls.gov/developers/) | Keyless works at a lower limit; key raises it. |
| Congressional trades + insiders | `BARGO_API_KEY` | [bargo.ai dashboard](https://www.bargo.ai/free-apis/dash) | **Primary congress feed.** Keyless = 100 rows/day; key = 250 rows / 100 req/day. Requires visible "Data: Bargo (bargo.ai)" credit. |
| Econ calendar + analyst upgrades | `FMP_API_KEY` | [financialmodelingprep.com](https://site.financialmodelingprep.com/developer/docs) | **Only** these two now (trades moved to Bargo). Free tier 429s easily — consider Finnhub. |
| Earnings calendar + insider buys | `FINNHUB_API_KEY` | [finnhub.io](https://finnhub.io/) | Free. |
| News / M&A headlines | `NEWS_API_KEY` | [newsapi.org](https://newsapi.org/) | Free (dev tier). |
| Options flow / unusual activity | `BENZINGA_API_KEY` | [benzinga.com/apis](https://www.benzinga.com/apis/) | Optional/paid. RSS-derived signals only without it. |
| Technical setup scan (SPY ref) | `ALPACA_API_KEY`, `ALPACA_SECRET` | [alpaca.markets](https://alpaca.markets/) | Free paper keys work. |

### OSINT / geopolitical
| Signal | Env var(s) | Get it at | Notes |
|---|---|---|---|
| Thermal / fire detections | `FIRMS_MAP_KEY` | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/) | Free. |
| Conflict events | `ACLED_EMAIL`, `ACLED_PASSWORD` | [acleddata.com](https://acleddata.com/register/) | Free account. |
| Internet outage radar | `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com](https://dash.cloudflare.com/profile/api-tokens) | Free. |
| Maritime AIS tracking | `AISSTREAM_API_KEY` | [aisstream.io](https://aisstream.io/) | Free. |
| Reddit social velocity | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) | Free OAuth app. |
| Telegram OSINT scrape | `TELEGRAM_CHANNELS` (+ a bot token) | — | Comma-separated channels to monitor. |
| Flight tracking (ADS-B) | `ADSB_API_KEY` or `RAPIDAPI_KEY` | [rapidapi.com](https://rapidapi.com/) | Optional. |
| SEC EDGAR identity | `SEC_USER_AGENT` | — | Set `"Your Name your@email"` — SEC requires a contact UA. |
| Humanitarian (ReliefWeb) | `RELIEFWEB_APPNAME` | — | Any identifier string (their fair-use "appname"). |

### Keyless — nothing to configure
Yahoo Finance (prices/quotes/VIX/movers/metals/ticker), US Treasury, GSCPI, USAspending, UN Comtrade,
SEC-EDGAR filings*, Federal Register (policy/EOs), CHIPS Act, GDELT, OpenSky, WHO, OFAC, OpenSanctions,
NOAA, EPA RadNet, Patents, Bluesky, KiwiSDR, CelesTrak (space), CISA-KEV, HackerNews, TrendForce.

\* Set `SEC_USER_AGENT` so SEC requests aren't rate-limited.

---

## 3. Tuning knobs (optional)

| Env var | Default | Effect | Tier |
|---|---|---|---|
| `REFRESH_INTERVAL_MINUTES` | 15 | Sweep cadence. | 🗄️ |
| `CONGRESS_CACHE_HOURS` | 24 | Congress data cache window. | 🗄️ |
| `MAX_PROPOSALS_PER_DAY` | 3 | NEW_BUY cap (exits exempt; 0 = off). | 🧑 |
| `PROPOSAL_TTL_MINUTES` | — | Default proposal expiry if the agent omits one. | 🧑 |
| `TRACK_RECORD_MIN` | 3 | Resolved trades before the track record feeds the agent. | 🧑 |
| `CALIBRATION_MIN` | 4 | Resolved confidence-tagged trades before calibration feeds the agent. | 🧑 |
| `STOP_LOSS_INTRADAY` / `_SWING` / `_LONG` (+ `PROFIT_LOCK_*`, `TRAIL_*`) | per-horizon | Hard stop / trailing bands enforced by the stop-loss watcher. | 🧑 |
| `MA_CROSS_MARGIN` | 0.0075 | Hysteresis band — price must clear a moving average by this fraction (0.75%) for a cross to fire. Bigger = fewer, higher-conviction crosses (less whipsaw). | 🧑 |
| `ANTICHURN_WINDOW_MIN` | 45 | Minutes after entry during which a losing position can't be soft-exited (hard stop still fires). 0 = disabled. | 🧑 |
| `ANTICHURN_MIN_PROFIT_PCT` | 0.3 | Inside that window, a position can only be flipped early if up at least this % (winners scalp fast; losers hold to the stop). | 🧑 |
| `ALLOW_EXTENDED_HOURS_ENTRY` | false | When false, a NEW_BUY only fires in the regular 9:30–16:00 ET session (pre/after-market = noise). Exits are never gated. | 🧑 |
| `DISCOVERY_MIN_SCORE` | 3 | Minimum composite score for a candidate to reach the MARKET_SETUPS board — filters single-signal noise. | 🧑 |

---

## 4. Source → agent digest-line mapping

What the trading agent actually reads each sweep is the compacted digest
(`compactSweepForLLM` in `lib/llm/ideas.mjs`), not the raw sources. This maps each **digest line**
back to its **source** and key. A line only appears when that source returned data that sweep —
a quiet source just omits its line. The ~39 collected sources distill into these lines, so
"39 sources" ≠ "39 lines" (several OSINT/geo sources feed `URGENT_OSINT` or aren't surfaced in the
*trade* digest at all).

### Position-specific — on names you hold or have a stance on
| Digest line | Source | Key |
|---|---|---|
| `MA_CROSS` (fresh 50/200-day MA crosses, death/golden cross) | Alpaca bars + `runs/ma-state.json` diff | `ALPACA_API_KEY` |
| `POSITION_TECHNICALS` (price vs MA50/200, RSI, 1m/3m, trend) | Alpaca (`getSetupTechnicals`) | `ALPACA_API_KEY` |
| `POSITION_NEWS` (company-specific headlines) | Finnhub `/company-news` | `FINNHUB_API_KEY` |
| `INSIDER_SELLS` (execs/directors reducing) | Finnhub `/stock/insider-transactions` | `FINNHUB_API_KEY` |
| `INSTITUTIONAL_SELLS` (13F funds cutting stakes) | Finnhub `/institutional-ownership` | `FINNHUB_API_KEY` (paid tier) |

### Insider / congressional / filings
| Digest line | Source | Key |
|---|---|---|
| `CONGRESS_INSIDERS`, `CONGRESS_CLUSTER_BUYS` | Bargo | `BARGO_API_KEY` (keyless at lower limit) |
| `EXEC_INSIDER_BUYS` | Finnhub insider transactions (watchlist) | `FINNHUB_API_KEY` |
| `SEC_INSIDER_FILINGS` (Form 4), `SEC_MATERIAL_EVENTS` (8-K) | SEC EDGAR | keyless (`SEC_USER_AGENT`) |

### Macro / economic
| Digest line | Source | Key |
|---|---|---|
| `ECONOMIC` (VIX, fed funds, 10y/2y, HY spread, dollar, mortgage) | FRED | `FRED_API_KEY` |
| `TREASURY` (total debt) | US Treasury | keyless |
| `LABOR` (CPI/PPI/payrolls) | BLS | `BLS_API_KEY` (keyless at lower limit) |
| `SUPPLY_CHAIN` (GSCPI) | NY Fed GSCPI | keyless |
| `MACRO_CALENDAR` (FOMC/CPI/NFP/GDP) | FMP econ calendar | `FMP_API_KEY` |

### Energy / commodities / market
| Digest line | Source | Key |
|---|---|---|
| `ENERGY`, `EIA_SIGNALS` (WTI/Brent/NatGas/crude stocks) | EIA | `EIA_API_KEY` |
| `METALS` (gold/silver) | Yahoo | keyless |
| `MARKET_MOVES` (indexes/commodities/rates) | Yahoo | keyless |
| `MARKET_LOSERS`, `MARKET_GAINERS` | Yahoo movers screener | keyless |

### Equities news / flow
| Digest line | Source | Key |
|---|---|---|
| `FAST_NEWS`, `OPTIONS_SWEEPS`/`OPTIONS_FLOW`, `UPGRADES_DOWNGRADES_NEWS` | Benzinga | `BENZINGA_API_KEY` (RSS-only without) |
| `ANALYST_CALLS` | FMP upgrades/downgrades | `FMP_API_KEY` |
| `FINNHUB_SIGNALS`, `M&A_HEADLINES`, `EARNINGS_CALENDAR` | Finnhub | `FINNHUB_API_KEY` |
| `NEWSAPI_SIGNALS`, `MA_DEALS` | NewsAPI | `NEWS_API_KEY` |
| `SEMI_PRICING`, `SEMI_SIGNALS` (DRAM/NAND, B2B ratio) | TrendForce | keyless |

### Policy / government / defense
| Digest line | Source | Key |
|---|---|---|
| `POLICY_ACTIONS` (executive actions) | Federal Register | keyless |
| `CHIPS_GRANTS`, `BIS_EXPORT_CONTROLS` | CHIPS Act / BIS | keyless |
| `DEFENSE_CONTRACTS` | USAspending | keyless |

### Geopolitical / OSINT
| Digest line | Source | Key |
|---|---|---|
| `URGENT_OSINT` | Telegram OSINT channels | `TELEGRAM_CHANNELS` + bot token |
| `WHO_ALERTS` | WHO | keyless |
| `MARITIME_CHOKEPOINTS` | ships / static reference | keyless (`AISSTREAM_API_KEY` for live AIS) |
| `NUCLEAR_ANOMALY` | Safecast | keyless |
| `SOCIAL_VIRAL` | Reddit | `REDDIT_CLIENT_ID`/`SECRET` |
| `THERMAL` (fire detections), `AIR_ACTIVITY` (ADS-B) | FIRMS / ADS-B | **stripped from the trade agent's context** (kept for the free ideas pass) |

### Reasoning layer wrapped around the digest
Not sources — assembled in `buildAnalystContext`: **FORWARD-PACING THESES** (megatrends) ·
`DELTA_SINCE_LAST_SWEEP` / `ESCALATED` / `NEW_SIGNALS` · **account state** (portfolio, open orders,
buying power, PDT) · **stance book**, **track record**, **confidence calibration**, **directives**,
**strategy mode**.

> Collected-but-not-in-the-trade-digest sources (ACLED, GDELT, ReliefWeb, OFAC, OpenSanctions,
> patents, NOAA, EPA, Bluesky, HackerNews, KiwiSDR, CelesTrak, CISA-KEV, Cloudflare Radar, Comtrade,
> OpenSky) run in the full sweep for the dashboard / ideas pass; they either feed `URGENT_OSINT`
> context or aren't surfaced as a trade-agent line.
