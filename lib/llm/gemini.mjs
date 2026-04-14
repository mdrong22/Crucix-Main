// Google Gemini Provider — raw fetch, no SDK

import { LLMProvider } from './provider.mjs';

export class GeminiProvider extends LLMProvider {
  constructor(config) {
    super(config);
    this.name          = 'gemini';
    this.apiKey        = config.apiKey;
    this.model         = config.model || 'gemini-2.0-flash';
    this.fallbackModel = config.fallbackModel || null;
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

  // ── Public: try primary → fallback on any error ────────────────────────────
  async complete(systemPrompt, userMessage, opts = {}, activateWeb = false) {
    try {
      return await this._tryModel(this.model, systemPrompt, userMessage, opts, activateWeb);
    } catch (err) {
      if (this.fallbackModel) {
        console.warn(`[Gemini] ⚠ Primary model (${this.model}) failed: ${err.message} — retrying with fallback: ${this.fallbackModel}`);
        return await this._tryModel(this.fallbackModel, systemPrompt, userMessage, opts, activateWeb);
      }
      throw err;
    }
  }
}
