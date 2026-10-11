// Offboarding (TEN-11, COMP-02). When Slack tells us the workspace is gone:
//   1. now, in the event handler: tenant disconnected, Slack token dropped,
//      offboard_tenant and purge_tenant (after the grace period) queued in one transaction;
//   2. offboard_tenant: stop the Gmail watch, revoke the Google grant, drop the token;
//   3. purge_tenant: if nobody reinstalled, delete every tenant-owned row and
//      keep a deletion record (ids and row counts only).
// A reinstall inside the grace period keeps the data; the purge then does nothing.
import { tx, now } from './db.mjs';
import { enqueue } from './jobs.mjs';
import { disconnectTenant } from './tenants.mjs';

// Every table holding tenant data. The deletion record (tenant_deletions) is kept on purpose.
export const TENANT_TABLES = ['emails', 'suggestions', 'outcomes', 'slack_events', 'draft_usage'];

export function createOffboarding({ db, sealer, config, gmail }) {
  const graceMs = config.UNINSTALL_PURGE_AFTER_MS;

  function onDisconnect(teamId, cid) {
    return tx(db, () => {
      if (!disconnectTenant(db, teamId)) return false;
      enqueue(db, { kind: 'offboard_tenant', teamId, cid, maxAttempts: config.JOB_MAX_ATTEMPTS });
      enqueue(db, { kind: 'purge_tenant', teamId, cid, runAt: now() + graceMs, maxAttempts: config.JOB_MAX_ATTEMPTS });
      return true;
    });
  }

  async function offboard(job, log) {
    const row = db.prepare('SELECT status, mailbox, gmail_token_enc FROM tenants WHERE team_id = ?').get(job.team_id);
    if (!row || row.status !== 'disconnected' || !row.gmail_token_enc) return log.info('offboard.nothing_to_do', { status: row?.status });
    // Watches and grants belong to the Google account, not to us: if the mailbox
    // is live in another workspace, stopping or revoking would break that one.
    const sharedWith = db.prepare("SELECT team_id FROM tenants WHERE mailbox = ? AND status = 'active'").get(row.mailbox);
    if (sharedWith) {
      log.warn('offboard.mailbox_in_use', { by: sharedWith.team_id });
    } else {
      const token = sealer.open(row.gmail_token_enc);
      await gmail.stopWatch(token).catch((err) => { if (![401, 403, 404].includes(err.status)) throw err; });
      const revoked = await gmail.revoke(token);
      log.info('offboard.google_revoked', { result: revoked });
    }
    db.prepare("UPDATE tenants SET gmail_token_enc = '' WHERE team_id = ? AND status = 'disconnected' AND gmail_token_enc = ?").run(job.team_id, row.gmail_token_enc);
  }

  function purge(job, log) {
    const result = tx(db, () => {
      const row = db.prepare('SELECT status, disconnected_at, gmail_token_enc FROM tenants WHERE team_id = ?').get(job.team_id);
      if (!row) return { skipped: 'already_purged' };
      if (row.status !== 'disconnected') return { skipped: 'reinstalled' };
      if (row.disconnected_at + graceMs > now()) return { skipped: 'disconnected_again' }; // a later purge job covers it
      const deleted = {};
      for (const table of TENANT_TABLES) deleted[table] = db.prepare(`DELETE FROM ${table} WHERE team_id = ?`).run(job.team_id).changes;
      deleted.jobs = db.prepare('DELETE FROM jobs WHERE team_id = ? AND id != ?').run(job.team_id, job.id).changes;
      deleted.tenants = db.prepare('DELETE FROM tenants WHERE team_id = ?').run(job.team_id).changes;
      db.prepare('INSERT INTO tenant_deletions (team_id, requested_at, deleted_at, deleted_rows) VALUES (?, ?, ?, ?)')
        .run(job.team_id, row.disconnected_at, now(), JSON.stringify(deleted));
      return { deleted, tokenNotRevoked: row.gmail_token_enc !== '' };
    });
    if (result.tokenNotRevoked) log.error('purge.google_token_not_revoked');
    log.info(result.skipped ? 'purge.skipped' : 'purge.done', result);
  }

  return {
    onDisconnect,
    handlers: {
      offboard_tenant: { run: offboard, onDead: (job, err, log) => log.error('offboard.dead', { error: String(err?.message ?? err).slice(0, 200) }) },
      purge_tenant: { run: purge },
    },
  };
}
