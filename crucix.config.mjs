// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export default {
  port: parseInt(process.env.PORT) || 3117,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  llm: {
    provider:      process.env.LLM_PROVIDER        || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok
    apiKey:        process.env.LLM_API_KEY          || null,
    model:         process.env.LLM_MODEL            || null,
    fallbackModel: process.env.LLM_FALLBACK_MODEL   || 'gemini-2.5-flash-lite',
    baseUrl:       process.env.OLLAMA_BASE_URL       || null,
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
    botPollingInterval: parseInt(process.env.TELEGRAM_POLL_INTERVAL) || 5000,
    channels: process.env.TELEGRAM_CHANNELS || null, // Comma-separated extra channel IDs
  },

  discord: {
    botToken: process.env.DISCORD_BOT_TOKEN || null,
    channelId: process.env.DISCORD_CHANNEL_ID || null,
    guildId: process.env.DISCORD_GUILD_ID || null,   // Server ID (for instant slash command registration)
    webhookUrl: process.env.DISCORD_WEBHOOK_URL || null, // Fallback: webhook-only alerts (no bot needed)
  },

  snapTrade: {
    clientId: process.env.SNAPTRADE_CLIENT_ID || null,
    consumerKey: process.env.SNAPTRADE_CONSUMER_KEY || null ,
    userId: process.env.SNAPTRADE_USER_ID || null,
    userSecret: process.env.SNAPTRADE_USER_SECRET || null, 
    accountId: process.env.SNAPTRADE_ACCOUNT_ID || null,
    authId: process.env.SNAPTRADE_AUTH_ID || null ,
  },

  // Groq fallback — used when primary Gemini models fail for LLM ideas generation
  fallback: {
    apiKey: process.env.GROQ_FALLBACK_KEY || null,
  },

redline: {
  enabled: true,

  // ── Durable Assets — instruments that track structural value and always recover ──
  // Positions in these assets facing temporary headwinds are routed to TRADE AROUND
  // (GTC sell at breakeven/R1, re-entry at S1) rather than a panic market exit.
  // Add any ETF or commodity that you'd always want to re-own at a lower price.
  durableAssets: [
    // Precious metals
    'SLV', 'GLD', 'GDX', 'GDXJ', 'IAU', 'SIVR', 'PPLT',
    // Energy
    'USO', 'UNG', 'XLE', 'XOP', 'OIH',
    // Broad market indices
    'SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'VEA', 'VWO',
    // Sector ETFs
    'XLF', 'XLK', 'XLV', 'XLP', 'XLU', 'XLI', 'XLB', 'XLRE',
    // Defense ETFs
    'ITA', 'XAR', 'PPA',
    // Fixed income
    'TLT', 'HYG', 'LQD', 'SHY', 'IEF', 'BND',
  ],

  // ── Free-tier provider pool (shared across Phi, Theta, Gregor) ──────────
  // Sign up at each provider and add the keys to .env.
  // All four are OpenAI-compatible — drop-in replacements for Groq.
  //
  //  Cerebras   → api.cerebras.ai/v1     — 30 RPM / 1M TPD  — CEREBRAS_API_KEY
  //  SambaNova  → api.sambanova.ai/v1    — 20 RPM            — SAMBANOVA_API_KEY
  //  NVIDIA NIM → integrate.api.nvidia.com/v1 — 40 RPM       — NVIDIA_API_KEY
  //  OpenRouter → openrouter.ai/api/v1   — 20 RPM / 200 RPD  — OPENROUTER_API_KEY
  providers: {
    cerebras: {
      apiKey:  process.env.CEREBRAS_API_KEY  || null,
      model:   process.env.CEREBRAS_MODEL    || 'llama3.3-70b',  // Cerebras format: no dash between llama and version
      baseUrl: 'https://api.cerebras.ai/v1',
    },
    sambanova: {
      apiKey:  process.env.SAMBANOVA_API_KEY || null,
      model:   process.env.SAMBANOVA_MODEL   || 'Meta-Llama-3.3-70B-Instruct',
      baseUrl: 'https://api.sambanova.ai/v1',
    },
    nvidia: {
      apiKey:  process.env.NVIDIA_API_KEY    || null,
      model:   process.env.NVIDIA_MODEL      || 'meta/llama-3.3-70b-instruct',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
    },
    openrouter: {
      apiKey:  process.env.OPENROUTER_API_KEY || null,
      model:   process.env.OPENROUTER_MODEL   || 'deepseek/deepseek-r1:free',
      baseUrl: 'https://openrouter.ai/api/v1',
    },
  },

  phi: {
    apiKey:        process.env.GROQ_API_KEY          || null,
    model:         process.env.GROQ_MODEL            || null,
    fallbackModel: process.env.PHI_FALLBACK_MODEL    || 'llama-3.3-70b-versatile',
    baseUrl:       process.env.GROQ_BASE_URL         || null,
    // Free-tier fallbacks come from the shared providers block above
  },

  scout: {
    apiKey:           process.env.SCOUT_API_KEY          || null,
    model:            process.env.SCOUT_LLM_MODEL        || null,
    fallbackModel:    process.env.SCOUT_FALLBACK_MODEL   || 'gemini-2.5-flash-lite', // stable fallback when primary 503s
    fallbackApiKey:   process.env.SCOUT_FALLBACK_API_KEY || null, // separate quota pool for fallback model
    fallbackDelayMs:  parseInt(process.env.SCOUT_FALLBACK_DELAY_MS || '5000', 10), // wait before same-API retry
    baseUrl:          process.env.GEMINI_BASE_URL        || null,
  },

  theta: {
    apiKey:  process.env.THETA_API_KEY  || null,
    model:   process.env.THETA_MODEL    || null,
    baseUrl: process.env.THETA_BASE_URL || null,
    // Free-tier fallbacks come from the shared providers block above
  },

  scribe: {
    apiKey:        process.env.SCRIBE_API_KEY          || null,
    model:         process.env.SCRIBE_MODEL            || null,
    fallbackModel: process.env.SCRIBE_FALLBACK_MODEL   || 'gemini-2.5-flash-lite',
    baseUrl:       process.env.GEMINI_BASE_URL         || null,
  },

  omega: {
    // Primary chain: SambaNova → Groq → Cerebras → NVIDIA NIM → OpenRouter DeepSeek R1
    // Providers block covers SambaNova/Cerebras/NVIDIA/OpenRouter.
    // Groq shared with Phi — same key, no extra credentials needed.
    // Anthropic kept as absolute last resort (user has premium).
    groq: {
      apiKey:  process.env.OMEGA_GROQ_API_KEY   || null,
      baseUrl: process.env.GROQ_BASE_URL  || null,
      model:   process.env.OMEGA_GROQ_MODEL || 'llama-3.3-70b-versatile',
    },
    fallback: {
      apiKey: process.env.ANTHROPIC_API_KEY || null,
      model:  process.env.OMEGA_MODEL       || 'claude-sonnet-4-6',
    },
  },
},


  
  // Delta engine thresholds — override defaults from lib/delta/engine.mjs
  // Set to null to use built-in defaults
  delta: {
    thresholds: {
      numeric: {
        // Example overrides (uncomment to customize):
        // vix: 3,       // more sensitive to VIX moves
        // wti: 5,       // less sensitive to oil moves
      },
      count: {
        // urgent_posts: 3,     // need ±3 urgent posts to flag
        // thermal_total: 1000, // need ±1000 thermal detections
      },
    },
  },
};
