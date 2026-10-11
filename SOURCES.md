# Crucix — Data Sources & Keys

Everything a new deployment needs, grouped by purpose. All keys live in `.env` (loaded by
`apis/utils/env.mjs`). The sweep runs ~39 sources every `REFRESH_INTERVAL_MINUTES`; most are
**keyless** and need nothing. The agent still runs if a data key is missing — that signal just
goes dark (and now logs that it's unavailable rather than pretending there's "no data").

## Multitenancy note (future)

The **Scope** column marks how each secret should be stored when this goes multitenant:

- 🌐 **Global** — one value for the whole deployment. Market/OSINT data is identical for every
  user, so these are shared app-wide (don't duplicate per tenant).
- 🧑 **Per-tenant** — one value *per end user*. Their brokerage link and their alert channels.

The only per-tenant secrets are **SnapTrade user credentials** and **Telegram chat IDs**. Everything
else (all data feeds, the SnapTrade *app* credentials, the bot token) is global.

---

## 1. Core — required to run & trade

| Purpose | Env var(s) | Scope | Required | Where / notes |
|---|---|---|---|---|
| **Trading agent** (Claude) | `AGENT_PROVIDER`, `ANTHROPIC_API_KEY`, `AGENT_MODEL` | 🌐 | ✅ one of | Default `claude-code` runs on your Claude **subscription** via the `claude` CLI — needs `claude login` on the host, **no key**. For pay-per-token API: `AGENT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`. `AGENT_MODEL=sonnet` (default) or `haiku`. |
| **Ideas + thesis LLM** | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL` | 🌐 | Recommended | Generates the macro brief + forward-pacing theses. `anthropic\|openai\|gemini\|openrouter\|groq\|…`. Fallback model `gemini-2.5-flash-lite`. |
| LLM ideas fallback | `GROQ_FALLBACK_KEY` (`GROQ_FALLBACK_BASE_URL` preset) | 🌐 | Optional | Used when the primary ideas LLM fails. Free at [console.groq.com](https://console.groq.com). |
| **Brokerage — app** | `SNAPTRADE_CLIENT_ID`, `SNAPTRADE_CONSUMER_KEY` | 🌐 | ✅ to trade | Your SnapTrade developer app. One per deployment. [snaptrade.com](https://snaptrade.com). |
| **Brokerage — user** | `SNAPTRADE_USER_ID`, `SNAPTRADE_USER_SECRET`, `SNAPTRADE_ACCOUNT_ID`, `SNAPTRADE_AUTH_ID` | 🧑 | ✅ to trade | Per end-user registration + account. In multitenant, store these per tenant; share the app creds above. |
| **Alerts bot** | `TELEGRAM_BOT_TOKEN` | 🌐 | Recommended | One bot via [@BotFather](https://t.me/BotFather). |
| **Alert channels** | `TELEGRAM_CHAT_ID`, `PROPOSALS_CHAT_ID` | 🧑 | Recommended | `CHAT_ID` = news/status channel; `PROPOSALS_CHAT_ID` = Accept/Deny cards (falls back to `CHAT_ID`). |
| Alerts (alt) | `DISCORD_BOT_TOKEN` / `DISCORD_WEBHOOK_URL` + `DISCORD_CHANNEL_ID`, `DISCORD_GUILD_ID` | 🧑 | Optional | Discord instead of / alongside Telegram. |

---

## 2. Market & financial data (all 🌐 global, all free tier)

| Signal | Env var | Get it at | Notes |
|---|---|---|---|
| Economic indicators (VIX, rates, spreads) | `FRED_API_KEY` | [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys) | Free. |
| Energy (EIA oil/gas/inventories) | `EIA_API_KEY` | [eia.gov/opendata](https://www.eia.gov/opendata/) | Free. |
| Labor (BLS CPI/PPI/payrolls) | `BLS_API_KEY` | [bls.gov/developers](https://www.bls.gov/developers/) | Works keyless at a lower rate limit; key raises it. |
| Congressional trades + insiders | `BARGO_API_KEY` | [bargo.ai dashboard](https://www.bargo.ai/free-apis/dash) | **Primary congress feed.** Keyless = 100 rows/day; key = 250 rows / 100 req/day. Requires visible "Data: Bargo (bargo.ai)" credit. |
| Econ calendar + analyst upgrades | `FMP_API_KEY` | [financialmodelingprep.com](https://site.financialmodelingprep.com/developer/docs) | **Only** these two now (trades moved to Bargo). Free tier 429s easily — consider moving to Finnhub. |
| Earnings calendar + insider buys | `FINNHUB_API_KEY` | [finnhub.io](https://finnhub.io/) | Free. |
| News / M&A headlines | `NEWS_API_KEY` | [newsapi.org](https://newsapi.org/) | Free (dev tier). |
| Options flow / unusual activity | `BENZINGA_API_KEY` | [benzinga.com/apis](https://www.benzinga.com/apis/) | Optional/paid. Without it, RSS-derived signals only. |
| Technical setup scan (SPY ref) | `ALPACA_API_KEY`, `ALPACA_SECRET` | [alpaca.markets](https://alpaca.markets/) | Free paper keys work. |

> **Live prices need no key** — quotes, movers, metals, and the dashboard ticker all come from
> Yahoo Finance (keyless). See §4.

---

## 3. OSINT / geopolitical (all 🌐 global)

| Signal | Env var(s) | Get it at | Notes |
|---|---|---|---|
| Thermal / fire detections | `FIRMS_MAP_KEY` | [firms.modaps.eosdis.nasa.gov](https://firms.modaps.eosdis.nasa.gov/api/) | Free. |
| Conflict events | `ACLED_EMAIL`, `ACLED_PASSWORD` | [acleddata.com](https://acleddata.com/register/) | Free account. |
| Internet outage radar | `CLOUDFLARE_API_TOKEN` | [dash.cloudflare.com](https://dash.cloudflare.com/profile/api-tokens) | Free. |
| Maritime AIS tracking | `AISSTREAM_API_KEY` | [aisstream.io](https://aisstream.io/) | Free. |
| Reddit social velocity | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) | Free OAuth app. |
| Telegram OSINT scrape | `TELEGRAM_CHANNELS` (+ reuses `TELEGRAM_BOT_TOKEN`) | — | Comma-separated channels to monitor. |
| Flight tracking (ADS-B) | `ADSB_API_KEY` or `RAPIDAPI_KEY` | [rapidapi.com](https://rapidapi.com/) | Optional. |
| SEC EDGAR identity | `SEC_USER_AGENT` | — | Set to `"Your Name your@email"` — SEC requires a UA with contact. |
| Humanitarian (ReliefWeb) | `RELIEFWEB_APPNAME` | — | Any identifier string (their fair-use "appname"). |

---

## 4. Keyless sources — nothing to configure

These run with no key and cover the backbone of the sweep:

**Market:** Yahoo Finance (prices/quotes/VIX), Market Movers (Yahoo screener), metals, dashboard ticker.
**Econ/gov:** US Treasury, GSCPI supply chain, USAspending, UN Comtrade, SEC-EDGAR filings*, Federal
Register policy/executive orders, CHIPS Act grants.
**OSINT/geo:** GDELT, OpenSky, WHO, OFAC, OpenSanctions, NOAA, EPA RadNet, Patents, Bluesky, KiwiSDR,
CelesTrak (space), CISA-KEV, HackerNews, TrendForce (semi pricing).

\* SEC works keyless but set `SEC_USER_AGENT` (above) so requests aren't rate-limited/blocked.

---

## 5. Useful tuning knobs (optional)

| Env var | Default | Effect |
|---|---|---|
| `REFRESH_INTERVAL_MINUTES` | 15 | Sweep cadence. |
| `MAX_PROPOSALS_PER_DAY` | 3 | NEW_BUY cap (exits exempt; 0 = off). |
| `CONGRESS_CACHE_HOURS` | 24 | How long congress data is cached. |
| `PROPOSAL_TTL_MINUTES` | — | Default proposal expiry if the agent omits one. |
| `TRACK_RECORD_MIN` | 3 | Resolved trades before the track record feeds the agent. |
| `CALIBRATION_MIN` | 4 | Resolved confidence-tagged trades before calibration feeds the agent. |
| `STOP_LOSS_INTRADAY` / `_SWING` / `_LONG` (+ `PROFIT_LOCK_*`, `TRAIL_*`) | per-horizon | Hard stop / trailing bands enforced by the stop-loss watcher. |

---

### Minimum to go live
`claude login` (or `ANTHROPIC_API_KEY`) · SnapTrade app + user creds · a Telegram bot + chat IDs.
Everything else sharpens the agent's view but isn't required to trade.
