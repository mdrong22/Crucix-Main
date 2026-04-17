/**
 * providers.mjs — Shared free-tier OpenAI-compatible provider pool
 *
 * All four providers speak the exact same /v1/chat/completions REST interface.
 * One helper function covers all of them.
 *
 * PROVIDER LIMITS (free tier, as of April 2026):
 *  Cerebras   — 30 RPM / 1M TPD  — llama-3.3-70b-instruct    — api.cerebras.ai/v1
 *  SambaNova  — 20 RPM           — Meta-Llama-3.3-70B-Instruct — api.sambanova.ai/v1
 *  NVIDIA NIM — 40 RPM           — meta/llama-3.3-70b-instruct — integrate.api.nvidia.com/v1
 *  OpenRouter — 20 RPM / 200 RPD — deepseek/deepseek-r1:free  — openrouter.ai/api/v1
 */

export const PROVIDERS = {
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    model:   'llama-3.3-70b-instruct',
    envKey:  'CEREBRAS_API_KEY',
  },
  sambanova: {
    baseUrl: 'https://api.sambanova.ai/v1',
    model:   'Meta-Llama-3.3-70B-Instruct',
    envKey:  'SAMBANOVA_API_KEY',
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model:   'meta/llama-3.3-70b-instruct',
    envKey:  'NVIDIA_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model:   'deepseek/deepseek-r1:free',
    envKey:  'OPENROUTER_API_KEY',
  },
};

/**
 * callProvider — single generic OpenAI-compat REST call.
 *
 * @param {string} baseUrl    — provider base URL
 * @param {string} apiKey     — bearer token
 * @param {string} model      — model id string
 * @param {Array}  messages   — [{role, content}, ...]
 * @param {object} opts       — { maxTokens, temperature, timeout }
 * @returns {string}          — raw text content (think-tags stripped)
 */
export async function callProvider(baseUrl, apiKey, model, messages, opts = {}) {
  if (!apiKey) throw new Error(`[Provider] No API key for ${baseUrl}`);

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      // OpenRouter requires these for free-tier identification
      ...(baseUrl.includes('openrouter') ? {
        'HTTP-Referer': 'https://github.com/crucix-redline',
        'X-Title': 'CrucixRedline',
      } : {}),
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens:  opts.maxTokens  ?? 4096,
    }),
    signal: AbortSignal.timeout(opts.timeout ?? 45000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`[${baseUrl}] ${res.status} — ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`[${baseUrl}] Empty response for model ${model}`);

  // Strip reasoning chain tags (DeepSeek R1, Qwen3 thinking mode)
  return raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/**
 * isRateLimit — true if the error looks like a quota/rate-limit rejection.
 */
export function isRateLimit(msg = '') {
  const m = msg.toLowerCase();
  return m.includes('429') || m.includes('rate') || m.includes('limit') ||
         m.includes('quota') || m.includes('exceeded') || m.includes('capacity');
}
