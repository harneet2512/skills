# Multi-tenancy

**Protects:** One customer's data, configuration, load and identity decisions never reach or affect another customer, by construction rather than by every developer remembering a `WHERE` clause; and the enterprise identity features customers will ask for can be added without re-architecting.
**Read when:** The plan adds a table, a query, a cache, a queue or job, a search or vector index, a file upload, a per-customer setting, a Slack or Google install, an admin or support tool, or mentions SSO, SAML, SCIM, roles, audit log, data residency, "workspace", "org", "account" or "tenant". Code signals: a new `CREATE TABLE` without `tenant_id`, `findUnique({ where: { id` , `redis.get(`, `@app.task`, `index.query(`, `s3.putObject(`, `installationStore`, `team_id`, `enterprise_id`.
**Prefix:** TEN

## Design questions

1. Which tables does this step add or touch, and does every one carry a non-null `tenant_id` that is part of its primary key or foreign keys?
2. What enforces the tenant predicate on each query: a database policy, a scoped repository, or the developer? What happens if a query forgets it: zero rows, an error, or everyone's rows?
3. Where does the tenant id for this request come from? Name the exact field of the authenticated context. If it appears in a body, path or query, why is that value trusted?
4. For every cache key, queue message, search document, vector, file key and log line written in this step: where is the tenant in it, and what checks it on read?
5. When a background job runs, how does it learn its tenant, and what clears that context before the next job on the same worker?
6. Which per-tenant limits exist (requests, jobs in flight, LLM spend, storage), and what does a tenant that exceeds them see? What do the other tenants see?
7. Which settings and feature flags vary per tenant, where are they stored, and what is the default when a tenant has no value?
8. If this tenant asks to leave tomorrow, which stores hold its data, and which code deletes or exports each one?
9. Which enterprise identity asks (SSO, SCIM, RBAC, audit log, admin portal, residency) does this step make harder later, and which is it worth building now?
10. For Slack: is the install keyed by `team_id` or by `enterprise_id` for org-wide installs, how is it mapped to our tenant, and what happens on uninstall or when a workspace is added to an org install?

## Categories

### TEN-01 Tenant id on every row

**How it fails:** A child table (messages, attachments, comments) has no `tenant_id` because "it belongs to a conversation which has one". Every query on it must join to find the tenant, someone writes one that does not, and a list or search endpoint returns rows across tenants. Foreign keys that reference only `id` let a row in tenant A point at a parent in tenant B, so a bug in one insert silently links data across tenants.
**Seen in the wild:** No verified public incident tied to a missing column specifically; the failure follows from the fact that row-level policies can only filter on columns the row has, see the PostgreSQL row security documentation [1].
**Spot it in a plan:** "child of", "belongs to the conversation", "we can join to get the tenant", a new table described without its owner.
**Spot it in code:** `CREATE TABLE` without `tenant_id`; `REFERENCES parent(id)` instead of `(tenant_id, id)`; ORM models missing a `tenantId` field; indexes that do not start with `tenant_id`.
**Build it right:** Every tenant-owned table has `tenant_id NOT NULL`. Primary keys and foreign keys are composite and include `tenant_id`, so the database rejects a cross-tenant reference. Indexes lead with `tenant_id`, which also makes per-tenant queries and per-tenant deletion fast. A CI check queries `information_schema.columns` and fails if any table in the app schema lacks `tenant_id` and is not on a short allowlist of global tables.

Dangerous:
```sql
CREATE TABLE messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  body text NOT NULL
);
```

Safe:
```sql
CREATE TABLE conversations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE messages (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX messages_by_conversation ON messages (tenant_id, conversation_id);
```

**Prove it:** Attempt to insert a message for tenant A that references a conversation of tenant B; the database raises a foreign key violation. The schema CI check fails on a new table without `tenant_id`.
**Size for now:** Shared schema, shared database, `tenant_id` everywhere. Schema-per-tenant or database-per-tenant waits for a contract that requires physical isolation; the composite keys make that move easier later.

### TEN-02 Enforcement by structure: row-level security and a scoped data layer

**How it fails:** Isolation depends on every query including `tenant_id = ?`. One report, export, admin script or raw query forgets it. Teams that add Postgres row-level security often still leak because the app connects as the table owner (owners bypass RLS unless the table is set to `FORCE ROW LEVEL SECURITY`), or as a superuser or a `BYPASSRLS` role, which always bypass it [1]. With a connection pool, a tenant id set at session level survives into the next request that borrows the connection.
**Seen in the wild:** No verified public incident cited; the bypass rules are documented: superusers and `BYPASSRLS` roles always bypass row security, and table owners do too unless `FORCE ROW LEVEL SECURITY` is set [1].
**Spot it in a plan:** "we always filter by tenant", "the ORM adds it", "RLS is enabled", "the app uses the postgres user".
**Spot it in code:** `ENABLE ROW LEVEL SECURITY` without `FORCE`; app `DATABASE_URL` using the owner or migration role; `SET app.tenant_id` (session-level) instead of `set_config(..., true)` inside the transaction; `$queryRawUnsafe` or `cursor.execute` outside the scoped module.
**Build it right:** Three layers, strongest first. (1) Postgres RLS on every tenant table, `FORCE`d, with policies that compare `tenant_id` to a transaction-local setting, and `WITH CHECK` so writes cannot create rows for another tenant. (2) The app connects as a role that does not own the tables and has `NOBYPASSRLS` (see `security` SEC-13). (3) One data-access module opens a transaction, calls `set_config('app.tenant_id', $1, true)` (transaction-local, so it resets at commit and is safe with transaction pooling [2]), and is the only place that hands out a database handle. Policies read the setting with `missing_ok = true` so an unset tenant yields no rows rather than all rows.

