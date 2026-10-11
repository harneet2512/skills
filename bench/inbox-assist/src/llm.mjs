// LLM providers behind one interface: complete({ system, prompt, maxTokens }) -> string.
// Throws LlmError with `transient` set when a retry may succeed.
import { spawn } from 'node:child_process';

export class LlmError extends Error {
  constructor(message, { transient, retryAfterMs }) {
    super(message);
    Object.assign(this, { transient, retryAfterMs });
  }
}

const MAX_RETRY_AFTER_MS = 5 * 60_000;

// Retry-After in seconds (Anthropic sends it on 429 and 529), capped so a bad
// header cannot park a job for hours.
function retryAfterMs(res) {
  const secs = Number(res.headers.get('retry-after'));
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs * 1000, MAX_RETRY_AFTER_MS) : undefined;
}

export function anthropicProvider({ baseUrl, apiKey, model, timeoutMs, userAgent }) {
  return {
    name: 'anthropic',
    async complete({ system, prompt, maxTokens }) {
      let res;
      try {
        res = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', 'user-agent': userAgent },
          body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new LlmError(`llm transport ${err.cause?.code ?? err.name}`, { transient: true });
      }
      const json = await res.json().catch(() => null);
      // A 200 whose body was cut short is a transient failure, not an empty answer.
      if (res.ok && json == null) throw new LlmError('llm 200 with unreadable body', { transient: true });
      if (!res.ok) throw new LlmError(`llm ${res.status} ${json?.error?.type ?? ''}`, { transient: res.status === 429 || res.status >= 500, retryAfterMs: retryAfterMs(res) });
      return (json?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    },
  };
}

// Real-model mode for live runs: the Claude Code CLI in print mode, no tools.
// The app's own Anthropic settings are not passed on: the CLI uses its own login.
export function claudeCliProvider({ model = 'haiku', timeoutMs }) {
  const { ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, ...env } = process.env;
  return {
    name: 'claude-cli',
    complete({ system, prompt }) {
      return new Promise((resolve, reject) => {
        const child = spawn('claude', ['-p', '--model', model, '--system-prompt', system, '--tools', '', '--no-session-persistence'], { stdio: ['pipe', 'pipe', 'pipe'], env });
        let out = '';
        let err = '';
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new LlmError('claude cli timeout', { transient: true })); }, timeoutMs);
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        child.on('error', (spawnErr) => { clearTimeout(timer); reject(new LlmError(`claude cli ${spawnErr.code}`, { transient: false })); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve(out);
          else reject(new LlmError(`claude cli exited ${code}: ${err.trim().slice(0, 120)}`, { transient: true }));
        });
        child.stdin.end(prompt);
      });
    },
  };
}

export function createLlm(config, userAgent) {
  return config.LLM_PROVIDER === 'claude-cli'
    ? claudeCliProvider({ model: 'haiku', timeoutMs: config.LLM_TIMEOUT_MS })
    : anthropicProvider({ baseUrl: config.ANTHROPIC_BASE_URL, apiKey: config.ANTHROPIC_API_KEY, model: config.LLM_MODEL, timeoutMs: config.LLM_TIMEOUT_MS, userAgent });
}
