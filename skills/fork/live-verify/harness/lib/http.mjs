// Small HTTP plumbing shared by every stand-in: a server that tracks its sockets
// (so teardown never leaves a port open), body reading, and fault application.
import http from 'node:http';

export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function send(res, status, body, headers = {}) {
  if (res.writableEnded || res.destroyed) return;
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain', ...headers });
  res.end(payload);
}

export async function startServer(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => send(res, 500, { error: String(err?.message ?? err) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Applies a fault rule (from Faults.take) around a side-effecting operation.
// perform() executes the real behaviour and returns { status, body, headers }.
// errorBody(status) builds the provider-shaped error body for status faults.
// Returns the fault outcome label recorded with the call.
export async function applyFault({ fault, req, res, perform, errorBody }) {
  if (!fault) {
    const r = await perform();
    send(res, r.status, r.body, r.headers);
    return { outcome: 'ok', status: r.status, result: r.body };
  }
  fault.onHit?.(fault);
  switch (fault.kind) {
    case 'status': {
      const headers = { ...(fault.headers ?? {}) };
      if (fault.retryAfter != null) headers['retry-after'] = String(fault.retryAfter);
      send(res, fault.status, fault.body ?? errorBody(fault.status), headers);
      return { outcome: `status:${fault.status}`, status: fault.status };
    }
    case 'delay': {
      await sleep(fault.delayMs ?? 1000);
      const r = await perform();
      send(res, r.status, r.body, r.headers);
      return { outcome: `delay:${fault.delayMs}`, status: r.status, result: r.body };
    }
    case 'slowResponse': {
      // The effect and the response body are computed now, delivered late:
      // the caller acts on a snapshot that is already stale when it arrives.
      const r = await perform();
      await sleep(fault.delayMs ?? 1000);
      send(res, r.status, r.body, r.headers);
      return { outcome: `slowResponse:${fault.delayMs}`, status: r.status, result: r.body };
    }
    case 'hang': {
      // Holds the request open without performing the effect, until the
      // client gives up, the process holding it dies, or hangMs elapses.
      await new Promise((resolve) => {
        const t = fault.hangMs ? setTimeout(resolve, fault.hangMs) : null;
        req.socket.once('close', () => { if (t) clearTimeout(t); resolve(); });
      });
      req.socket.destroy();
      return { outcome: 'hang', status: null };
    }
    case 'reset': {
      req.socket.destroy();
      return { outcome: 'reset', status: null };
    }
    case 'truncate': {
      // The effect happens and a 200 starts, but the body stops halfway:
      // Content-Length promises more bytes than ever arrive.
      const r = await perform();
      const payload = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      res.writeHead(r.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) });
      res.write(payload.subarray(0, Math.floor(payload.length / 2)));
      await sleep(fault.stallMs ?? 50);
      req.socket.destroy();
      return { outcome: 'truncate', status: r.status, result: r.body };
    }
    case 'timeoutAfterSuccess': {
      // The effect happens, the caller never learns it did.
      const r = await perform();
      if (fault.hangMs) await sleep(fault.hangMs);
      req.socket.destroy();
      return { outcome: 'timeoutAfterSuccess', status: null, result: r.body };
    }
    default:
      throw new Error(`unknown fault kind ${fault.kind}`);
  }
}