Dangerous:
```sql
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- app connects as the role that owns "messages" (so the policy is skipped)
-- and runs, once per pooled connection: SET app.tenant_id = '...';
```

Safe:
```sql
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- per request, issued only by the data-access module, as role app_rw (not owner, NOBYPASSRLS):
BEGIN;
SELECT set_config('app.tenant_id', $1, true);   -- transaction-local
-- ... queries ...
COMMIT;
```

**Prove it:** As `app_rw`, with no tenant set, `SELECT count(*) FROM messages` returns 0. With tenant A set, an `INSERT` of a row for tenant B fails the `WITH CHECK`. Through the pool, run request A then request B on the same connection and confirm B cannot see A's rows. A test enumerates tables with `tenant_id` and asserts each has `relforcerowsecurity = true` in `pg_class`.
**Size for now:** RLS plus the scoped module from day one; it is cheap at the start and very expensive to retrofit. Note that referential-integrity checks bypass RLS [1], which composite foreign keys (TEN-01) cover.

### TEN-03 Tenant from the auth context, never from the request

**How it fails:** The API accepts `tenantId` in the body, query, path or a header like `X-Tenant-Id`, and uses it to scope the write or the RLS setting. The caller is authenticated, but for a different tenant. Mass assignment (`create({ data: req.body })`) is the quiet version: the client adds `tenantId` and the ORM writes it.
**Seen in the wild:** No verified public incident cited; this is the object-level authorization failure described by OWASP API1:2023, where an id taken from the request is trusted [3].
**Spot it in a plan:** "the frontend sends the workspace id", "switch workspace", "multi-org users", "admin acts on behalf of a customer".
**Spot it in code:** `req.body.tenantId`, `req.query.org`, `req.header("x-tenant-id")`, `data: req.body`, `**request.json` into a model constructor, path params like `/orgs/:orgId/...` used without a membership check.
**Build it right:** The authenticated context carries the active tenant, resolved server-side from the session and a membership table. If users belong to several tenants, the path may name one, but the server checks membership and then uses the context value. Request schemas are strict and do not accept `tenantId`. Support staff act on a tenant through a time-boxed, audited grant (TEN-08), not by passing a header.

Dangerous:
```ts
router.post("/api/contacts", async (req, res) => {
  const contact = await db.contact.create({ data: { ...req.body } }); // body may carry tenantId
  res.status(201).json(contact);
});
```

Safe:
```ts
const CreateContact = z.object({ name: z.string().max(200), email: z.string().email() }).strict();

router.post("/api/contacts", async (req, res) => {
  const input = CreateContact.parse(req.body);              // unknown keys such as tenantId are rejected
  const tenantId = req.auth.tenantId;                       // from session + membership lookup
  const contact = await withTenant(tenantId, tx => tx.contact.create({ data: { ...input, tenantId } }));
  res.status(201).json(contact);
});
```

**Prove it:** As a user of tenant A, POST a contact with `"tenantId": "<B>"`, and call `/orgs/<B>/contacts` with a path id for B. The first is rejected (400) and the second returns 404; tenant B has no new rows.
**Size for now:** Context-derived tenant and strict schemas. Multi-tenant membership (one user, many orgs) can wait for a customer that needs it, but keep the membership table so it is additive.

### TEN-04 Caches

**How it fails:** Cache keys omit the tenant (`report:{id}`, `settings`, `user:{email}`) or an in-process memoizer ignores who is asking. The first tenant to warm the key serves its data to every other tenant. Shared connections in a cache client can also hand one request's reply to another when requests are cancelled mid-flight.
**Seen in the wild:** On 20 March 2023 a bug in the redis-py asyncio cluster client, triggered by a spike in cancelled requests, returned cached data to the wrong ChatGPT user: some users saw other users' chat titles, and payment details of about 1.2% of active Plus subscribers in a nine-hour window may have been exposed. OpenAI added redundant checks that cached data matches the requesting user [4].
**Spot it in a plan:** "cache the dashboard", "memoize settings", "CDN cache for API responses", "share the cache across workers".
**Spot it in code:** `redis.get(f"report:{id}")`, `@lru_cache` / `@cache` on functions whose result depends on the tenant but whose arguments do not include it; `Cache-Control: public` on authenticated responses; CDN rules without `Vary` on the auth header.
**Build it right:** One key-builder function that requires a tenant id and prefixes it. Cached values carry their tenant id and the reader checks it before returning (the redundant check that would have caught the OpenAI case). Authenticated responses are `Cache-Control: private, no-store` unless deliberately cached per tenant. In-process memoization takes the tenant as an argument.

Dangerous:
```python
@functools.lru_cache(maxsize=1024)
def tenant_settings():
    return db.fetch_settings(current_tenant())     # cached once, served to every tenant

def get_report(report_id):
    raw = redis.get(f"report:{report_id}")
    return json.loads(raw) if raw else build_report(report_id)
```

Safe:
```python
def ckey(tenant_id: UUID, *parts: str) -> str:
    return f"t:{tenant_id}:" + ":".join(parts)

def get_report(ctx: TenantCtx, report_id: str) -> dict:
    raw = redis.get(ckey(ctx.tenant_id, "report", report_id))
    if raw:
        cached = json.loads(raw)
        if cached.get("tenant_id") == str(ctx.tenant_id):   # verify on read, not only on write
            return cached["data"]
    data = build_report(ctx, report_id)                     # scoped query
    redis.set(ckey(ctx.tenant_id, "report", report_id),
              json.dumps({"tenant_id": str(ctx.tenant_id), "data": data}), ex=300)
    return data
```

