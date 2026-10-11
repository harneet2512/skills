// Inbound side: a Gmail push becomes a mailbox sync, each new message becomes a
// draft job, and each draft becomes a Slack DM with reply options.
import crypto from 'node:crypto';
import { tx } from './db.mjs';
import { enqueue } from './jobs.mjs';
import { getTenant, getTenantByMailbox, advanceHistoryId } from './tenants.mjs';
import { skipReason } from './mail.mjs';
import { draftReplies } from './draft.mjs';
import * as suggestions from './suggestions.mjs';
import { suggestionMessage, fallbackMessage } from './slack.mjs';

export function createInbox({ db, sealer, config, gmail, slack, llm }) {
  const maxAttempts = config.JOB_MAX_ATTEMPTS;

  // COST-13: drafts started per tenant per fixed window. One atomic statement,
  // so instances cannot both take the last unit. Retries of a failed LLM call
  // count. Refusals keep counting past the cap, so the first refusal in a window
  // is known: only that one posts a notice (a mail bomb must not become a Slack flood).
  // Returns 'ok', 'first_refusal' or 'refused'.
  function takeDraftBudget(teamId) {
    const windowMs = config.DRAFT_BUDGET_WINDOW_MS;
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const cap = config.DRAFT_BUDGET_PER_WINDOW;
    db.prepare('DELETE FROM draft_usage WHERE team_id = ? AND window_start < ?').run(teamId, windowStart);
    const { drafts } = db.prepare(`INSERT INTO draft_usage (team_id, window_start, drafts) VALUES (?, ?, 1)
      ON CONFLICT (team_id, window_start) DO UPDATE SET drafts = drafts + 1 RETURNING drafts`).get(teamId, windowStart);
    return drafts <= cap ? 'ok' : drafts === cap + 1 ? 'first_refusal' : 'refused';
  }

  // REL-07: chat.postMessage has no idempotency key, so every post carries
  // metadata naming what it is. A retry (the previous attempt may have posted
  // and lost the answer, or crashed before recording it) first looks for that
  // message in the DM. Slack only returns metadata with include_all_metadata.
  const POST_EVENT = 'inbox_assist_post';
  async function postOnce(tenant, job, key, message, sinceMs, log) {
    if (job.attempts > 1) {
      const channel = await slack.openDm(tenant.botToken, tenant.slack_user_id);
      const { messages = [] } = await slack.history(tenant.botToken, { channel, oldest: String(Math.floor(sinceMs / 1000) - 60), limit: '200', include_all_metadata: 'true' })
        .catch((err) => { if (err.code === 'channel_not_found') return {}; throw err; }); // no DM yet: nothing was posted
      const hit = messages.find((m) => m.metadata?.event_type === POST_EVENT && m.metadata?.event_payload?.key === key);
      if (hit) { log.info('post.reconciled', { key, ts: hit.ts }); return { channel, ts: hit.ts }; }
    }
    const res = await slack.postMessage(tenant.botToken, { channel: tenant.slack_user_id, ...message, metadata: { event_type: POST_EVENT, event_payload: { key } } });
    return { channel: res.channel, ts: res.ts };
  }

  // Called from the push endpoint: cheap, no outbound calls, so the ack is fast.
  function onPush({ mailbox, historyId, pubsubMessageId }, log) {
    const tenant = getTenantByMailbox(db, sealer, mailbox);
    if (!tenant) { log.warn('push.unknown_mailbox', { pubsubMessageId }); return 'ignored'; }
    if (tenant.last_history_id != null && historyId <= tenant.last_history_id) {
      log.info('push.stale', { team: tenant.team_id, historyId, stored: tenant.last_history_id, pubsubMessageId });
      return 'stale';
    }
    const cid = `c_${crypto.randomUUID()}`;
    // Coalesced: while a sync for this tenant is still queued, more pushes add nothing.
    const queued = enqueue(db, { kind: 'sync_mailbox', teamId: tenant.team_id, payload: { historyId }, cid, coalesceKey: `sync:${tenant.team_id}`, maxAttempts });
    log.info('push.received', { cid, team: tenant.team_id, historyId, pubsubMessageId, coalesced: !queued });
    return 'queued';
  }

  async function syncMailbox(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    if (!tenant) return log.info('sync.tenant_inactive');
    if (tenant.last_history_id == null) {
      advanceHistoryId(db, tenant.team_id, job.payload.historyId);
      return log.info('sync.baseline', { historyId: job.payload.historyId });
    }
    let result;
    try {
      result = await gmail.history(tenant.gmailToken, tenant.last_history_id);
    } catch (err) {
      if (err.status !== 404) throw err;
      // Stored id is older than Gmail keeps: restart from now rather than replay everything.
      const profile = await gmail.profile(tenant.gmailToken);
      advanceHistoryId(db, tenant.team_id, Number(profile.historyId));
      return log.warn('sync.history_expired', { resumedAt: Number(profile.historyId) });
    }
    let fresh = 0;
    for (const m of result.added) {
      tx(db, () => {
        const inserted = db.prepare('INSERT OR IGNORE INTO emails (team_id, gmail_message_id, thread_id, cid, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(tenant.team_id, m.id, m.threadId, job.cid, Date.now()).changes === 1;
        if (inserted) {
          fresh += 1;
          enqueue(db, { kind: 'draft_email', teamId: tenant.team_id, payload: { gmailMessageId: m.id }, cid: job.cid, maxAttempts });
        }
      });
    }
    advanceHistoryId(db, tenant.team_id, result.historyId);
    log.info('sync.done', { seen: result.added.length, fresh, historyId: result.historyId });
  }

  async function draftEmail(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    if (!tenant) return log.info('draft.tenant_inactive');
    const { gmailMessageId } = job.payload;
    if (suggestions.getByEmail(db, tenant.team_id, gmailMessageId)) return log.info('draft.already_exists');
    const email = await gmail.message(tenant.gmailToken, gmailMessageId);
    const reason = skipReason(email, tenant.mailbox);
    if (reason) {
      suggestions.recordOutcome(db, { teamId: tenant.team_id, gmailMessageId, sender: email.sender, outcome: 'skipped', detail: reason, cid: job.cid });
      return log.info('draft.skipped', { gmailMessageId, reason });
    }
    const threadMsgs = await gmail.thread(tenant.gmailToken, email.threadId);
    const thread = { subject: email.subject, messages: threadMsgs.map((m) => ({ from: m.from, date: m.date, text: m.text })) };
    const budget = takeDraftBudget(tenant.team_id);
    if (budget !== 'ok') {
      tx(db, () => {
        if (budget === 'first_refusal') enqueue(db, { kind: 'post_fallback', teamId: tenant.team_id, payload: { sender: email.sender, subject: email.subject, threadId: email.threadId, reason: 'budget' }, cid: job.cid, maxAttempts });
        suggestions.recordOutcome(db, { teamId: tenant.team_id, gmailMessageId, sender: email.sender, outcome: 'draft_failed', detail: 'budget_exceeded', cid: job.cid });
      });
      return log.warn('draft.budget_exceeded', { gmailMessageId, budget: config.DRAFT_BUDGET_PER_WINDOW });
    }
    let options = null;
    try {
      ({ options } = await draftReplies({ thread, aboutUs: tenant.about_us, llm, budgetTokens: config.PROMPT_BUDGET_TOKENS }));
    } catch (err) {
      if (err.transient && job.attempts < config.LLM_MAX_ATTEMPTS) throw err;
      log.warn('draft.failed', { gmailMessageId, code: err.code ?? err.message });
    }
    tx(db, () => {
      if (options) {
        const id = suggestions.create(db, { teamId: tenant.team_id, email, options, cid: job.cid });
        enqueue(db, { kind: 'post_suggestion', teamId: tenant.team_id, payload: { suggestionId: id }, cid: job.cid, maxAttempts });
        suggestions.recordOutcome(db, { teamId: tenant.team_id, gmailMessageId, sender: email.sender, outcome: 'awaiting_user', cid: job.cid });
      } else {
        enqueue(db, { kind: 'post_fallback', teamId: tenant.team_id, payload: { sender: email.sender, subject: email.subject, threadId: email.threadId }, cid: job.cid, maxAttempts });
        suggestions.recordOutcome(db, { teamId: tenant.team_id, gmailMessageId, sender: email.sender, outcome: 'draft_failed', cid: job.cid });
      }
    });
    log.info('draft.done', { gmailMessageId, drafted: Boolean(options) });
  }

  async function postSuggestion(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    const s = suggestions.get(db, job.team_id, job.payload.suggestionId);
    if (!tenant || !s || s.status !== 'drafted') return log.info('post.nothing_to_do', { status: s?.status });
    const res = await postOnce(tenant, job, s.id, suggestionMessage(s), s.created_at, log);
    suggestions.markPosted(db, tenant.team_id, s.id, res.channel, res.ts);
    log.info('post.done', { suggestion: s.id, channel: res.channel, ts: res.ts });
  }

  // The suggestion never reached the user: say so in a plain message (no blocks
  // the post may have been refused for) and record it.
  function postSuggestionDead(job, err, log) {
    const s = suggestions.get(db, job.team_id, job.payload.suggestionId);
    if (!s) return;
    tx(db, () => {
      if (!suggestions.markPostFailed(db, job.team_id, s.id, String(err?.message ?? err).slice(0, 200))) return;
      suggestions.recordOutcome(db, { teamId: job.team_id, gmailMessageId: s.gmail_message_id, sender: s.reply_to, outcome: 'draft_failed', detail: 'post_failed', cid: s.cid });
      enqueue(db, { kind: 'post_fallback', teamId: job.team_id, payload: { sender: s.reply_to, subject: s.subject, threadId: s.thread_id }, cid: s.cid, maxAttempts });
    });
    log.error('post.dead', { suggestion: s.id });
  }

  async function postFallback(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    if (!tenant) return;
    await postOnce(tenant, job, `job:${job.id}`, fallbackMessage(job.payload), job.created_at, log);
    log.info('post.fallback_done');
  }

  return {
    onPush,
    handlers: {
      sync_mailbox: { run: syncMailbox },
      draft_email: {
        run: draftEmail,
        onDead: (job) => suggestions.recordOutcome(db, { teamId: job.team_id, gmailMessageId: job.payload.gmailMessageId, sender: null, outcome: 'draft_failed', detail: 'job_dead', cid: job.cid }),
      },
      post_suggestion: { run: postSuggestion, onDead: postSuggestionDead },
      post_fallback: { run: postFallback, onDead: (job, err, log) => log.error('post.fallback_dead', { error: String(err?.message ?? err).slice(0, 200) }) },
    },
  };
}
