// Crucix Configuration — all settings with env var overrides

import "./apis/utils/env.mjs"; // Load .env first

export default {
  port: parseInt(process.env.PORT) || 3117,
  refreshIntervalMinutes: parseInt(process.env.REFRESH_INTERVAL_MINUTES) || 15,

  llm: {
    provider:      process.env.LLM_PROVIDER        || null, // anthropic | openai | gemini | codex | openrouter | minimax | mistral | ollama | grok
    apiKey:        process.env.LLM_API_KEY          || null,
    model:         process.env.LLM_MODEL            || null,
    fallbackModel: process.env.LLM_FALLBACK_MODEL   || 'gemini-2.5-flash',
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
  phi: {
    apiKey: process.env.GROQ_API_KEY || null,
    model: process.env.GROQ_MODEL || null,
    baseUrl: process.env.GROQ_BASE_URL || null
  },

  scout: {
    apiKey:        process.env.SCOUT_API_KEY        || null,
    model:         process.env.SCOUT_LLM_MODEL      || null,
    fallbackModel: process.env.SCOUT_FALLBACK_MODEL || 'gemini-2.5-flash',
    baseUrl:       process.env.GEMINI_BASE_URL      || null,
  },

  theta: {
    apiKey: process.env.THETA_API_KEY,
    model: process.env.THETA_MODEL,
    baseUrl: process.env.THETA_BASE_URL
  },

  scribe: {
    apiKey:        process.env.SCRIBE_API_KEY          || null,
    model:         process.env.SCRIBE_MODEL            || null,
    fallbackModel: process.env.SCRIBE_FALLBACK_MODEL   || 'gemini-2.5-flash',
    baseUrl:       process.env.GEMINI_BASE_URL         || null,
  },

  omega: {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model:  process.env.OMEGA_MODEL       || 'claude-opus-4-6',
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
