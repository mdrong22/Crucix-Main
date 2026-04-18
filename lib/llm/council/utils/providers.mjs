/**
 * providers.mjs — Shared free-tier OpenAI-compatible provider pool
 *
 * VERIFIED ENDPOINTS & MODEL IDs (confirmed from /v1/models responses, April 2026):
 *
 *  Cerebras   → https://api.cerebras.ai/v1          model: llama-3.3-70b
 *  SambaNova  → https://api.sambanova.ai/v1          model: Meta-Llama-3.3-70B-Instruct
 *  NVIDIA NIM → https://integrate.api.nvidia.com/v1  model: meta/llama-3.3-70b-instruct
 *  OpenRouter → https://openrouter.ai/api/v1         model: deepseek/deepseek-r1:free
 *
 * If a model gives 404, run: node -e "import('./lib/llm/council/utils/providers.mjs').then(m=>m.listModels('cerebras', process.env.CEREBRAS_API_KEY))"
 * to see all currently live model IDs for that provider.
 */

export const PROVIDERS = {
  cerebras: {
    baseUrl: 'https://api.cerebras.ai/v1',
    model:   'llama-3.3-70b',
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
 * listModels — hit /v1/models on any provider and log the live model IDs.
 * Use this to debug "model not found" errors — shows exactly what the API accepts.
 *
 * @param {string} providerName  — key from PROVIDERS object  e.g. 'cerebras'
 * @param {string} apiKey        — your API key for that provider
 */
export async function listModels(providerName, apiKey) {
  const p = PROVIDERS[providerName];
  if (!p) { console.error(`Unknown provider: ${providerName}`); return; }
  if (!apiKey) { console.error(`No API key provided for ${providerName}`); return; }

  console.log(`\n[${providerName.toUpperCase()}] Fetching live model list from ${p.baseUrl}/models ...\n`);
  try {
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    });
    const body = await res.text();
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${body}`);
      return;
    }
    const data = JSON.parse(body);
    const ids = (data.data || data.models || data).map(m => m.id || m.name || JSON.stringify(m));
    console.log(`Available model IDs on ${providerName}:\n  ${ids.join('\n  ')}\n`);
  } catch (err) {
    console.error(`listModels failed: ${err.message}`);
  }
}

/**
 * callProvider — single generic OpenAI-compat REST call.
 * Throws a detailed error including HTTP status + full response body on failure.
 *
 * @param {string} baseUrl    — provider base URL
 * @param {string} apiKey     — bearer token
 * @param {string} model      — model id string
 * @param {Array}  messages   — [{role, content}, ...]
 * @param {object} opts       — { maxTokens, temperature, timeout }
 * @returns {string}          — raw text content (think-tags stripped)
 */
export async function callProvider(baseUrl, apiKey, model, messages, opts = {}) {
  if (!apiKey) throw new Error(`[Provider] No API key set for ${baseUrl} — check your .env`);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
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
  } catch (fetchErr) {
    // Network-level failure (DNS, timeout, connection refused)
    throw new Error(`[${baseUrl}] Network error — ${fetchErr.message}`);
  }

  if (!res.ok) {
    // Capture full response body for accurate debugging
    const rawBody = await res.text().catch(() => '(unreadable body)');
    let detail = rawBody;
    try {
      const parsed = JSON.parse(rawBody);
      detail = parsed.error?.message || parsed.message || rawBody;
    } catch { /* leave as raw text */ }
    throw new Error(`[${baseUrl}] HTTP ${res.status} model="${model}" — ${detail}`);
  }

  const data = await res.json();
  const raw  = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`[${baseUrl}] Empty/null content in response for model "${model}"`);

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
