// The suggestion state machine. Every transition is one conditional UPDATE on
// (id, team_id, expected status), so two clicks on two instances cannot both win.
//
//   drafted -> posted -> sending -> sent
//      |             \-> dismissed     \-> failed
//       \-> failed (the Slack post died; the user got a plain notice instead)
import crypto from 'node:crypto';
import { now } from './db.mjs';

export const TRANSITIONS = Object.freeze({
  drafted: ['posted', 'failed'],
  posted: ['sending', 'dismissed'],
  sending: ['sent', 'failed'],
  sent: [],
  dismissed: [],
  failed: [],
});

export const canTransition = (from, to) => TRANSITIONS[from]?.includes(to) ?? false;

function transition(db, { id, teamId, from, to, set = {} }) {
  if (!canTransition(from, to)) throw new Error(`illegal transition ${from} -> ${to}`);
  const cols = Object.keys(set);
  const sql = `UPDATE suggestions SET status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join('')}
    WHERE id = ? AND team_id = ? AND status = ?`;
  return db.prepare(sql).run(to, now(), ...cols.map((c) => set[c]), id, teamId, from).changes === 1;
}

export function get(db, teamId, id) {
  const row = db.prepare('SELECT * FROM suggestions WHERE id = ? AND team_id = ?').get(id, teamId);
  return row ? { ...row, options: JSON.parse(row.options_json) } : null;
}

export function getByEmail(db, teamId, gmailMessageId) {
  return db.prepare('SELECT id, status FROM suggestions WHERE team_id = ? AND gmail_message_id = ?').get(teamId, gmailMessageId) ?? null;
}

export function create(db, { teamId, email, options, cid }) {
  const id = `sug_${crypto.randomUUID()}`;
  db.prepare(`INSERT INTO suggestions (id, team_id, gmail_message_id, thread_id, reply_to, subject, in_reply_to, references_hdr, status, options_json, cid, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?, ?, ?)`)
    .run(id, teamId, email.id, email.threadId, email.sender, email.subject, email.messageId, email.references, JSON.stringify(options), cid, now(), now());
  return id;
}

export const markPosted = (db, teamId, id, channel, ts) =>
  transition(db, { id, teamId, from: 'drafted', to: 'posted', set: { slack_channel: channel, slack_ts: ts } });

// The send intent: who, what text, and the Message-ID the email will carry.
// That id is fixed before the first Gmail call, so a retry can look it up.
export function claimSend(db, { teamId, id, userId, text, messageId }) {
  return transition(db, { id, teamId, from: 'posted', to: 'sending', set: { acted_by: userId, reply_text: text, send_message_id: messageId } });
}

export const markSent = (db, teamId, id, gmailId) =>
  transition(db, { id, teamId, from: 'sending', to: 'sent', set: { sent_gmail_id: gmailId } });

export const markPostFailed = (db, teamId, id, reason) =>
  transition(db, { id, teamId, from: 'drafted', to: 'failed', set: { failure: reason } });

export const markFailed = (db, teamId, id, reason) =>
  transition(db, { id, teamId, from: 'sending', to: 'failed', set: { failure: reason } });

export const dismiss = (db, teamId, id, userId) =>
  transition(db, { id, teamId, from: 'posted', to: 'dismissed', set: { acted_by: userId } });

export function recordOutcome(db, { teamId, gmailMessageId, sender, outcome, detail = null, actor = null, cid }) {
  db.prepare(`INSERT INTO outcomes (team_id, gmail_message_id, sender, outcome, detail, actor, cid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (team_id, gmail_message_id) DO UPDATE SET outcome = excluded.outcome, detail = excluded.detail,
      actor = COALESCE(excluded.actor, outcomes.actor), sender = COALESCE(excluded.sender, outcomes.sender), updated_at = excluded.updated_at`)
    .run(teamId, gmailMessageId, sender, outcome, detail, actor, cid, now());
}
