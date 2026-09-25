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
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Neutral working directory so the CLI does NOT load this project's .claude config, .mcp.json,
// CLAUDE.md, hooks, or plugins — the analyst is a self-contained text→JSON task. This cuts the
// per-call token overhead and removes a whole class of failure (MCP servers that need auth, etc.).
const AGENT_CWD = join(tmpdir(), 'crucix-agent');
try { if (!existsSync(AGENT_CWD)) mkdirSync(AGENT_CWD, { recursive: true }); } catch {}

export class ClaudeCodeProvider {
  constructor(config = {}) {
    this.name  = 'claude-code';
    this.model = config.model || 'sonnet';              // 'sonnet' (smart) | 'haiku' (lighter quota) | full id
    this.bin   = config.bin || process.env.CLAUDE_CLI_BIN || 'claude';
    this.timeoutMs = config.timeout || 120000;
    this.cwd   = config.cwd || AGENT_CWD;
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
    // --strict-mcp-config with no --mcp-config disables all MCP servers (none are needed here).
    const cmd = `${this.bin} -p --output-format json --model ${model} --system-prompt-file "${sysFile}" --disallowedTools ${this.disallowed} --strict-mcp-config`;

    try {
      return await new Promise((resolve, reject) => {
        const child = spawn(cmd, { shell: true, env, windowsHide: true, cwd: this.cwd });
        let out = '', err = '';
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('claude CLI timed out')); },
          opts.timeout || this.timeoutMs);
        child.stdout.on('data', d => out += d);
        child.stderr.on('data', d => err += d);
        child.on('error', e => { clearTimeout(timer); reject(new Error(`claude CLI spawn failed: ${e.message} (is '${this.bin}' installed + logged in?)`)); });
        child.on('close', code => {
          clearTimeout(timer);
          // Parse the result envelope FIRST — the human-readable reason lives in `result`, which a
          // raw slice of stdout would cut off. Surface it in full so failures are diagnosable.
          let j = null;
          try { j = JSON.parse(out); } catch {}
          const reason = String(j?.result || err || out || '').trim();
          const noApiCall = j && (j.duration_api_ms === 0) && (j.usage?.input_tokens === 0);

          if (j && (j.is_error || code !== 0)) {
            const low = reason.toLowerCase();
            if (low.includes('usage limit') || low.includes('rate limit') || low.includes('quota') || low.includes('exceeded'))
              return reject(new Error(`Claude Code USAGE LIMIT: ${reason.slice(0, 220)}`));
            if (low.includes('login') || low.includes('auth') || low.includes('api key') || low.includes('unauthorized') || low.includes('credentials') || noApiCall)
              return reject(new Error(`Claude Code AUTH problem (run 'claude login' on this machine): ${reason.slice(0, 220)}`));
            return reject(new Error(`claude CLI failed (exit ${code}): ${reason.slice(0, 220)}`));
          }
          if (!j) return reject(new Error(`claude CLI: unparseable output — ${(err || out).slice(0, 200)}`));
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
