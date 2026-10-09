// Model client that shells out to the Claude Code CLI in print mode.
// Interface shared by every client the harness accepts:
//   createClient({ model, timeoutMs }) -> { name, model, complete({ system, prompt, maxTokens, signal }) }
//   complete() resolves to { text, costUsd, models, latencyMs } and rejects on any failure.
//
// Isolation: runs in an empty temp directory with tools disabled, no settings
// sources and no session persistence, so the repo's CLAUDE.md, hooks and MCP
// servers cannot leak into a generation or a judgment.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EMPTY_CWD = mkdtempSync(join(tmpdir(), 'evals-claude-'));

export function createClient({ model = 'haiku', timeoutMs = 120_000, bin = process.env.CLAUDE_BIN || 'claude' } = {}) {
  return {
    name: 'claude-cli',
    model,
    complete({ system, prompt, maxTokens, signal } = {}) {
      return new Promise((resolve, reject) => {
        const args = ['-p', '--model', model, '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', ''];
        if (system) args.push('--system-prompt', system);
        const env = { ...process.env };
        if (maxTokens) env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(maxTokens);
        const started = Date.now();
        const child = spawn(bin, args, { cwd: EMPTY_CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '', err = '', settled = false;
        const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
        const kill = (why) => { child.kill('SIGKILL'); finish(reject, new Error(why)); };
        const timer = setTimeout(() => kill(`claude-cli timed out after ${timeoutMs} ms`), timeoutMs);
        signal?.addEventListener?.('abort', () => kill('claude-cli aborted'), { once: true });
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (e) => finish(reject, e));
        child.on('close', (code) => {
          if (settled) return;
          let j;
          try { j = JSON.parse(out); } catch {
            return finish(reject, new Error(`claude-cli exit ${code}, unparseable output: ${(out || err).slice(0, 300)}`));
          }
          if (j.is_error || j.subtype !== 'success' || typeof j.result !== 'string') {
            return finish(reject, new Error(`claude-cli error: ${j.subtype} ${String(j.result).slice(0, 300)}`));
          }
          finish(resolve, {
            text: j.result,
            costUsd: Number(j.total_cost_usd) || 0,
            models: Object.keys(j.modelUsage || {}),
            stopReason: j.stop_reason,
            latencyMs: Date.now() - started,
          });
        });
        child.stdin.end(prompt ?? '');
      });
    },
  };
}