**Prove it:** Warm the report cache as tenant A with a report id, then request the same report id as tenant B. B gets 404 or its own data. Corrupt a cache entry so its stored `tenant_id` differs; the reader ignores it and rebuilds.
**Size for now:** Key builder plus verify-on-read. Separate cache clusters per tenant are unnecessary.

### TEN-05 Background jobs and async context

**How it fails:** A job is enqueued with only an object id. The worker loads the object without a tenant scope, or reads the tenant from a thread-local or global set by the previous job on the same thread, so data is written under the wrong tenant. Fan-out jobs (one per mailbox) lose the tenant when the child is enqueued. Shared mutable request state read from a background thread can cross users.
**Seen in the wild:** In March 2021 GitHub found that a background thread, reporting an exception, read the Rack `env` hash that the Unicorn server reuses across requests, re-ran authentication against another request's session cookie and set that cookie on a different user's response [5].
**Spot it in a plan:** "a job per mailbox", "nightly sync for all tenants", "retry later", "process in the background".
**Spot it in code:** `enqueue(task, object_id)` without tenant; `threading.local()` or module globals for the tenant; Node `AsyncLocalStorage` set but read after an `await` in code that runs outside `run()`; workers that call the unscoped ORM.
**Build it right:** Every job payload carries `tenant_id` as a required, typed field. The worker entry point opens a tenant scope (`with tenant_scope(tid)`), which sets the RLS setting in the job's transaction and clears any context on exit, including on exceptions. Use `contextvars` in Python and `AsyncLocalStorage.run` in Node rather than thread-locals. Loading an object checks it belongs to the payload's tenant. "For all tenants" schedulers enqueue one job per tenant instead of one job that loops with a mutable context.

Dangerous:
```python
_ctx = threading.local()

@app.task
def sync_mailbox(mailbox_id: str):
    mb = Mailbox.objects.get(id=mailbox_id)                    # unscoped
    for m in fetch_new_messages(mb):
        Message.objects.create(tenant_id=_ctx.tenant_id, **m)  # left over from the previous task on this thread
```

Safe:
```python
@app.task(acks_late=True)
def sync_mailbox(tenant_id: str, mailbox_id: str):
    with tenant_scope(UUID(tenant_id)) as db:                  # sets app.tenant_id in the txn; always clears
        mb = db.mailboxes.get(mailbox_id)                      # raises NotFound if not in this tenant
        for m in fetch_new_messages(mb):
            db.messages.upsert(provider_id=m["id"], **m)       # tenant_id filled by the scope
```

**Prove it:** Run the worker with concurrency 1, enqueue a job for tenant A then a job for tenant B that raises midway, then a job for B that succeeds. All B rows have B's tenant id; no row has a null or A's tenant. Enqueue a job with tenant B's id and tenant A's mailbox id; it fails with not found.
**Size for now:** Tenant in every payload and a scoped worker entry point. Per-tenant queues wait for TEN-09 evidence.

### TEN-06 Search indexes, vector stores and AI retrieval

**How it fails:** Documents from all tenants go into one search or vector index, and the query filters by tenant after retrieving the top results, or relies on the caller to pass a filter. A missed filter, a filter typo (`tenantId` versus `tenant_id`), or a new code path (an AI assistant, an MCP server, a "related items" widget) returns another tenant's content. Post-filtering also leaks through ranking and counts. LLM features make this worse because the leaked text is paraphrased into an answer and nobody sees the raw hit.
**Seen in the wild:** Asana's MCP server, launched 1 May 2025, had what was described as a logic flaw that exposed data from one organization to other organizations' MCP users; it was found on 4 June 2025, the server was taken offline, and about 1,000 customers were affected [6].
**Spot it in a plan:** "semantic search over all documents", "RAG over the customer's knowledge base", "one Pinecone/pgvector index", "MCP server", "related tickets".
**Spot it in code:** `index.query(vector=...)` without `namespace` or `filter`; filters applied in Python after `top_k`; Elasticsearch queries built by string concatenation; pgvector queries on a table without RLS; embeddings tables without `tenant_id`.
**Build it right:** Strongest first: in Postgres with pgvector, store embeddings in a table under RLS (TEN-02) so the database filters before ranking. With an external vector store, one namespace or collection per tenant, and the namespace is chosen by a wrapper class constructed from the auth context, never by the caller. Add the tenant filter as well, as belt and braces. Every hit's metadata tenant is checked again before it enters a prompt. See `ai-behavior` for what the model may do with retrieved text.

Dangerous:
```python
hits = index.query(vector=embed(question), top_k=8, include_metadata=True)  # every tenant
hits = [h for h in hits.matches if h.metadata.get("tenant") == tenant_id]  # wrong key: filters nothing out
```

Safe:
```python
class TenantIndex:
    def __init__(self, index, ctx: TenantCtx):
        self._index, self._tid = index, str(ctx.tenant_id)

    def query(self, vector, top_k: int = 8):
        res = self._index.query(vector=vector, top_k=top_k, include_metadata=True,
                                namespace=f"t-{self._tid}",
                                filter={"tenant_id": {"$eq": self._tid}})
        hits = [m for m in res.matches if m.metadata.get("tenant_id") == self._tid]
        if len(hits) != len(res.matches):
            raise TenantLeak(self._tid)        # alert: something wrote to the wrong namespace
        return hits
```

**Prove it:** Index a document containing a unique canary string for tenant A. As tenant B, ask the search box and the AI assistant questions that match the canary closely. The canary never appears in results, citations or generated answers.
**Size for now:** RLS-protected pgvector or namespace-per-tenant plus the canary test in CI. Dedicated indexes per enterprise tenant wait for a contract.

### TEN-07 File and object storage keys

