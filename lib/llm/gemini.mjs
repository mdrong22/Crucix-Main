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
  // On 429 / quota errors: DO NOT retry with the same API key — the fallback
  // model shares the same quota bucket and will also 429 immediately, wasting
  // an extra call. Throw immediately so the caller can route to a cross-API
  // fallback (Groq, etc.) instead of burning two quota slots for one failure.
  async complete(systemPrompt, userMessage, opts = {}, activateWeb = false) {
    try {
      return await this._tryModel(this.model, systemPrompt, userMessage, opts, activateWeb);
    } catch (err) {
      if (this._isRateLimit(err.message)) {
        // Tag the error so callers can distinguish quota from transient failures
        err.isRateLimit = true;
        console.warn(`[Gemini] ⚠ Rate limited on ${this.model} — skipping same-key fallback, routing to cross-API fallback.`);
        if (this.fallbackModel) {
          console.warn(`[Gemini] ⚠ Primary (${this.model}) failed: ${err.message} — retrying with ${this.fallbackModel}`);
          return await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts, activateWeb);
        }
        throw err;
      }
    }
  }
}
