// Google Gemini Provider — raw fetch, no SDK

import { LLMProvider } from './provider.mjs';

export class GeminiProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name          = 'gemini';
    this.apiKey        = config.apiKey;
    // gemini-2.0-flash deprecated June 1 2026 — default to 2.5-flash-lite (15 RPM, 250k TPM, 1M ctx)
    this.model         = config.model         || 'gemini-2.5-flash-lite';
    this.fallbackModel = config.fallbackModel || 'gemini-2.5-flash-lite'; // no same-key fallback by default
  }

  get isConfigured() { return !!this.apiKey; }

  // ── Internal: attempt a single model call ──────────────────────────────────
  async _tryModel(model, systemPrompt, userMessage, opts = {}, activateWeb = false) {
    const payload = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userMessage }] }],
      generationConfig: {
        maxOutputTokens: opts.maxTokens || 4096,
        temperature: opts.temperature || 0.7,
      },
    };
    if (activateWeb) {
      payload.tools = [{ google_search: {} }];
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(opts.timeout || 60000),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Gemini API ${res.status}: ${err.substring(0, 200)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return {
      text,
      usage: {
        inputTokens:  data.usageMetadata?.promptTokenCount     || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
      model,
    };
  }

  _isRateLimit(msg = '') {
    return msg.includes('429') || /quota|rate.?limit/i.test(msg);
  }

  // ── Public: try primary → fallback on non-quota errors ─────────────────────
  // On 429 / quota errors: throw immediately — fallbackModel shares the same
  // API key and quota bucket, so retrying it burns a second slot for a guaranteed
  // 429. Tag the error with isRateLimit=true so the caller (generateLLMIdeas)
  // can route to a cross-API fallback (Groq) instead.
  //
  // On non-rate-limit errors (503, timeout, malformed response): try fallbackModel
  // first (different model, same key — may succeed), then throw if that also fails.
  async complete(systemPrompt, userMessage, opts = {}, activateWeb = false) {
    try {
      return await this._tryModel(this.model, systemPrompt, userMessage, opts, activateWeb);
    } catch (err) {
      if (this._isRateLimit(err.message)) {
        // Tag so caller knows to route to cross-API fallback, not retry same key
        err.isRateLimit = true;
        console.warn(`[Gemini] ⚠ Rate limited on ${this.model} — throwing to cross-API fallback (Groq).`);
        throw err;
      }

      // Non-rate-limit failure (503, timeout, etc.) — try the fallback model
      if (this.fallbackModel && this.fallbackModel !== this.model) {
        console.warn(`[Gemini] ⚠ Primary (${this.model}) failed: ${err.message} — retrying with ${this.fallbackModel}`);
        return await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts, activateWeb);
      }

      // No fallback available or same model — propagate
      throw err;
    }
  }
}