**How it fails:** Uploads are stored at keys like `uploads/{filename}` or `avatars/{user_id}.png`. Two tenants upload `report.pdf` and one overwrites the other. Download endpoints take a key or path from the client and presign it without checking ownership, so changing the key downloads another tenant's file. Long-lived presigned URLs pasted into tickets stay valid after access is removed.
**Seen in the wild:** No verified public incident cited here; the failure is the object-level authorization pattern [3] applied to storage keys.
**Spot it in a plan:** "store attachments in S3/GCS", "download link", "public bucket for avatars", "presigned URL".
**Spot it in code:** `Key: \`uploads/${file.originalname}\``, `getSignedUrl(... { Key: req.query.key })`, `expiresIn` of days, `ACL: "public-read"`, bucket policies with `"Principal": "*"`.
**Build it right:** Object keys are server-generated: `tenants/{tenant_id}/{kind}/{uuid}`. The file's metadata row (with `tenant_id`, under RLS) is the only way to find the key, so a download loads the row through the scoped layer, then presigns that key for minutes. Buckets block public access. Deleting a tenant deletes its prefix (TEN-11).

Dangerous:
```ts
router.get("/files/download", async (req, res) => {
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: String(req.query.key) }),
                                 { expiresIn: 7 * 24 * 3600 });
  res.redirect(url);
});
```

Safe:
```ts
router.get("/files/:id/download", async (req, res) => {
  const file = await withTenant(req.auth.tenantId, tx => tx.file.findFirst({ where: { id: req.params.id } }));
  if (!file || !can(req.auth, "file:read", file)) return res.sendStatus(404);
  // file.storageKey was generated at upload as `tenants/${tenantId}/attachments/${randomUUID()}`
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: file.storageKey }), { expiresIn: 300 });
  res.redirect(url);
});
```

**Prove it:** Upload a file as tenant A, then as tenant B request `/files/<A's id>/download` and try any route that accepts a key or path. All return 404. A presigned URL older than five minutes returns 403 from the storage provider.
**Size for now:** Prefixed keys, row-gated presigning, short expiry, public access blocked. Per-tenant buckets or customer-managed keys wait for a contract.

### TEN-08 Logs, analytics, error trackers and internal tools

**How it fails:** Logs and error events lack a tenant id, so an incident cannot be scoped to the affected customers, and deletion requests cannot find the data. Or they contain customer content (email bodies, prompts), and every engineer with log access can read every tenant. Internal admin and support tools query across tenants with no record of who looked at what, which enterprise customers and auditors will ask about.
**Seen in the wild:** No verified public incident cited; OWASP lists personal data, session ids and tokens among data that should be excluded or masked before logging [7].
**Spot it in a plan:** "support can look up any account", "admin dashboard", "log the payload for debugging", "send errors to Sentry".
**Spot it in code:** Admin routes using the owner or `BYPASSRLS` role; `send_default_pii=True`; loggers without a bound `tenant_id`; analytics events with free-text properties.
**Build it right:** Bind `tenant_id` (and request id) to every log line and error event through context, and do not log content bodies (see `ai-behavior` AI-12 for prompts). Support access to a tenant goes through a grant: staff member, tenant, reason, expiry, written to the audit log (TEN-13), and the admin tool then uses the normal scoped path with that tenant. Error trackers scrub bodies and headers.

Dangerous:
```python
sentry_sdk.init(dsn=SENTRY_DSN, send_default_pii=True)

@admin.get("/admin/search")
def admin_search(q: str, staff=Depends(staff_user)):
    return superuser_db.execute("SELECT * FROM messages WHERE body ILIKE %s", (f"%{q}%",)).fetchall()
```

Safe:
```python
sentry_sdk.init(dsn=SENTRY_DSN, send_default_pii=False, before_send=scrub_event)

@admin.post("/admin/tenants/{tenant_id}/support-sessions")
def open_support_session(tenant_id: UUID, body: SupportReason, staff=Depends(staff_user)):
    grant = support_grants.create(staff_id=staff.id, tenant_id=tenant_id,
                                  reason=body.reason, expires_at=utcnow() + timedelta(hours=1))
    audit.write(actor=f"staff:{staff.id}", tenant_id=tenant_id, action="support_access.granted",
                details={"reason": body.reason, "grant_id": str(grant.id)})
    return grant   # later admin requests carry grant.id and run through tenant_scope(tenant_id)
```

**Prove it:** Trigger an error in a request that includes an email body; the error event contains the tenant id and no body. Use the admin tool on a tenant without a grant; it is refused. With a grant, every query is visible in the tenant's audit log.
**Size for now:** Tenant-tagged logs, scrubbed error events, grant-based support access with audit. Customer-visible "access transparency" reports can wait.

### TEN-09 Per-tenant limits and noisy neighbours

**How it fails:** All tenants share one queue, one worker pool, one database and one LLM quota. One tenant's bulk import, a runaway integration, or a loop of AI calls fills the queue or exhausts the provider's rate limit, and every other tenant's jobs wait or fail. Global rate limits punish everyone for one tenant's spike.
**Seen in the wild:** No public incident cited; AWS describes a shared-database case where one tool's nightly job slowed a deployment tool, and recommends per-tenant quotas, token-bucket rate limiting and cheap load shedding [8].
**Spot it in a plan:** "bulk import", "backfill all history", "sync every five minutes", "one queue for all jobs", "shared OpenAI key".
**Spot it in code:** A single queue name for all tenants; FIFO dequeue; global limiter keys; no `tenant_id` in limiter keys; unbounded `for` loops enqueuing per item.
**Build it right:** Limits keyed by tenant for API requests, jobs in flight, and expensive resources (LLM tokens per day, outbound sends per hour). Fair scheduling: cap concurrent jobs per tenant (checked when claiming a job) so one tenant cannot hold all workers. Big work (imports, backfills) runs in a separate lower-priority queue. Exceeding a limit returns 429 with `Retry-After` to that tenant only, and the tenant's admin can see usage.

