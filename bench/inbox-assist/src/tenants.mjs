// Installations: one Slack workspace (team_id) linked to one Gmail mailbox.
// Tokens are stored sealed with AES-256-GCM; only this module opens them.
import crypto from 'node:crypto';
import { now } from './db.mjs';

export function createSealer(hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
    },
    open(sealed) {
      const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(body), d.final()]).toString('utf8');
    },
  };
}

function hydrate(row, sealer) {
  if (!row) return null;
  const { bot_token_enc, gmail_token_enc, ...rest } = row;
  return { ...rest, botToken: sealer.open(bot_token_enc), gmailToken: sealer.open(gmail_token_enc) };
}

export function getTenant(db, sealer, teamId) {
  return hydrate(db.prepare("SELECT * FROM tenants WHERE team_id = ? AND status = 'active'").get(teamId), sealer);
}

export function getTenantByMailbox(db, sealer, mailbox) {
  return hydrate(db.prepare("SELECT * FROM tenants WHERE mailbox = ? AND status = 'active'").get(String(mailbox).toLowerCase()), sealer);
}

export class MailboxTaken extends Error {
  constructor() { super('mailbox is connected to another workspace'); this.status = 409; }
}

// Starting history id comes from the mailbox profile at install time, so the
// first push only covers mail that arrived after install (no flood of old mail).
// A reinstall with the same mailbox keeps the furthest position; with another
// mailbox the old position means nothing, so the new mailbox's position wins.
export function installTenant(db, sealer, { teamId, slackUserId, botToken, mailbox, gmailToken, aboutUs = '', historyId }) {
  try {
    db.prepare(`INSERT INTO tenants (team_id, slack_user_id, bot_token_enc, mailbox, gmail_token_enc, about_us, last_history_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (team_id) DO UPDATE SET status = 'active', disconnected_at = NULL, slack_user_id = excluded.slack_user_id,
        bot_token_enc = excluded.bot_token_enc, mailbox = excluded.mailbox, gmail_token_enc = excluded.gmail_token_enc, about_us = excluded.about_us,
        last_history_id = CASE WHEN tenants.mailbox = excluded.mailbox THEN MAX(COALESCE(tenants.last_history_id, 0), excluded.last_history_id)
                               ELSE excluded.last_history_id END`)
      .run(teamId, slackUserId, sealer.seal(botToken), mailbox.toLowerCase(), sealer.seal(gmailToken), aboutUs, historyId, now());
  } catch (err) {
    if (/UNIQUE constraint failed: tenants\.mailbox/.test(err.message)) throw new MailboxTaken();
    throw err;
  }
}

// app_uninstalled / bot tokens_revoked: the Slack token is dead, drop it now.
// The Google token stays sealed until the offboarding job has used it to stop
// the watch and revoke access (offboard.mjs), which then drops it.
export function disconnectTenant(db, teamId) {
  return db.prepare("UPDATE tenants SET status = 'disconnected', disconnected_at = ?, bot_token_enc = '' WHERE team_id = ? AND status = 'active'").run(now(), teamId).changes === 1;
}

// History ids only move forward, whatever order pushes and syncs finish in.
export function advanceHistoryId(db, teamId, historyId) {
  if (!Number.isSafeInteger(historyId)) throw new Error(`refusing history id ${historyId}`);
  return db.prepare('UPDATE tenants SET last_history_id = ? WHERE team_id = ? AND (last_history_id IS NULL OR last_history_id < ?)')
    .run(historyId, teamId, historyId).changes === 1;
}
