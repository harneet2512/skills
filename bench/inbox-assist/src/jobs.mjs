// Durable job queue on the shared database. Handlers acknowledge platforms only
// after a job row exists; workers on every instance claim jobs atomically, hold
// a lease they renew while working, and retry with backoff and jitter until the
// job dies into the dead-letter state.
//
// Errors thrown by handlers may carry:
//   retryable: false   -> dead immediately (permanent failure)
//   retryAfterMs: n    -> next attempt no earlier than n ms (provider Retry-After)
import { now } from './db.mjs';

export function enqueue(db, { kind, teamId, payload = {}, cid, coalesceKey = null, runAt = now(), maxAttempts }) {
  const r = db.prepare(`INSERT OR IGNORE INTO jobs (kind, team_id, payload, coalesce_key, status, max_attempts, run_at, cid, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`).run(kind, teamId, JSON.stringify(payload), coalesceKey, maxAttempts, runAt, cid, now(), now());
  return r.changes === 1;
}

// One statement: SQLite takes the write lock before evaluating the subquery, so
// two workers can never claim the same row. Expired leases are reclaimed.
//
// Slow kinds (LLM drafts) are a separate lane (REL-06, TEN-09): a worker only
// takes one while allowSlow (it has a free slow slot; the rest stay for sends
// and posts), and never for a tenant that already runs tenantSlowCap of that
// kind anywhere in the cluster, so one tenant's burst cannot hold every slot.
export function claim(db, workerId, leaseMs, { slowKinds = [], allowSlow = true, tenantSlowCap = 0 } = {}) {
  const t = now();
  const row = db.prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, locked_by = ?, updated_at = ?
    WHERE id = (SELECT id FROM jobs j WHERE ((status = 'queued' AND run_at <= ?) OR (status = 'running' AND lease_until < ?))
      AND (j.kind NOT IN (SELECT value FROM json_each(?))
        OR (? AND (? = 0 OR (SELECT count(*) FROM jobs r WHERE r.team_id = j.team_id AND r.kind = j.kind AND r.status = 'running' AND r.lease_until >= ?) < ?)))
      ORDER BY run_at, id LIMIT 1)
    RETURNING *`).get(t + leaseMs, workerId, t, t, t, JSON.stringify(slowKinds), allowSlow ? 1 : 0, tenantSlowCap, t, tenantSlowCap);
  return row ? { ...row, payload: JSON.parse(row.payload) } : null;
}

// Shutdown: jobs this worker still holds become claimable now instead of after
// the lease runs out. Their next attempt reconciles anything half done.
export function releaseLeases(db, workerId) {
  return db.prepare("UPDATE jobs SET lease_until = 0 WHERE locked_by = ? AND status = 'running'").run(workerId).changes;
}

// Fenced by (locked_by, attempts): a worker whose lease was taken over cannot touch the row.
const fence = 'id = ? AND locked_by = ? AND attempts = ? AND status = \'running\'';

export function renewLease(db, job, leaseMs) {
  return db.prepare(`UPDATE jobs SET lease_until = ? WHERE ${fence}`).run(now() + leaseMs, job.id, job.locked_by, job.attempts).changes === 1;
}

export function complete(db, job) {
  return db.prepare(`UPDATE jobs SET status = 'done', lease_until = NULL, updated_at = ? WHERE ${fence}`).run(now(), job.id, job.locked_by, job.attempts).changes === 1;
}

export function backoffMs(attempt, baseMs, capMs = 5 * 60_000) {
  const exp = Math.min(capMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + Math.random() * (exp / 2));
}

// Returns 'retry' or 'dead'.
export function fail(db, job, err, baseMs) {
  const message = String(err?.message ?? err).slice(0, 500);
  const dead = err?.retryable === false || job.attempts >= job.max_attempts;
  if (dead) {
    db.prepare(`UPDATE jobs SET status = 'dead', last_error = ?, lease_until = NULL, updated_at = ? WHERE ${fence}`).run(message, now(), job.id, job.locked_by, job.attempts);
    return 'dead';
  }
  const delay = err?.retryAfterMs != null ? err.retryAfterMs + Math.round(Math.random() * 250) : backoffMs(job.attempts, baseMs);
  try {
    db.prepare(`UPDATE jobs SET status = 'queued', run_at = ?, last_error = ?, lease_until = NULL, updated_at = ? WHERE ${fence}`).run(now() + delay, message, now(), job.id, job.locked_by, job.attempts);
  } catch (e) {
    // A newer queued job with the same coalesce key already covers this work.
    if (!/UNIQUE/.test(e.message)) throw e;
    complete(db, job);
  }
  return 'retry';
}

// handlers: { [kind]: { run(job), onDead?(job, err) } }
// Nothing a handler, onDead or the bookkeeping throws may escape: an unhandled
// rejection would take the whole instance down.
export function startWorker({ db, handlers, log, workerId, config, slowKinds = [] }) {
  const { WORKER_POLL_MS: pollMs, JOB_LEASE_MS: leaseMs, WORKER_CONCURRENCY: concurrency, JOB_BACKOFF_BASE_MS: baseMs } = config;
  const slowSlots = config.WORKER_DRAFT_SLOTS ?? concurrency;
  const tenantSlowCap = config.TENANT_MAX_RUNNING_DRAFTS ?? 0;
  let inFlight = 0;
  let slowInFlight = 0;
  let stopping = false;
  let lastTick = now();

  async function run(job) {
    const jlog = log.child({ cid: job.cid, job: job.id, kind: job.kind, team: job.team_id, attempt: job.attempts });
    const handler = handlers[job.kind];
    const heartbeat = setInterval(() => {
      try { if (!renewLease(db, job, leaseMs)) jlog.warn('job.lease_lost'); } catch (err) { jlog.error('job.renew_failed', { error: err.message }); }
    }, Math.max(100, Math.floor(leaseMs / 3)));
    let failure = null;
    try {
      if (!handler) throw Object.assign(new Error(`no handler for ${job.kind}`), { retryable: false });
      if (job.attempts > job.max_attempts) throw Object.assign(new Error('attempts exhausted after lease expiry'), { retryable: false });
      await handler.run(job, jlog);
    } catch (err) {
      failure = err ?? new Error('handler threw nothing');
    } finally {
      clearInterval(heartbeat);
    }
    if (!failure) {
      // The work is done; if recording that fails, the lease runs out and the
      // job runs again, which handlers tolerate (they check state first).
      try { complete(db, job); jlog.info('job.done'); } catch (err) { jlog.error('job.complete_failed', { error: err.message }); }
      return;
    }
    let outcome;
    try { outcome = fail(db, job, failure, baseMs); } catch (err) {
      return jlog.error('job.fail_failed', { error: err.message, cause: String(failure?.message ?? failure).slice(0, 200) });
    }
    jlog[outcome === 'dead' ? 'error' : 'warn'](`job.${outcome}`, { error: String(failure?.message ?? failure).slice(0, 200), retryAfterMs: failure?.retryAfterMs });
    if (outcome === 'dead' && handler?.onDead) {
      try { await handler.onDead(job, failure, jlog); } catch (err) { jlog.error('job.on_dead_failed', { error: String(err?.message ?? err).slice(0, 200) }); }
    }
  }

  function tick() {
    lastTick = now();
    while (!stopping && inFlight < concurrency) {
      let job;
      try { job = claim(db, workerId, leaseMs, { slowKinds, allowSlow: slowInFlight < slowSlots, tenantSlowCap }); } catch (err) { log.error('job.claim_failed', { error: err.message }); return; }
      if (!job) return;
      const slow = slowKinds.includes(job.kind);
      inFlight += 1;
      if (slow) slowInFlight += 1;
      run(job)
        .catch((err) => log.error('job.crashed', { job: job.id, error: String(err?.message ?? err).slice(0, 200) }))
        .finally(() => { inFlight -= 1; if (slow) slowInFlight -= 1; });
    }
  }

  const timer = setInterval(tick, pollMs);
  return {
    health: () => ({ lastTickMsAgo: now() - lastTick, inFlight }),
    async stop(graceMs = 5000) {
      stopping = true;
      clearInterval(timer);
      const deadline = now() + graceMs;
      while (inFlight > 0 && now() < deadline) await new Promise((r) => setTimeout(r, 20));
      if (inFlight > 0) {
        try { releaseLeases(db, workerId); } catch (err) { log.error('job.release_failed', { error: err.message }); }
      }
      return inFlight;
    },
  };
}