Dangerous:
```ts
const limiter = new RateLimiterRedis({ storeClient: redis, keyPrefix: "api", points: 5000, duration: 60 });
app.use(async (req, res, next) => {
  try { await limiter.consume("global"); next(); } catch { res.sendStatus(429); }  // one tenant starves all
});
```

Safe:
```ts
const limiters = {
  standard:   new RateLimiterRedis({ storeClient: redis, keyPrefix: "api:std", points: 600,  duration: 60 }),
  enterprise: new RateLimiterRedis({ storeClient: redis, keyPrefix: "api:ent", points: 3000, duration: 60 }),
};
app.use(async (req, res, next) => {
  const limiter = limiters[req.auth.plan];
  try {
    await limiter.consume(req.auth.tenantId);
    next();
  } catch (r: any) {
    res.set("Retry-After", String(Math.ceil((r?.msBeforeNext ?? 1000) / 1000))).sendStatus(429);
  }
});
```

**Prove it:** Run a load test where tenant A sends 10x its limit and enqueues 10,000 import jobs while tenant B runs its normal flow. B's p95 latency and job wait time stay within their budget; A gets 429s.
**Size for now:** Per-tenant API limits, per-tenant job concurrency caps and a separate bulk queue. Cell-based architecture or per-tenant infrastructure waits until one tenant's load is a measurable share of the total.

### TEN-10 Per-tenant configuration and feature flags

**How it fails:** Behavior that should differ per tenant (enabled integrations, retention period, AI features on or off, SSO enforced) is read from an environment variable or a global config, so turning it on for one customer turns it on for all. Or per-tenant settings are cached without the tenant in the key (TEN-04). Or a missing setting falls back to the most permissive default ("AI drafting enabled") for a customer who contractually opted out.
**Seen in the wild:** No verified public incident cited; the failure follows from evaluating flags without tenant context.
**Spot it in a plan:** "beta for one customer", "this customer wants AI off", "configurable retention", "enforce SSO for their users".
**Spot it in code:** `process.env.FEATURE_*` checks in request paths; flag SDK calls without a context argument; settings read as optional with `?? true`.
**Build it right:** A typed per-tenant settings record with explicit, conservative defaults in code. Flag evaluation always receives the tenant (and user) context. Contractual settings (AI processing allowed, data region, retention) are not feature flags: they live in the tenant record, are changed only by an audited admin action, and are enforced at the point of use (the LLM client checks `ai_processing_allowed` before every call).

Dangerous:
```ts
if (process.env.ENABLE_AI_DRAFTS === "true") {
  await draftReplyWithLLM(ticket);          // on for every tenant, including ones that opted out
}
```

Safe:
```ts
const TenantSettings = z.object({
  aiProcessingAllowed: z.boolean().default(false),   // contractual: off unless the tenant turned it on
  retentionDays: z.number().int().min(1).max(3650).default(365),
});
const settings = TenantSettings.parse(await loadTenantSettings(req.auth.tenantId));
if (settings.aiProcessingAllowed && flags.isEnabled("ai-drafts", { tenantId: req.auth.tenantId })) {
  await draftReplyWithLLM(ticket);
}
```

**Prove it:** Create a tenant with no settings row and one with `aiProcessingAllowed: false`; trigger the drafting path for both and assert the LLM client was never called. Enable the flag for tenant A only; tenant B's behavior is unchanged.
**Size for now:** A settings table and a flag provider that takes tenant context. A self-serve settings UI for every option waits for demand.

### TEN-11 Tenant offboarding: deletion and export

**How it fails:** A customer churns or asks for deletion. The team deletes the tenant row and relies on cascades. Files in object storage, search and vector indexes, caches, analytics, third-party copies (LLM provider files, email provider lists), Slack and Google tokens, and backups remain. Or export is a manual SQL dump that misses attachments and takes a week.
**Seen in the wild:** No verified multi-tenant incident cited; deletion obligations that cover backups and recipients are described by the UK ICO [9]. See `compliance` COMP-02 for the legal side.
**Spot it in a plan:** "cancel subscription", "delete workspace", "customer wants their data back", "contract end".
**Spot it in code:** `DELETE FROM tenants` with no other step; no registry of stores; no revocation call for provider tokens; deletion code that is not idempotent.
**Build it right:** A registry of every store that holds tenant data, each implementing `delete_tenant` (idempotent) and `count(tenant_id)` for verification. Offboarding is a job: mark the tenant `deleting` (blocks logins and new jobs), revoke upstream tokens (Slack uninstall, Google revoke), delete from each store, verify every count is zero, then mark `deleted` and record a deletion certificate. Export uses the same registry to produce an archive. A CI test fails if a table with `tenant_id` is not covered by the registry.

Dangerous:
```python
def delete_workspace(tenant_id):
    db.execute("DELETE FROM tenants WHERE id = %s", (tenant_id,))   # cascades in Postgres only
```

Safe:
```python
STORES: list[TenantStore] = [postgres_rows, object_storage, search_index, vector_index,
                             redis_cache, slack_installs, google_connections, llm_provider_files]

@app.task(acks_late=True)
def offboard_tenant(tenant_id: str):
    tid = UUID(tenant_id)
    tenants.set_state(tid, "deleting")                 # blocks sign-in and new jobs
    for store in STORES:
        store.delete_tenant(tid)                       # each idempotent; safe to rerun
    leftovers = {s.name: n for s in STORES if (n := s.count(tid))}
    if leftovers:
        raise IncompleteDeletion(tid, leftovers)       # retried; alerts after N attempts
    tenants.set_state(tid, "deleted")
    audit.write(actor="system", tenant_id=tid, action="tenant.deleted", details={"stores": [s.name for s in STORES]})
```

