// LLM stand-in: an Anthropic Messages API compatible endpoint (POST /v1/messages)
// with scripted replies. Rules are checked newest first; the first whose
// `when(request)` matches produces the reply text. Shapes follow
// https://docs.anthropic.com/en/api/messages and https://docs.anthropic.com/en/api/errors
import crypto from 'node:crypto';
import { startServer, readBody, applyFault, send } from '../lib/http.mjs';
import { Faults } from '../lib/faults.mjs';
import { Recorder } from '../lib/recorder.mjs';

const ERROR_TYPES = { 400: 'invalid_request_error', 401: 'authentication_error', 429: 'rate_limit_error', 500: 'api_error', 529: 'overloaded_error' };
const errorBody = (status, message = 'stand-in fault') => ({ type: 'error', error: { type: ERROR_TYPES[status] ?? 'api_error', message } });

const textOf = (content) => (typeof content === 'string' ? content : (content ?? []).map((b) => b.text ?? '').join(''));
export const estimateTokens = (text) => Math.ceil(text.length / 4);

export async function startLlm({ apiKey, defaultReply }) {
  const recorder = new Recorder('llm');
  const faults = new Faults();
  let rules = [];

  const server = await startServer(async (req, res) => {
    const raw = (await readBody(req)).toString('utf8');
    const call = { method: 'messages', client: req.headers['user-agent'] ?? '', startedAt: Date.now() };
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/v1/messages') {
      recorder.record({ ...call, outcome: 'not_found', status: 404 });
      return send(res, 404, errorBody(404, 'Not found'));
    }
    if (req.headers['x-api-key'] !== apiKey) {
      recorder.record({ ...call, outcome: 'unauthenticated', status: 401 });
      return send(res, 401, errorBody(401, 'invalid x-api-key'));
    }
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, errorBody(400, 'invalid JSON')); }
    if (!req.headers['anthropic-version'] || !body.model || !Number.isInteger(body.max_tokens) || !Array.isArray(body.messages) || body.messages.length === 0) {
      recorder.record({ ...call, outcome: 'invalid_request', status: 400 });
      return send(res, 400, errorBody(400, 'model, max_tokens, messages and anthropic-version header are required'));
    }
    const request = {
      model: body.model, maxTokens: body.max_tokens, system: textOf(body.system),
      prompt: body.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n'),
    };
    request.inputTokens = estimateTokens(request.system + request.prompt);
    Object.assign(call, { model: request.model, inputTokens: request.inputTokens, promptChars: request.prompt.length });
    const rule = rules.find((r) => r.when(request));
    const fault = faults.take('messages', { ...call, request });
    const r = await applyFault({
      fault, req, res, errorBody,
      perform: async () => {
        const text = rule ? (typeof rule.reply === 'function' ? rule.reply(request) : rule.reply) : defaultReply(request);
        return {
          status: 200,
          body: {
            id: `msg_${crypto.randomBytes(12).toString('hex')}`, type: 'message', role: 'assistant', model: body.model,
            content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
            usage: { input_tokens: request.inputTokens, output_tokens: estimateTokens(text) },
          },
        };
      },
    });
    recorder.record({ ...call, request, rule: rule?.name ?? 'default', outcome: r.outcome, status: r.status, durationMs: Date.now() - call.startedAt });
  });

  return {
    name: 'llm',
    url: server.url,
    faults,
    // script({ name, when(request) -> bool, reply: string | (request) -> string })
    script(rule) { rules.unshift({ when: () => true, ...rule }); },
    calls: (filter) => recorder.find(filter),
    reset() { faults.reset(); rules = []; },
    close: () => server.close(),
  };
}
