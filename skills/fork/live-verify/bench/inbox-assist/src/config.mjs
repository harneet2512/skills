// Reads and validates configuration once at boot. Secrets are never logged.
import os from 'node:os';

const SPEC = {
  PORT: { default: '8080', int: true },
  INSTANCE_ID: { default: `${os.hostname()}-${process.pid}` },
  DATABASE_PATH: { required: true },
  SLACK_API_BASE: { default: 'https://slack.com/api' },
  SLACK_SIGNING_SECRET: { required: true, secret: true },
  GMAIL_API_BASE: { default: 'https://gmail.googleapis.com/gmail/v1' },
  PUBSUB_PUSH_TOKEN: { required: true, secret: true },
  ADMIN_TOKEN: { required: true, secret: true },
  TOKEN_ENC_KEY: { required: true, secret: true, pattern: /^[0-9a-f]{64}$/i, hint: '32 bytes as 64 hex chars' },
  LLM_PROVIDER: { default: 'anthropic', oneOf: ['anthropic', 'claude-cli'] },
  ANTHROPIC_BASE_URL: { default: 'https://api.anthropic.com' },
  ANTHROPIC_API_KEY: { secret: true },
  LLM_MODEL: { default: 'claude-haiku-4-5' },
  HTTP_TIMEOUT_MS: { default: '10000', int: true },
  LLM_TIMEOUT_MS: { default: '60000', int: true },
  LLM_MAX_ATTEMPTS: { default: '2', int: true },
  PROMPT_BUDGET_TOKENS: { default: '3000', int: true },
  JOB_LEASE_MS: { default: '30000', int: true },
  JOB_MAX_ATTEMPTS: { default: '6', int: true },
  JOB_BACKOFF_BASE_MS: { default: '1000', int: true },
  WORKER_POLL_MS: { default: '200', int: true },
  WORKER_CONCURRENCY: { default: '4', int: true },
  // Slots per instance that LLM drafts may use; the rest stay free for sends and posts.
  WORKER_DRAFT_SLOTS: { default: '3', int: true },
  // Drafts one tenant may run at once across all instances.
  TENANT_MAX_RUNNING_DRAFTS: { default: '2', int: true },
  DRAFT_BUDGET_PER_WINDOW: { default: '200', int: true },
  DRAFT_BUDGET_WINDOW_MS: { default: '3600000', int: true },
  GOOGLE_REVOKE_URL: { default: 'https://oauth2.googleapis.com/revoke' },
  // How long an uninstalled workspace's data is kept for a reinstall (30 days).
  UNINSTALL_PURGE_AFTER_MS: { default: '2592000000', int: true },
  // Below the platform's SIGTERM-to-SIGKILL window (Kubernetes default 30 s).
  SHUTDOWN_GRACE_MS: { default: '20000', int: true },
};

export function loadConfig(env = process.env) {
  const config = {};
  const problems = [];
  for (const [name, spec] of Object.entries(SPEC)) {
    const raw = env[name] ?? spec.default;
    if (raw == null || raw === '') {
      if (spec.required) problems.push(`${name} is required`);
      continue;
    }
    if (spec.pattern && !spec.pattern.test(raw)) problems.push(`${name} must be ${spec.hint}`);
    if (spec.oneOf && !spec.oneOf.includes(raw)) problems.push(`${name} must be one of ${spec.oneOf.join(', ')}`);
    if (spec.int && !/^\d+$/.test(raw)) problems.push(`${name} must be an integer`);
    config[name] = spec.int ? Number(raw) : raw;
  }
  if (config.LLM_PROVIDER === 'anthropic' && !config.ANTHROPIC_API_KEY) problems.push('ANTHROPIC_API_KEY is required for LLM_PROVIDER=anthropic');
  // A lease shorter than one outbound call would let a second worker start the same job mid-call.
  if (config.JOB_LEASE_MS <= config.HTTP_TIMEOUT_MS) problems.push('JOB_LEASE_MS must exceed HTTP_TIMEOUT_MS');
  if (!(config.WORKER_DRAFT_SLOTS >= 1 && config.WORKER_DRAFT_SLOTS < config.WORKER_CONCURRENCY)) problems.push('WORKER_DRAFT_SLOTS must be at least 1 and below WORKER_CONCURRENCY');
  if (config.TENANT_MAX_RUNNING_DRAFTS < 1) problems.push('TENANT_MAX_RUNNING_DRAFTS must be at least 1');
  if (config.DRAFT_BUDGET_WINDOW_MS < 1) problems.push('DRAFT_BUDGET_WINDOW_MS must be at least 1');
  return { config: Object.freeze(config), problems };
}