**Prove it:** Seed a tenant with rows, files, index entries, a cached report and a connected Slack install; run offboarding; every store's `count` is zero and a Slack API call with the old bot token fails. Kill the job midway and rerun; it completes.
**Size for now:** The registry, the job and the coverage test. Self-serve export UI and crypto-shredding with per-tenant keys wait for demand.

### TEN-12 Enterprise identity: SSO and SCIM

**How it fails:** The first enterprise customer asks for SAML or OIDC SSO and SCIM. Retrofitting reveals that users are global by email (one person cannot be in two tenants, or a person's SSO login from tenant A matches a user in tenant B with the same email), that sessions cannot be revoked per user, and that deprovisioning only blocks new logins while existing sessions and API tokens keep working. SCIM handlers that find users by email across tenants can deactivate someone else's account.
**Seen in the wild:** No verified incident cited. Protocol facts that shape the design: Okta deprovisions SCIM users by setting `active` to `false` (PATCH for new OIN integrations, PUT for wizard-built ones) and does not send DELETE for users [10]; RFC 7643 leaves the meaning of `active` to the service provider [11].
**Spot it in a plan:** "add SSO", "Okta integration", "auto-provision users", "enforce SSO", "just-in-time provisioning".
**Spot it in code:** `users.email` unique globally; login by email without tenant; SCIM endpoints authenticating with a global token; SCIM handlers that only handle DELETE; deactivation that does not revoke sessions or tokens.
**Build it right:** Now: users belong to tenants through memberships; identities (password, Google, SAML) attach to a user within a tenant; sessions and API tokens are revocable per user (`security` SEC-09). When the first customer asks: use a hosted SSO/SCIM broker or a well-maintained library rather than writing SAML parsing; SSO connections are per tenant and bound to verified email domains; SCIM bearer tokens are per tenant and identify the tenant; `active: false` (via PATCH or PUT) and DELETE both deactivate, and deactivation revokes sessions and tokens in the same transaction.

Dangerous:
```ts
router.patch("/scim/v2/Users/:id", globalScimToken, async (req, res) => {
  const email = req.body.Operations?.[0]?.value?.emails?.[0]?.value;
  await db.user.update({ where: { email }, data: { disabled: true } });  // any tenant's user with that email
  res.sendStatus(204);                                                   // sessions and API tokens still valid
});
```

Safe:
```ts
router.patch("/scim/v2/Users/:id", scimAuth, async (req, res) => {
  const tenantId = req.scim.tenantId;                          // from the per-tenant SCIM token
  const member = await members.findInTenant(tenantId, req.params.id);
  if (!member) return res.status(404).json(scimError(404, "User not found"));
  const active = readActiveFromPatch(req.body.Operations);     // handles {path:"active"} and {value:{active}}
  if (active === false) {
    await db.$transaction([
      members.deactivate(tenantId, member.id),
      sessions.revokeForMember(tenantId, member.id),
      apiTokens.revokeForMember(tenantId, member.id),
    ]);
  }
  res.json(toScimUser(await members.get(tenantId, member.id)));
});
// PUT /scim/v2/Users/:id with "active": false and DELETE /scim/v2/Users/:id call the same deactivation.
```

**Prove it:** Provision the same email in two tenants. Deactivate it via SCIM from tenant A; tenant B's membership is untouched, and A's existing session and API token get 401 on the next request.
**Size for now:** Build memberships, per-user revocation and tenant-scoped identities now (cheap, hard to retrofit). Build SSO and SCIM when the first customer signs for it, using a broker; budget about a sprint, not a quarter, because the model is ready.

### TEN-13 Enterprise asks: RBAC, audit log, admin portal, data residency

**How it fails:** Roles are a boolean `is_admin` checked in scattered `if` statements, so adding "billing admin" or "read-only auditor" means touching every handler. There is no audit log, so the customer's security questionnaire cannot be answered and incidents cannot be scoped. Data residency is promised in a sales call, but the architecture has one region and third-party processors in another.
**Seen in the wild:** No verified incident cited; the residency side has real enforcement history, see `compliance` COMP-12.
**Spot it in a plan:** "admin-only", "customer wants viewer role", "security questionnaire asks for audit logs", "EU customer", "admin console for their IT team".
**Spot it in code:** `if (user.isAdmin)` in handlers; roles in JWT claims trusted without server lookup; no `audit_log` table; region-specific values hard-coded.
**Build it right:** Now: a single `can(actor, action, resource)` function backed by a role-to-permission map in code, with a small fixed role set (owner, admin, member, viewer); an append-only audit log written by the same transaction as sensitive actions (role changes, deletions, exports, integration connects, support access); a `region` column on the tenant even if every value is the same. Later, when asked: custom roles (permissions stored per tenant), a customer-facing audit log viewer and export, an admin portal for SSO/SCIM/settings, and a second region deployed as a separate stack with the tenant pinned to it.

Dangerous:
```ts
if (req.user.isAdmin || req.body.role === "admin") {          // role from the request body
  await db.member.update({ where: { id: req.params.id }, data: { role: req.body.newRole } });
}
```

Safe:
```ts
const PERMS: Record<Role, ReadonlySet<Action>> = {
  owner:  new Set(["member:update_role", "billing:manage", "audit:read", "data:export"]),
  admin:  new Set(["member:update_role", "audit:read"]),
  member: new Set([]),
  viewer: new Set([]),
};
export const can = (actor: AuthCtx, action: Action) => PERMS[actor.role].has(action);

router.patch("/members/:id/role", async (req, res) => {
  if (!can(req.auth, "member:update_role")) return res.sendStatus(403);
  const { newRole } = UpdateRole.parse(req.body);
  await withTenant(req.auth.tenantId, async tx => {
    const before = await tx.member.findFirstOrThrow({ where: { id: req.params.id } });
    await tx.member.update({ where: { tenantId_id: { tenantId: req.auth.tenantId, id: before.id } }, data: { role: newRole } });
    await tx.auditLog.create({ data: { tenantId: req.auth.tenantId, actor: `user:${req.auth.userId}`,
      action: "member.role_changed", target: before.id, details: { from: before.role, to: newRole } } });
  });
  res.sendStatus(204);
});
```

**Prove it:** As a member, call the role-change route; 403 and no audit row. As an admin, change a role; exactly one audit row exists with before and after, written in the same transaction (force an error after the update and confirm neither the change nor the audit row persists).
**Size for now:** Fixed roles, `can()`, the audit table and a `region` column. Custom roles, audit export UI, admin portal and multi-region wait for a signed customer who needs them.

### TEN-14 Slack app installation model

**How it fails:** The app stores one bot token, or stores tokens keyed only by `team_id`. In Slack Enterprise Grid, an org-ready app can be installed once at the organization level with a single org-wide token, and admins then grant it to workspaces without another OAuth flow [12]. For those installs the installation has no `team`, so code keyed by `team.id` either crashes or, worse, falls back to "the latest installation" and answers with another customer's token. Events from a newly granted workspace arrive for a `team_id` the app has never seen. Uninstalls leave tokens and data behind.
**Seen in the wild:** No verified public incident cited; the shape is documented. Bolt's own examples key org-wide installs by `enterprise.id` when `isEnterpriseInstall` is true and by `team.id` otherwise [13]; the Python SDK's `find_installation` docstring warns that without `user_id` it "may return the latest installation in the workspace / org" [14]; `team_access_granted` is sent when an org-ready app's token gains access to a new workspace [15]; `app_uninstalled` is sent on full removal, and `tokens_revoked` may arrive after it [16].
**Spot it in a plan:** "Slack bot", "install to Slack", "Enterprise Grid customer", "one token per customer", "SLACK_BOT_TOKEN env var".
**Spot it in code:** `process.env.SLACK_BOT_TOKEN` in a multi-tenant app; `installation.team.id` without a branch on `isEnterpriseInstall`; `findFirst()` on installs; no handlers for `app_uninstalled`, `tokens_revoked`, `team_access_granted`.
**Build it right:** Store installations with `(enterprise_id, team_id, is_enterprise_install)` and the bot token encrypted (`security` SEC-10). Resolve the token for an incoming event from its `enterprise_id`/`team_id` (org install first if `is_enterprise_install`), never "latest". Map each Slack installation to exactly one tenant of ours at install time (the installing user's session decides the tenant); for org installs, decide whether the org maps to one tenant, and record granted workspaces from `team_access_granted`. On `app_uninstalled` or `tokens_revoked`, delete the tokens and mark the integration disconnected. With token rotation on, refresh before the 12-hour expiry and store the new single-use refresh token atomically [17].

Dangerous:
```ts
const app = new App({ token: process.env.SLACK_BOT_TOKEN, signingSecret });   // one token for everyone
const installationStore = {
  storeInstallation: async (i: Installation) => db.slackInstall.create({ data: { teamId: i.team!.id, data: i } }),
  fetchInstallation: async (_q: InstallationQuery<boolean>) => (await db.slackInstall.findFirst())!.data, // "latest"
};
```

Safe:
```ts
const installationStore = {
  storeInstallation: async (i: Installation) => {
    const key = i.isEnterpriseInstall && i.enterprise ? { kind: "org", id: i.enterprise.id }
              : i.team ? { kind: "team", id: i.team.id } : null;
    if (!key) throw new Error("installation without team or enterprise");
    await db.slackInstall.upsert({
      where: { kind_slackId: { kind: key.kind, slackId: key.id } },
      create: { kind: key.kind, slackId: key.id, enterpriseId: i.enterprise?.id ?? null,
                tenantId: await tenantForPendingInstall(i), data: await encryptInstall(i) },
      update: { data: await encryptInstall(i) },
    });
  },
  fetchInstallation: async (q: InstallationQuery<boolean>) => {
    const key = q.isEnterpriseInstall && q.enterpriseId ? { kind: "org", slackId: q.enterpriseId }
              : q.teamId ? { kind: "team", slackId: q.teamId } : null;
    if (!key) throw new Error("no team or enterprise in query");
    const row = await db.slackInstall.findUnique({ where: { kind_slackId: key } });
    if (!row) throw new Error("no installation");
    return decryptInstall(row.data);
  },
};
// resolve the install from the envelope's team_id and its authorizations[] (enterprise_id, is_enterprise_install)
app.event("app_uninstalled", async ({ body }) => disconnectSlack(body));
app.event("tokens_revoked", async ({ body }) => disconnectSlack(body));
```

**Prove it:** Install the app in two test workspaces and one org-wide on an Enterprise Grid sandbox. Send an event from each; each reply uses its own token and lands in the right tenant. Send an event with an unknown `team_id`; it is rejected with a logged error, not served with another token. Uninstall from one workspace; its token row is gone and the other installs still work.
**Size for now:** Per-installation storage keyed correctly, uninstall handling and token rotation if enabled. Org-wide (Enterprise Grid) support can be added when the first Grid customer arrives, but keep the `(kind, slackId)` key shape now so it is additive.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "Every query already filters by tenant." | Until the one that does not; reports, exports, admin scripts and AI tools are new query paths. | Enforce in the database with forced RLS and a non-owner role (TEN-02). |
| "RLS is enabled, so we are covered." | Owners, superusers and `BYPASSRLS` roles skip it, and session-level settings leak across pooled connections. | `FORCE`, a non-owner `NOBYPASSRLS` role, transaction-local settings (TEN-02). |
| "The frontend always sends the right tenant id." | Clients are attacker-controlled. | Derive the tenant from the authenticated context (TEN-03). |
| "The cache is internal." | Internal caches served other users' data in the ChatGPT incident. | Tenant in the key and verify on read (TEN-04). |
| "Jobs run as the system, they do not need a tenant." | System jobs write tenant data; without a scope they write it to the wrong tenant. | Tenant in every payload and a scoped worker entry point (TEN-05). |
| "We filter the vector results by tenant afterwards." | Post-filtering leaks through bugs, ranking and counts. | Filter inside the store: RLS or namespace per tenant (TEN-06). |
| "Deleting the tenant row cascades everything." | Cascades stop at the database edge. | A store registry with verified deletion (TEN-11). |
| "We will add SSO when someone pays for it." | True for SSO itself, false for the data model underneath it. | Memberships and per-user revocation now; SSO and SCIM when signed (TEN-12). |
| "Slack gives us one token per customer." | Enterprise Grid org-wide installs use one token across many workspaces and have no `team`. | Key installs by `(kind, id)` and resolve per event (TEN-14). |

## Attack recipes

1. **Forgotten-scope sweep.** As `app_rw` with no tenant setting, run `SELECT count(*)` on every table that has `tenant_id`. Any non-zero count means TEN-02 failed. Then query `pg_class` for tables with `relrowsecurity` false or `relforcerowsecurity` false; any app table listed means TEN-02 failed.
2. **Pool bleed.** Pin the pool to one connection. Make a request as tenant A, then one as tenant B that issues a raw query outside the data module. If B sees A's rows, TEN-02 failed.
3. **Body tenant override.** For every create and update endpoint, add `tenantId`, `tenant_id`, `orgId` and `X-Tenant-Id` set to another tenant. Any row created or changed in the other tenant means TEN-03 failed.
4. **Cache cross-read.** Warm every cached endpoint as tenant A, then call the same URLs with the same ids as tenant B. Any of A's data in B's response means TEN-04 failed.
5. **Worker context carryover.** With worker concurrency 1, enqueue A's job, then B's job that raises after setting context, then a job with no tenant field. Any row written with A's tenant by B's job, or any job without a tenant that runs, means TEN-05 failed.
6. **Canary retrieval.** Put a unique canary phrase in tenant A's documents. As tenant B, use search, "related items", the AI assistant and any MCP or API retrieval endpoint with queries built to match it. Any appearance means TEN-06 failed.
7. **Storage key swap.** Upload as A, note the storage key from a presigned URL, then as B call every download and preview route with A's file id or key. Any 2xx means TEN-07 failed.
8. **Noisy tenant.** Have tenant A start a 100,000-item import and exceed its API limit tenfold while a scripted tenant B runs its normal workflow. If B's p95 latency or job wait exceeds its budget, TEN-09 failed.
9. **Deprovision with a live session.** Log in as a user, create an API token, then deactivate the user via SCIM PATCH and via SCIM PUT. If either the session or the token works afterwards, TEN-12 failed.
10. **Slack unknown team.** Send a correctly signed Slack event for a `team_id` with no installation. If the app replies using any token, TEN-14 failed.

## Sources

1. PostgreSQL documentation, 5.9 Row Security Policies. https://www.postgresql.org/docs/current/ddl-rowsecurity.html
2. PostgreSQL documentation, 9.28 System Administration Functions (`set_config`, `current_setting`). https://www.postgresql.org/docs/current/functions-admin.html
3. OWASP API Security Top 10 2023, API1:2023 Broken Object Level Authorization. https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/
4. OpenAI, "March 20 ChatGPT outage: Here's what happened". https://openai.com/index/march-20-chatgpt-outage/
5. GitHub Blog, "How we found and fixed a rare race condition in our session handling" (18 March 2021). https://github.blog/2021-03-18-how-we-found-and-fixed-a-rare-race-condition-in-our-session-handling/
6. BleepingComputer, "Asana warns MCP AI feature exposed customer data to other orgs" (June 2025). https://bleepingcomputer.com/news/security/asana-warns-mcp-ai-feature-exposed-customer-data-to-other-orgs/
7. OWASP Cheat Sheet Series, Logging. https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
8. AWS Builders' Library, "Fairness in multi-tenant systems". https://builder.aws.com/content/3Eupj3d2bo4fEvlzYbICMZNhQ3B/fairness-in-multi-tenant-systems
9. UK ICO, Right to erasure. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/
10. Okta Developer, SCIM 2.0 protocol reference. https://developer.okta.com/docs/api/openapi/okta-scim/guides/scim-20
11. IETF RFC 7643, SCIM Core Schema, section 4.1.1. https://datatracker.ietf.org/doc/html/rfc7643#section-4.1.1
12. Slack, "Organization-ready apps". https://docs.slack.dev/enterprise/organization-ready-apps
13. Slack, Bolt for JavaScript, "Authenticating with OAuth". https://docs.slack.dev/tools/bolt-js/concepts/authenticating-oauth
14. Slack, Python SDK reference, `slack_sdk.oauth.installation_store.installation_store`. https://docs.slack.dev/tools/python-slack-sdk/reference/oauth/installation_store/installation_store.html
15. Slack, `team_access_granted` event. https://docs.slack.dev/reference/events/team_access_granted
16. Slack, `app_uninstalled` event. https://docs.slack.dev/reference/events/app_uninstalled
17. Slack, "Using token rotation". https://docs.slack.dev/authentication/using-token-rotation/
