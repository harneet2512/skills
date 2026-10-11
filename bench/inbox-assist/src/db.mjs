// SQLite storage shared by every app instance (WAL, busy timeout). Every
// tenant-owned table carries team_id; every query in the app filters by it.
import { DatabaseSync } from 'node:sqlite';

// A mailbox may belong to one active tenant at a time; a disconnected tenant
// does not hold it (TEN-11), hence a partial unique index instead of UNIQUE.
const tenantsTable = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  team_id          TEXT PRIMARY KEY,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
  slack_user_id    TEXT NOT NULL,
  bot_token_enc    TEXT NOT NULL,
  mailbox          TEXT NOT NULL,
  gmail_token_enc  TEXT NOT NULL,
  about_us         TEXT NOT NULL DEFAULT '',
  last_history_id  INTEGER,
  disconnected_at  INTEGER,
  created_at       INTEGER NOT NULL
);`;

const SCHEMA = `
${tenantsTable('tenants')}
-- One row per Gmail message per tenant: the primary key is the dedupe.
CREATE TABLE IF NOT EXISTS emails (
  team_id           TEXT NOT NULL,
  gmail_message_id  TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  cid               TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (team_id, gmail_message_id)
);
CREATE TABLE IF NOT EXISTS suggestions (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  gmail_message_id  TEXT NOT NULL,
  thread_id         TEXT NOT NULL,
  reply_to          TEXT NOT NULL,
  subject           TEXT NOT NULL,
  in_reply_to       TEXT NOT NULL,
  references_hdr    TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('drafted', 'posted', 'sending', 'sent', 'dismissed', 'failed')),
  options_json      TEXT NOT NULL,
  slack_channel     TEXT,
  slack_ts          TEXT,
  acted_by          TEXT,
  reply_text        TEXT,
  send_message_id   TEXT UNIQUE,
  sent_gmail_id     TEXT,
  failure           TEXT,
  cid               TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (team_id, gmail_message_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT NOT NULL,
  team_id       TEXT NOT NULL,
  payload       TEXT NOT NULL,
  coalesce_key  TEXT,
  status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL,
  run_at        INTEGER NOT NULL,
  lease_until   INTEGER,
  locked_by     TEXT,
  last_error    TEXT,
  cid           TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_coalesce ON jobs (coalesce_key) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS jobs_ready ON jobs (status, run_at);
CREATE TABLE IF NOT EXISTS slack_events (
  event_id     TEXT PRIMARY KEY,
  team_id      TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);
-- Answers "did this sender's email get a reply?" per tenant.
CREATE TABLE IF NOT EXISTS outcomes (
  team_id           TEXT NOT NULL,
  gmail_message_id  TEXT NOT NULL,
  sender            TEXT,
  outcome           TEXT NOT NULL CHECK (outcome IN ('skipped', 'awaiting_user', 'replied', 'dismissed', 'draft_failed', 'send_failed')),
  detail            TEXT,
  actor             TEXT,
  cid               TEXT NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (team_id, gmail_message_id)
);
CREATE INDEX IF NOT EXISTS outcomes_sender ON outcomes (team_id, sender);
CREATE INDEX IF NOT EXISTS jobs_running ON jobs (team_id, kind) WHERE status = 'running';
-- Drafts started per tenant per fixed window (COST-13).
CREATE TABLE IF NOT EXISTS draft_usage (
  team_id       TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  drafts        INTEGER NOT NULL,
  PRIMARY KEY (team_id, window_start)
);
-- Deletion record kept after a tenant's data is purged: ids and counts only.
CREATE TABLE IF NOT EXISTS tenant_deletions (
  team_id       TEXT NOT NULL,
  requested_at  INTEGER NOT NULL,
  deleted_at    INTEGER NOT NULL,
  deleted_rows  TEXT NOT NULL
);
`;

// Databases created before user_version 1 have mailbox UNIQUE across all
// tenants and no disconnected_at: rebuild the table (SQLite cannot drop a constraint).
function migrate(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 1) return;
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tenants'").get().sql;
  if (/mailbox\s+TEXT NOT NULL UNIQUE/.test(ddl)) {
    const cols = 'team_id, status, slack_user_id, bot_token_enc, mailbox, gmail_token_enc, about_us, last_history_id, created_at';
    db.exec(`${tenantsTable('tenants_v1')}
      INSERT INTO tenants_v1 (${cols}) SELECT ${cols} FROM tenants;
      DROP TABLE tenants;
      ALTER TABLE tenants_v1 RENAME TO tenants;`);
  }
  db.exec('PRAGMA user_version = 1');
}

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  tx(db, () => {
    db.exec(SCHEMA);
    migrate(db);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tenants_active_mailbox ON tenants (mailbox) WHERE status = 'active'");
  });
  return db;
}

// Runs fn inside BEGIN IMMEDIATE so the write lock is taken up front and two
// instances never interleave a read-then-write.
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export const now = () => Date.now();
