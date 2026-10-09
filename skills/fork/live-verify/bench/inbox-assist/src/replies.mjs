// Outbound side: a user's click or modal submit claims the suggestion, a job
// sends the reply exactly once, and the Slack message is updated to the result.
import { tx } from './db.mjs';
import { enqueue } from './jobs.mjs';
import { getTenant } from './tenants.mjs';
import { buildReply, newMessageId } from './mail.mjs';
import * as suggestions from './suggestions.mjs';
import { resolvedMessage, editModal, EDIT_CALLBACK, MAX_EDIT_CHARS } from './slack.mjs';

const ALREADY = {
  sending: (s) => `Already sent by <@${s.acted_by}>.`,
  sent: (s) => `Already sent by <@${s.acted_by}>.`,
  dismissed: (s) => `Already dismissed by <@${s.acted_by}>.`,
  failed: () => "This reply couldn't be sent. Open the thread in Gmail.",
  drafted: () => 'This suggestion is not ready yet.',
};

export function createReplies({ db, sealer, config, gmail, slack }) {
  const maxAttempts = config.JOB_MAX_ATTEMPTS;
  const notify = (teamId, cid, channel, user, text) =>
    enqueue(db, { kind: 'notify_user', teamId, payload: { channel, user, text }, cid, maxAttempts: 3 });

  // Claims the send for this user; the loser is told who won. Returns { ok, message }.
  function requestSend({ teamId, userId, suggestionId, text, channel }, log) {
    const messageId = newMessageId('inbox-assist.app');
    const result = tx(db, () => {
      const current = suggestions.get(db, teamId, suggestionId);
      if (!current) return { found: false };
      const won = suggestions.claimSend(db, { teamId, id: suggestionId, userId, text, messageId });
      if (won) enqueue(db, { kind: 'send_reply', teamId, payload: { suggestionId }, cid: current.cid, maxAttempts });
      return { found: true, won, current: won ? current : suggestions.get(db, teamId, suggestionId) };
    });
    if (!result.found) return reject(teamId, userId, suggestionId, log);
    const { current } = result;
    if (result.won) {
      log.info('reply.claimed', { cid: current.cid, suggestion: suggestionId, user: userId });
      return { ok: true };
    }
    const message = ALREADY[current.status](current);
    log.info('reply.lost_race', { cid: current.cid, suggestion: suggestionId, user: userId, status: current.status });
    if (channel) notify(teamId, current.cid, channel, userId, message);
    return { ok: false, message };
  }

  // A suggestion id that is not this team's: same answer as "does not exist", logged as a security event.
  function reject(teamId, userId, suggestionId, log) {
    log.warn('security.unknown_suggestion', { team: teamId, user: userId, suggestion: String(suggestionId).slice(0, 80) });
    return { ok: false, message: 'This suggestion is not available.' };
  }

  // Slack interactivity payloads, already signature-verified. teamId comes from
  // the verified payload, never from ids embedded in button values.
  // Returns { body, after? } where after() runs once the ack is sent.
  function onInteraction(payload, log) {
    const teamId = payload.team?.id;
    const userId = payload.user?.id;
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0] ?? {};
      const channel = payload.channel?.id ?? payload.container?.channel_id;
      if (action.action_id?.startsWith('send_option_')) {
        const [suggestionId, idx] = String(action.value).split(':');
        const s = suggestions.get(db, teamId, suggestionId);
        const option = s?.options?.[Number(idx)];
        if (!s || option == null) { const r = reject(teamId, userId, suggestionId, log); notify(teamId, 'c_reject', channel, userId, r.message); return { body: '' }; }
        requestSend({ teamId, userId, suggestionId, text: option, channel }, log);
        return { body: '' };
      }
      if (action.action_id === 'dismiss') {
        const s = suggestions.get(db, teamId, action.value);
        if (!s) { const r = reject(teamId, userId, action.value, log); notify(teamId, 'c_reject', channel, userId, r.message); return { body: '' }; }
        const won = tx(db, () => {
          const ok = suggestions.dismiss(db, teamId, s.id, userId);
          if (ok) {
            enqueue(db, { kind: 'render_suggestion', teamId, payload: { suggestionId: s.id }, cid: s.cid, maxAttempts });
            suggestions.recordOutcome(db, { teamId, gmailMessageId: s.gmail_message_id, sender: s.reply_to, outcome: 'dismissed', actor: userId, cid: s.cid });
          }
          return ok;
        });
        if (!won) {
          const current = suggestions.get(db, teamId, s.id);
          notify(teamId, s.cid, channel, userId, ALREADY[current.status](current));
        }
        log.info('reply.dismiss', { cid: s.cid, suggestion: s.id, won });
        return { body: '' };
      }
      if (action.action_id === 'edit') {
        const s = suggestions.get(db, teamId, action.value);
        if (!s) { const r = reject(teamId, userId, action.value, log); notify(teamId, 'c_reject', channel, userId, r.message); return { body: '' }; }
        if (s.status !== 'posted') { notify(teamId, s.cid, channel, userId, ALREADY[s.status](s)); return { body: '' }; }
        // views.open must use the trigger within 3 s, so it cannot wait for the job
        // queue. It runs right after the ack; if it is lost the user clicks Edit again.
        const tenant = getTenant(db, sealer, teamId);
        if (!tenant) return { body: '' };
        return { body: '', after: () => slack.openView(tenant.botToken, payload.trigger_id, editModal(s)).catch((err) => log.warn('edit.open_failed', { error: err.message })) };
      }
      log.info('interaction.ignored', { action: action.action_id });
      return { body: '' };
    }
    if (payload.type === 'view_submission' && payload.view?.callback_id === EDIT_CALLBACK) {
      const text = String(payload.view.state?.values?.reply?.text?.value ?? '').trim();
      if (!text || text.length > MAX_EDIT_CHARS) return { body: { response_action: 'errors', errors: { reply: `Write between 1 and ${MAX_EDIT_CHARS} characters.` } } };
      const r = requestSend({ teamId, userId, suggestionId: payload.view.private_metadata, text }, log);
      return { body: r.ok ? { response_action: 'clear' } : { response_action: 'errors', errors: { reply: r.message } } };
    }
    return { body: '' };
  }

  async function sendReply(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    const s = suggestions.get(db, job.team_id, job.payload.suggestionId);
    if (!tenant || !s || s.status !== 'sending') return log.info('send.nothing_to_do', { status: s?.status });
    let gmailId = null;
    // Any earlier attempt may have reached Gmail: look for our Message-ID before sending again.
    if (job.attempts > 1) {
      gmailId = await gmail.findSent(tenant.gmailToken, s.thread_id, s.send_message_id);
      if (gmailId) log.info('send.reconciled', { suggestion: s.id, gmailId });
    }
    if (!gmailId) {
      const raw = buildReply({
        from: tenant.mailbox, to: s.reply_to, subject: s.subject, inReplyTo: s.in_reply_to,
        references: s.references_hdr, messageId: s.send_message_id, body: s.reply_text, suggestionId: s.id,
      });
      gmailId = (await gmail.send(tenant.gmailToken, raw, s.thread_id)).id;
    }
    tx(db, () => {
      suggestions.markSent(db, tenant.team_id, s.id, gmailId);
      suggestions.recordOutcome(db, { teamId: tenant.team_id, gmailMessageId: s.gmail_message_id, sender: s.reply_to, outcome: 'replied', actor: s.acted_by, cid: s.cid });
      enqueue(db, { kind: 'render_suggestion', teamId: tenant.team_id, payload: { suggestionId: s.id }, cid: s.cid, maxAttempts });
    });
    log.info('send.done', { suggestion: s.id, gmailId });
  }

  function sendFailed(job, err, log) {
    const s = suggestions.get(db, job.team_id, job.payload.suggestionId);
    if (!s) return;
    tx(db, () => {
      if (!suggestions.markFailed(db, job.team_id, s.id, String(err.message).slice(0, 200))) return;
      suggestions.recordOutcome(db, { teamId: job.team_id, gmailMessageId: s.gmail_message_id, sender: s.reply_to, outcome: 'send_failed', actor: s.acted_by, cid: s.cid });
      enqueue(db, { kind: 'render_suggestion', teamId: job.team_id, payload: { suggestionId: s.id }, cid: s.cid, maxAttempts });
    });
    log.error('send.failed', { suggestion: s.id });
  }

  async function renderSuggestion(job, log) {
    const tenant = getTenant(db, sealer, job.team_id);
    const s = suggestions.get(db, job.team_id, job.payload.suggestionId);
    if (!tenant || !s?.slack_ts || !['sent', 'dismissed', 'failed'].includes(s.status)) return;
    await slack.update(tenant.botToken, { channel: s.slack_channel, ts: s.slack_ts, ...resolvedMessage(s) });
    log.info('render.done', { suggestion: s.id, status: s.status });
  }

  async function notifyUser(job) {
    const tenant = getTenant(db, sealer, job.team_id);
    if (!tenant) return;
    await slack.postEphemeral(tenant.botToken, job.payload);
  }

  return {
    onInteraction,
    handlers: {
      send_reply: { run: sendReply, onDead: sendFailed },
      render_suggestion: { run: renderSuggestion },
      notify_user: { run: notifyUser },
    },
  };
}
