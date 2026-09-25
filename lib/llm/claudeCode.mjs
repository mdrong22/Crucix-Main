// claudeCode.mjs — Provider that runs the analyst on your Claude Code SUBSCRIPTION, not API credits.
//
// Instead of calling api.anthropic.com (pay-per-token), this shells out to the `claude` CLI in
// headless mode (`claude -p`). That runs under whatever account is logged in via `claude login`
// (your Max/Pro subscription), so it consumes your Claude Code quota — no API credits billed.
//
// Requirements on the host running server.mjs:
//   • `claude` CLI installed and on PATH (or set CLAUDE_CLI_BIN to its full path).
//   • Logged in with `claude login` (the subscription account).
//   • ANTHROPIC_API_KEY is intentionally stripped from the child env so the CLI never falls back
//     to paid API billing.
//
// Matches the provider interface used elsewhere: complete(system, user, opts) → { text, usage, model }.

import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

export class ClaudeCodeProvider {
  constructor(config = {}) {
    this.name  = 'claude-code';
    this.model = config.model || 'sonnet';              // 'sonnet' (smart) | 'haiku' (lighter quota) | full id
    this.bin   = config.bin || process.env.CLAUDE_CLI_BIN || 'claude';
    this.timeoutMs = config.timeout || 120000;
    // Tools the headless model must NOT use — it's a pure text→JSON task, never an agent.
    this.disallowed = 'Bash,Edit,Write,Read,Glob,Grep,WebFetch,WebSearch,NotebookEdit,TodoWrite,Task';
  }

  // Assumes the CLI is installed + logged in; a runtime failure falls back to the configured fallback.
  get isConfigured() { return true; }

  _flatten(userMessage) {
    if (Array.isArray(userMessage)) {
      return userMessage.filter(m => m.role !== 'system')
        .map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n\n');
    }
    return String(userMessage);
  }

  async complete(systemPrompt, userMessage, opts = {}) {
    const userText = this._flatten(userMessage);
    const model    = opts.model || this.model;

    // System prompt via a temp file (--system-prompt-file) so no special chars hit the shell.
    const sysFile = join(tmpdir(), `crucix-sys-${randomUUID()}.txt`);
    writeFileSync(sysFile, systemPrompt, 'utf8');

    // Force subscription (OAuth) auth — never bill API credits.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    // Simple, space-free tokens except the quoted temp-file path → shell-safe on Windows + Unix.
    const cmd = `${this.bin} -p --output-format json --model ${model} --system-prompt-file "${sysFile}" --disallowedTools ${this.disallowed}`;

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(cmd, { shell: true, env, windowsHide: true });
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('claude CLI timed out')); },
          opts.timeout || this.timeoutMs);
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        child.on('error', e => { clearTimeout(timer); reject(new Error(`claude CLI spawn failed: ${e.message} (is '${this.bin}' installed + logged in?)`)); });
        child.on('close', code => {
          clearTimeout(timer);
          if (code !== 0) return reject(new Error(`claude CLI exited ${code}: ${(err || out).slice(0, 200)}`));
          let j;
          try { j = JSON.parse(out); }
          catch (e) { return reject(new Error(`claude CLI JSON parse failed: ${e.message} | ${out.slice(0, 160)}`)); }
          if (j.is_error) return reject(new Error(`claude CLI error: ${String(j.result || '').slice(0, 160)}`));
          resolve({
            text:  j.result ?? '',
            usage: { inputTokens: j.usage?.input_tokens || 0, outputTokens: j.usage?.output_tokens || 0 },
            model: Object.keys(j.modelUsage || {})[0] || model,
          });
        });
        child.stdin.write(userText);
        child.stdin.end();
      });
    } finally {
      try { unlinkSync(sysFile); } catch {}
    }
  }
}
