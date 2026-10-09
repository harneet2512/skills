# Compliance

**Protects:** The product can show, on request and with evidence, what personal data it holds, why, where it goes, how long it stays, who touched it, and that it honors people's rights and platform rules; so that a regulator, an auditor, a platform reviewer (Google, Slack) or an enterprise security questionnaire is answered from the system, not from memory.
**Read when:** The plan stores a new kind of personal data, adds a data store, a third-party processor or an LLM provider, requests Google or Slack scopes, sends email on behalf of users, adds retention or deletion behavior, touches production access or the deploy path, or mentions GDPR, DSR, DPA, SOC 2, audit log, CASA, Marketplace listing, CAN-SPAM, unsubscribe, EU customer or data residency. Code signals: new columns with names, emails, phone numbers or free text; `scopes=`; `List-Unsubscribe`; `audit`; `retention`; `region`; new SDK for an external service.
**Prefix:** COMP

> Engineering guidance, not legal advice. This file explains how engineering choices map to obligations that are commonly applied to B2B SaaS. Whether and how a given law applies (controller or processor role, lawful basis, transfer mechanism, exemptions) is a decision for the company's counsel. Article numbers refer to the EU GDPR as published; the UK GDPR mirrors most of them.

## Design questions

1. For each personal data field this step adds: what is it for, who is the data subject, is the product the controller or a processor for it, and how long is it kept?
2. Which stores (tables, buckets, indexes, caches, logs, analytics, backups, third parties) will hold a copy, and does the deletion path reach each one?
3. If a person or a customer asks "what do you hold about me" or "delete me", which code finds every record for that person within a tenant, and how long does it take?
4. Which processors and subprocessors receive data in this step (including LLM providers), under what agreement, retention mode and region, and is that on the published subprocessor list?
5. Which actions in this step must appear in the audit log (who, what, when, on which tenant and object), and what stops anyone, including us, from editing those entries?
6. Who can access production data and deploy production code after this change, and what record proves each access and change was authorized and reviewed?
7. Is data encrypted in transit on every hop (including internal service-to-database) and at rest, and who can decrypt it?
8. Which Google OAuth scopes does this feature request, are any of them restricted, and does the data use stay within Google's Limited Use rules?
9. Which Slack scopes does this feature need, and does each one survive a reviewer asking "why"?
10. Is any message this step sends commercial email under CAN-SPAM, and if it goes to Gmail at volume, does it carry RFC 8058 one-click unsubscribe that is honored within the deadline?
11. Which region does each tenant's data live in, and does any processing (LLM calls, support tools, analytics) move it out of that region?

## Categories

### COMP-01 Personal data inventory and minimization

**How it fails:** Personal data accumulates without a record: raw provider payloads stored "in case", free-text notes, full email bodies, phone numbers collected for one purpose and reused for another. When a customer, auditor or regulator asks what is held and why, nobody can answer, and data collected for one purpose drifts into another use.
**Seen in the wild:** In May 2022 the FTC and DOJ announced a $150 million penalty against Twitter for using phone numbers and email addresses that users gave for account security (two-factor authentication, password reset) to target advertising, contrary to a 2011 order [1].
**Spot it in a plan:** "store the whole payload", "we might need it later", "enrich contacts", "reuse the phone number for notifications", a new table with free-text fields.
**Spot it in code:** `jsonb` columns named `raw`, `payload`, `metadata` holding provider objects; new columns named like `*_email`, `phone`, `name`, `notes`, `address`, `dob`; analytics events with user properties; no data inventory file.
**Build it right:** A machine-readable inventory (YAML or a table) listing every column and store that holds personal data, with purpose, data subject category, lawful basis reference (COMP-04), retention (COMP-02) and recipients (COMP-05). A CI test compares the database schema with the inventory and fails on unlisted columns, so the inventory cannot drift. Store only fields a feature uses; parse provider payloads at the boundary and keep the parsed fields, not the raw blob. A field collected for one purpose gets a new inventory entry and review before use for another. This inventory is also the backbone of records of processing (GDPR Article 30 lists purposes, categories, recipients and, where possible, erasure time limits [2]).

Dangerous:
```sql
CREATE TABLE contacts (
  tenant_id uuid NOT NULL, id uuid NOT NULL,
  email text, phone text,
  raw_provider_payload jsonb,      -- entire CRM/Gmail object, "in case"
  PRIMARY KEY (tenant_id, id)
);
```

Safe:
```python
# tests/test_data_inventory.py
INVENTORY = yaml.safe_load(Path("compliance/data_inventory.yaml").read_text())
# entries like: {table: contacts, column: email, purpose: "send user-approved replies",
#                subject: "customer's contacts", retention: "tenant.retention_days", recipients: ["email_provider"]}

def test_every_personal_column_is_inventoried(db):
    rows = db.execute("""SELECT table_name, column_name FROM information_schema.columns
                         WHERE table_schema = 'app'""").fetchall()
    listed = {(e["table"], e["column"]) for e in INVENTORY["personal"]} | {(e["table"], e["column"]) for e in INVENTORY["non_personal"]}
    missing = [r for r in rows if (r.table_name, r.column_name) not in listed]
    assert not missing, f"classify these columns in data_inventory.yaml: {missing}"
```

**Prove it:** Add a column in a branch without touching the inventory; CI fails with the column named. Pick five inventory entries at random and trace each to the feature code that reads it.
**Size for now:** The YAML inventory plus the schema test, covering Postgres first, then buckets and third parties by hand. A data catalog product waits for many stores and teams.

### COMP-02 Retention and deletion, including backups and third parties

**How it fails:** Nothing is ever deleted: soft-delete flags, archives, logs and backups keep everything forever. When deletion is requested, the primary row goes but copies remain in object storage, search and vector indexes, analytics, error trackers, LLM provider files, email provider lists and backups. A regulator sees a "data cemetery".
**Seen in the wild:** In 2019 the Berlin data protection authority fined Deutsche Wohnen about €14.5 million for keeping tenants' personal data (salary statements, bank statements, tax and health insurance data) in an archive system that could not remove data no longer needed, citing GDPR Articles 5 and 25 [3]. The UK ICO's guidance is that erasure covers backups as well as live systems, that backup copies may persist until overwritten on a schedule but must be put "beyond use" meanwhile, and that recipients of disclosed data must be told [4].
**Spot it in a plan:** "soft delete", "archive", "keep for analytics", "we never delete", no retention period stated, a new third party receiving copies.
**Spot it in code:** `deleted_at` columns with no purge job; no retention setting; bucket lifecycle rules absent; backups with no expiry; no deletion call for third-party copies.
**Build it right:** A retention period per inventory entry (COMP-01), configurable per tenant where contracts require. A scheduled purge job per store that hard-deletes in batches. Soft delete only as a short grace period that a purge job ends. Backups expire on a stated schedule (for example 30 days), are not restored into production without re-applying deletions recorded since the backup, and are otherwise not used. Each third party that receives copies has a deletion call or a retention setting recorded. Deletion runs through the same store registry as tenant offboarding (see `multi-tenancy` TEN-11). The purge job runs as a separate, audited maintenance role, since it works across tenants.

Dangerous:
```sql
UPDATE messages SET deleted_at = now() WHERE tenant_id = $1 AND id = $2;  -- row, attachments and backups kept forever
```

Safe:
```sql
-- daily purge, run as maintenance role; batches keep locks short and the job restartable
WITH doomed AS (
  SELECT m.tenant_id, m.id
  FROM messages m
  JOIN tenant_settings s ON s.tenant_id = m.tenant_id
  WHERE m.created_at < now() - make_interval(days => s.retention_days)
     OR m.deleted_at < now() - interval '14 days'
  LIMIT 5000
)
DELETE FROM messages m
USING doomed d
WHERE m.tenant_id = d.tenant_id AND m.id = d.id
RETURNING m.tenant_id, m.id, m.attachment_keys;   -- caller deletes attachments and index entries for these ids
```

**Prove it:** Set a test tenant's retention to one day, age fixtures past it, run the purge; rows, attachment objects, index entries and cached copies are gone. Restore last week's backup into a scratch database, replay the deletion log, and confirm the purged ids are absent.
**Size for now:** Retention per entry, purge jobs, 30-day backup expiry, a deletion log for restore replay, third-party deletion calls. Per-record crypto-shredding waits for a contract or a store you cannot delete from.

### COMP-03 Data subject requests: access and erasure

**How it fails:** A person asks for a copy of their data or for erasure. Nobody knows where their records are; engineers run ad hoc queries by email across production; the deadline passes; the export misses attachments or includes other people's data; erasure deletes data the company must keep (invoices) or misses copies. In B2B, the request often arrives at the customer (the controller), who then needs the product to find and act on the data quickly.
**Seen in the wild:** No specific enforcement case cited. Obligations the design must meet: respond without undue delay and within one month, extendable by two further months for complex or numerous requests with notice inside the first month (GDPR Art. 12(3)); free of charge unless manifestly unfounded or excessive (12(5)); identity may be confirmed when there is reasonable doubt (12(6)) [5]. Access includes a copy of the data and information on purposes, recipients and retention, without adversely affecting others' rights (Art. 15) [6]. Erasure has listed grounds and exceptions, including legal obligations and legal claims (Art. 17) [7]. A processor must contract to help the controller answer such requests (Art. 28(3)) [8].
**Spot it in a plan:** "the customer wants this person removed", "export a user's data", "a contact asked us to forget them", "support will handle it".
**Spot it in code:** No function that finds a person across stores; deletions by email with no tenant scope; exports built by hand; no record of requests and their completion.
**Build it right:** A subject-request service, driven by the inventory (COMP-01) and the store registry (TEN-11): `find(tenant_id, identifiers)` returns every record keyed to that person in each store; `export` produces a structured archive with the tenant's records only; `erase` deletes or anonymizes, applies documented holds (invoices, legal hold) and logs what was kept and why. A request record tracks received date, due date, identity check, actions and completion, so deadlines are visible. Tenant admins can trigger it for their own data subjects through the admin UI or API.

Dangerous:
```python
# run by an engineer from a laptop
db.execute("DELETE FROM contacts WHERE email = %s", (email,))   # every tenant; misses files, index, provider copies
```

Safe:
```python
def erase_subject(req: SubjectRequest) -> ErasureReport:
    assert req.identity_verified and req.tenant_id
    report = ErasureReport(request_id=req.id)
    for store in SUBJECT_STORES:                                  # derived from the data inventory
        for rec in store.find(req.tenant_id, req.identifiers):    # email, phone, provider ids
            hold = holds.applicable(req.tenant_id, store.name, rec)   # e.g. invoices kept for tax law
            if hold:
                store.minimize(rec, keep=hold.fields)
                report.kept(store.name, rec.id, hold.reason)
            else:
                store.delete(rec)
                report.deleted(store.name, rec.id)
    audit.write(actor=req.actor, tenant_id=req.tenant_id, action="dsr.erasure_completed",
                details=report.summary())                         # summary of counts, no erased values
    return report
```

**Prove it:** Seed one person's data across every store in two tenants. Run erasure for tenant A; tenant A has no records for the person except held fields, tenant B is untouched, and the audit entry contains counts but not the erased values. Run export; the archive contains every seeded record for A and nothing about other people.
**Size for now:** Find, export and erase driven by the inventory, a request tracker with due dates, and an admin trigger. A self-serve privacy portal waits for request volume.

### COMP-04 Lawful basis and consent basics

**How it fails:** The product processes personal data for a new purpose (marketing emails to contacts, training a model on customer data, enrichment) without anyone deciding the basis. Consent, where it is the basis, is pre-ticked, not recorded, or not withdrawable, so it cannot be demonstrated. A purpose added later quietly reuses data collected for another.
**Seen in the wild:** The Twitter case (COMP-01) is the canonical purpose-drift example [1]. GDPR Article 6(1) lists the six lawful bases (consent, contract, legal obligation, vital interests, public task, legitimate interests) [9].
**Spot it in a plan:** "use customer data to improve the model", "email all contacts about the new feature", "auto-enroll", "opt out if they do not want it".
**Spot it in code:** Boolean `marketing_opt_in DEFAULT true`; consent stored without timestamp, text version or source; purposes not checked at the point of use.
**Build it right:** For each purpose in the inventory, record the basis chosen by counsel. Where the basis is consent, store consent events (subject, purpose, granted or withdrawn, text version, source, time) and check the latest event at the point of use. Defaults are off. Withdrawal is as easy as granting and takes effect on the next use. Processing on behalf of a customer (processor role) follows the customer's instructions and contract; do not invent new purposes for that data (for example model training) without a contractual basis.

Dangerous:
```sql
ALTER TABLE contacts ADD COLUMN marketing_opt_in boolean NOT NULL DEFAULT true;
```

Safe:
```sql
CREATE TABLE consent_events (
  tenant_id     uuid NOT NULL,
  subject_id    uuid NOT NULL,
  purpose       text NOT NULL CHECK (purpose IN ('product_marketing', 'ai_training')),
  granted       boolean NOT NULL,
  text_version  text NOT NULL,          -- which wording the person saw
  source        text NOT NULL,          -- 'signup_form', 'preferences_page', 'api'
  at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON consent_events (tenant_id, subject_id, purpose, at DESC);
-- at use: latest event per purpose must be granted = true; no row means no consent
```

**Prove it:** Create a subject with no consent events and run the marketing send; nothing is sent. Grant, then withdraw; the next run after withdrawal sends nothing. Each send record links to the consent event that allowed it.
**Size for now:** Basis per purpose in the inventory and the consent event table for consent-based purposes. A consent management platform waits for consumer-facing marketing at scale.

### COMP-05 Processing agreements and subprocessors, including LLM providers

**How it fails:** Engineers add a new SaaS tool, error tracker, email provider or LLM API, and customer personal data starts flowing to it. There is no DPA, it is not on the published subprocessor list, customers were not notified, its retention or training terms are unknown, or it processes data in a region the customer's contract excludes. Enterprise customers find out through their own review and escalate.
**Seen in the wild:** No specific enforcement case cited. GDPR Article 28(2) requires a processor to have the controller's prior specific or general written authorization for subprocessors and, under general authorization, to inform the controller of changes so it can object; 28(3) lists required contract terms including documented instructions, confidentiality, security, assistance with data subject requests and deletion or return at the end [8]. Provider terms differ: OpenAI, for example, documents 30-day default abuse-monitoring retention, no training on API data by default, and zero data retention only with approval [10].
**Spot it in a plan:** "add Sentry/Datadog/Segment", "call OpenAI/Anthropic/Google for this", "use a transcription API", "send to a webhook the customer configured".
**Spot it in code:** New SDK imports for external services; new outbound hostnames; environment variables for new API keys; LLM calls without a provider allowlist check.
**Build it right:** A subprocessor registry in code (name, purpose, data categories, region, retention mode, DPA status), mirrored by the public list. Outbound clients for processors are created only through a factory that checks the registry and the tenant's contractual restrictions (some enterprise contracts exclude specific providers or regions, or AI processing entirely; see `multi-tenancy` TEN-10). CI flags new outbound SDKs or hostnames for review. Adding a subprocessor triggers the customer notice workflow before data flows.

Dangerous:
```ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });   // added in a feature PR; not on any list
export const summarize = (text: string) => openai.responses.create({ model: "some-model", input: text });
```

Safe:
```ts
// compliance/subprocessors.ts (mirrored on the public subprocessor page)
export const SUBPROCESSORS = {
  openai:    { purpose: "AI drafting", data: ["message content"], region: "US", retention: "abuse-monitoring-30d", dpa: true },
  anthropic: { purpose: "AI triage",   data: ["message content"], region: "US", retention: "per contract",        dpa: true },
} as const;

export function processorClient<K extends keyof typeof SUBPROCESSORS>(name: K, tenant: TenantSettings) {
  const sp = SUBPROCESSORS[name];
  if (!sp.dpa) throw new Error(`no DPA for ${name}`);
  if (tenant.excludedProcessors.includes(name)) throw new ProcessorExcluded(name);
  if (!tenant.allowedRegions.includes(sp.region)) throw new RegionNotAllowed(name, sp.region);
  return clients[name];
}
```

**Prove it:** A test tenant whose contract excludes a provider runs every AI feature; no request reaches that provider (check with a recording proxy). CI fails a PR that adds a new HTTP client hostname without a registry entry.
**Size for now:** Registry, factory check, public list, notice workflow. Automated DPA tracking waits for many vendors.

### COMP-06 Audit logs: who did what, immutable

**How it fails:** There is no record of sensitive actions, or it is a normal table the application can update and delete, or it records "something changed" without the actor, tenant and target. After an incident or a customer question ("who exported our contacts?", "who gave this user admin?") there is no trustworthy answer. Or the audit log itself becomes a store of personal data with no retention.
**Seen in the wild:** No specific incident cited. SOC 2's common criteria include monitoring system components for anomalies and evaluating security events (CC7.2, CC7.3, per a secondary summary of the AICPA criteria) [11], which an audit trail supports.
**Spot it in a plan:** "admin can change roles", "export data", "support access", "connect an integration", "delete workspace", a security questionnaire asking for audit logs.
**Spot it in code:** Sensitive handlers with no audit write; audit writes outside the transaction of the action (so one can exist without the other); `UPDATE`/`DELETE` grants on the audit table; audit details that copy full records.
**Build it right:** One `audit.write` helper that records time, tenant, actor (user, staff with support grant, system, API token), action from a fixed vocabulary, target, request id and a small details object without content bodies. It runs in the same transaction as the action. The table is append-only from the app's perspective: no `UPDATE`/`DELETE`/`TRUNCATE` grant to the app role and a trigger that rejects updates and deletes. Copy entries to write-once external storage for tamper evidence. Actor references are ids, so erasing a person can pseudonymize them without rewriting history. Define the audit log's own retention.

Dangerous:
```sql
CREATE TABLE audit (id serial, message text);          -- app can UPDATE and DELETE; no actor, tenant or target
GRANT ALL ON audit TO app_rw;
```

Safe:
```sql
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,                 -- 'user:<id>', 'staff:<id>/grant:<id>', 'system', 'token:<id>'
  action     text NOT NULL,                 -- fixed vocabulary, e.g. 'member.role_changed', 'data.exported'
  target     text,
  request_id text,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb
);
REVOKE ALL ON audit_log FROM app_rw;
GRANT SELECT, INSERT ON audit_log TO app_rw;
GRANT USAGE ON SEQUENCE audit_log_id_seq TO app_rw;
CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
```

**Prove it:** As `app_rw`, attempt `UPDATE`, `DELETE` and `TRUNCATE` on `audit_log`; all fail. Perform each sensitive action from the vocabulary in a test; exactly one matching entry exists per action, and forcing a rollback after the action leaves neither the change nor the entry.
**Size for now:** The table, helper, grants, trigger and a nightly copy to write-once storage. Hash chaining and a customer-facing audit export wait for an enterprise ask (see `multi-tenancy` TEN-13).

### COMP-07 SOC 2 controls engineers touch: access reviews and change management

**How it fails:** Engineers share a production database password, have standing admin in the cloud console, and deploy from laptops. Nobody reviews who has access, so people who changed roles or left keep it. Changes reach production without review or a record of approval. When the SOC 2 auditor asks for evidence of access reviews and change approvals over the period, it does not exist.
**Seen in the wild:** No specific incident cited. The relevant criteria, as summarized by a secondary source (the authoritative text is the AICPA 2017 Trust Services Criteria, revised 2022): CC6.1 logical access security, CC6.2 registering and removing users, CC6.3 role-based access with least privilege and segregation of duties, CC8.1 authorizing, designing, testing, approving and implementing changes [11]. AICPA lists SOC 2 as reporting on security, availability, processing integrity, confidentiality and privacy [12].
**Spot it in a plan:** "give the contractor prod access", "hotfix directly", "shared admin account", "deploy from my machine".
**Spot it in code:** Deploy workflows triggered without branch protection; shared credentials in a password manager used by many; IAM bindings to individuals with owner roles; no CODEOWNERS for infrastructure; database access outside an audited path.
**Build it right:** Production access is per person, through SSO, granted to groups, reviewed quarterly from an exported list (who, what, last used), and removed by offboarding automation. Break-glass access is time-boxed and logged. Every production change goes through a protected main branch (pull request, required review, required checks) and a deploy pipeline whose production environment requires approval; the pipeline's run history is the evidence. Infrastructure is code under the same rules.

Dangerous:
```yaml
on: workflow_dispatch              # anyone with write access can deploy any branch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
        env: { PROD_DB_URL: "${{ secrets.PROD_DB_URL }}" }   # repository-wide secret
```

Safe:
```yaml
on:
  push:
    branches: [main]               # main is protected: PR, 1 approving review, required checks
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production        # environment requires a reviewer; secrets scoped to this environment
    permissions: { contents: read, id-token: write }
    steps:
      - uses: actions/checkout@<full-commit-sha>
      - run: ./deploy.sh           # short-lived cloud credentials via OIDC
```

**Prove it:** Attempt to push directly to `main` and to deploy from a feature branch; both are blocked. Export the access list; every entry maps to a current employee and role, and a departed test account has no access within the offboarding SLA.
**Size for now:** SSO-based access, quarterly review from an export, protected branches and environment approvals. A compliance automation platform helps gather evidence once the audit is scheduled; it does not replace the controls.

### COMP-08 Encryption in transit and at rest

**How it fails:** TLS terminates at the load balancer and internal hops (service to database, service to cache, service to queue) run in plaintext or with certificate verification off. Backups and exports land unencrypted in a bucket. Encryption at rest is enabled, but the same compromised process holds the key, so it adds little against the threat that matters.
**Seen in the wild:** In the CircleCI breach (January 2023), customer secrets were encrypted at rest, but the attacker extracted encryption keys from a running process, so the encrypted data may have been accessible [13]. SOC 2 CC6.7 concerns restricting transmission and movement of information (secondary summary) [11].
**Spot it in a plan:** "internal network is trusted", "the database is in a private subnet", "export to a bucket", "the provider encrypts by default".
**Spot it in code:** `sslmode=disable` or `prefer` in database URLs; `verify=False`, `rejectUnauthorized: false`, `InsecureSkipVerify: true`; `redis://` instead of `rediss://`; exports written without server-side encryption settings.
**Build it right:** TLS with certificate verification on every hop, including database (`sslmode=verify-full` with the provider's CA) and cache. Managed encryption at rest for databases, disks, buckets and backups. Application-level envelope encryption with a KMS for the most sensitive fields (OAuth refresh tokens, API keys), with decryption permission limited to the services that need it (see `security` SEC-10). Lint for verification-disabling flags.

Dangerous:
```python
conn = psycopg.connect("postgresql://app@db.internal:5432/app?sslmode=prefer")  # silently falls back to plaintext
r = requests.get(CRM_URL, headers=auth, verify=False)
```

Safe:
```python
conn = psycopg.connect(
    host=DB_HOST, dbname="app", user="app_rw", password=db_password_from_secret_manager(),
    sslmode="verify-full", sslrootcert="/etc/ssl/certs/db-provider-ca.pem",
)
r = requests.get(CRM_URL, headers=auth, timeout=10)   # default verification on
```

**Prove it:** Point the app at a database that does not offer TLS; connection fails. Put an intercepting proxy with an untrusted certificate in front of the CRM; requests fail. A CI grep for `verify=False`, `rejectUnauthorized: false` and `sslmode=disable` returns nothing.
**Size for now:** Verified TLS everywhere, managed encryption at rest, KMS for tokens. Customer-managed keys wait for a contract.

### COMP-09 Google API user data policy and restricted scopes

**How it fails:** The product asks for broad Gmail access (`https://mail.google.com/` or `gmail.readonly`) because it is easiest. Those are restricted scopes, so the app needs Google's restricted-scope verification, including an annual third-party security assessment, before it can be used broadly; the launch slips by weeks. Separately, data obtained through these scopes is used for something beyond the user-facing feature (analytics, ads, sharing with a third party, people reading mail), breaching Limited Use.
**Seen in the wild:** No enforcement case cited. Documented rules: Google lists restricted Gmail scopes including full mail access, `gmail.readonly`, `gmail.metadata`, `gmail.modify`, `gmail.insert`, `gmail.compose`, `gmail.settings.basic` and `gmail.settings.sharing` [14]. Apps requesting restricted scopes must pass an annual security assessment under the App Defense Alliance CASA framework (based on OWASP ASVS), with tiering by user count and scopes, and revalidate every year [15]. The Limited Use rules allow use only to provide or improve prominent user-facing features, prohibit use for advertising, restrict transfers and human reading to listed exceptions, and do not apply to apps used only within your own domain [16].
**Spot it in a plan:** "read the user's inbox", "sync all email", "send from the user's Gmail", "analyze email for insights", "train on customer email".
**Spot it in code:** Scope strings in OAuth config; `mail.google.com`; `gmail.readonly` where only sending is needed; Gmail data flowing into analytics, data warehouses or model training pipelines.
**Build it right:** Choose the narrowest scope per feature and check it against Google's restricted list before building. Budget the verification and CASA assessment into the launch plan if any restricted scope is needed, and design the data flow to match what the assessment will review. Tag data obtained from Google APIs in the inventory (COMP-01) and block it from analytics, ads and training pipelines in code. Human access to such data requires the user's affirmative agreement or a security or legal reason, and is audited (COMP-06). The policy page did not address AI model training when checked; read the current policy and its FAQs before using Workspace data for any model training.

Dangerous:
```ts
const SCOPES = ["https://mail.google.com/"];                         // restricted; feature only sends replies
oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES });
warehouse.load("gmail_messages", messages);                          // Gmail data into analytics
```

Safe:
```ts
// Sending only: gmail.send is not on Google's restricted Gmail scope list (checked against the list; recheck before launch)
const SCOPES = ["https://www.googleapis.com/auth/gmail.send"];
oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, state });

// any pipeline step that exports data refuses Google-sourced records
export function assertExportable(rec: { source: DataSource }) {
  if (rec.source === "google_workspace") throw new Error("Limited Use: Google user data cannot leave the feature path");
}
```

**Prove it:** A test reads the OAuth configuration and fails if any scope on the restricted list is present without a linked verification ticket. Run the analytics export over a fixture containing Google-sourced records; it refuses them.
**Size for now:** Narrow scopes and the export guard. If a feature truly needs inbox reading, plan the restricted-scope verification and CASA assessment as a launch dependency with weeks of lead time; do not discover it at launch.

### COMP-10 Slack Marketplace and security review

**How it fails:** The app requests many scopes "to be safe", stores tokens loosely, and has no clear architecture story. Slack's Marketplace security review asks why each scope is needed and tests the app; the listing is rejected or delayed. Later, a material change ships without re-review and the listing is at risk.
**Seen in the wild:** No incident cited. Slack documents that its security review covers all infrastructure needed for core functionality, includes automated web and network scanning, manual verification that scopes follow least privilege, manual functional testing and architecture review; reviewers want test accounts per permission level and an architecture diagram helps; material changes trigger re-review and failing it can lead to delisting [17].
**Spot it in a plan:** "list in the Slack Marketplace", "ask for all scopes up front", "add a new Slack feature after listing".
**Spot it in code:** App manifests with broad scopes (`channels:history`, `groups:history`, `users:read.email`, admin scopes) not used by code; tokens stored in plaintext; missing request signature verification.
**Build it right:** A manifest whose scopes each map to a feature and a code path (keep the mapping next to the manifest). Request signature verification on every endpoint and encrypted token storage (`security` SEC-03, SEC-10). Per-installation token handling (`multi-tenancy` TEN-14). Keep an up-to-date architecture diagram and test accounts per role ready for reviewers. Treat a new scope or a new data flow as a re-review trigger and plan for it.

Dangerous:
```yaml
oauth_config:
  scopes:
    bot: [channels:history, groups:history, im:history, mpim:history, users:read, users:read.email,
          chat:write, chat:write.customize, files:read, files:write, reactions:write]
```

Safe:
```yaml
# each scope maps to a feature and a code path in compliance/slack-scopes.md
oauth_config:
  redirect_urls:
    - https://app.acme.example/slack/oauth/callback
  scopes:
    bot:
      - commands        # /acme slash command
      - chat:write      # post approved summaries to channels the app is invited to
```

**Prove it:** A script diffs the manifest scopes against the scope-to-feature table and against Slack API methods called in code; any scope without a feature or a call fails CI. Run the reviewer test plan with each test account before submission.
**Size for now:** Minimal scopes with the mapping, signature verification, encrypted tokens, diagram and test accounts. Formal external pen testing before listing only if the review or customers ask.

### COMP-11 Email law and bulk sender rules

**How it fails:** The product sends follow-ups or sequences on behalf of users. Commercial messages go out without an opt-out, the opt-out link only works on GET (so mail scanners unsubscribe people, or it does not work in one click), opt-outs are not honored across all of a sender's campaigns, or are honored too late. Gmail starts filtering or rejecting the mail; regulators can fine per message.
**Seen in the wild:** No specific case cited. CAN-SPAM requires accurate header information, non-deceptive subject lines, identification as an ad, a valid physical postal address, and a clear opt-out; opt-outs must be honored within 10 business days, the mechanism must work for at least 30 days after sending, and each violating email can draw penalties up to $53,088; transactional or relationship messages are mostly exempt [18]. Gmail's bulk sender rules (about 5,000 or more messages a day to personal accounts) require SPF, DKIM, DMARC, RFC 8058 one-click unsubscribe for marketing mail, honoring unsubscribes within 48 hours, and a user-reported spam rate kept below 0.1% and never reaching 0.3% [19]. RFC 8058 requires `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, an HTTPS URI, a DKIM signature covering both headers, a POST without cookies or auth, and no redirect in response [20].
**Spot it in a plan:** "send a sequence", "bulk follow-up", "newsletter", "send as the user from their mailbox", "unsubscribe link".
**Spot it in code:** Outbound mail without `List-Unsubscribe` headers; unsubscribe handlers on `GET`; unsubscribe requiring login; no suppression check before send; suppression per campaign instead of per sender and recipient.
**Build it right:** Classify each message type as commercial or transactional with counsel, in code (a `kind` field). Commercial messages carry `List-Unsubscribe` with an HTTPS one-click URI (and optionally `mailto:`) plus `List-Unsubscribe-Post`, DKIM-signed; the POST handler accepts form bodies, needs no session, verifies a signed token, records the suppression and returns 200 without redirect. A GET on the same URL shows a confirmation page and does not unsubscribe. A suppression list keyed by tenant and recipient is checked before every commercial send. Include the sender's postal address. Monitor spam rate where you control the sending domain. When mail goes out through the user's own mailbox, the user is the sender, but the product still provides and honors the opt-out for the sequences it runs.

Dangerous:
```ts
app.get("/unsubscribe", requireSession, async (req, res) => {          // GET, needs login
  await db.campaignMember.update({ where: { id: String(req.query.m) }, data: { optedOut: true } }); // one campaign only
  res.redirect("/unsubscribed");
});
```

Safe:
```ts
// when sending a commercial message
const token = signUnsubscribeToken({ tenantId, recipient, sender: senderId });   // HMAC, no expiry within 60 days
headers["List-Unsubscribe"] = `<https://mail.acme.example/u/${token}>`;
headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";

// one-click endpoint: POST, no cookies, no auth, no redirect
app.post("/u/:token", express.urlencoded({ extended: false }), multipartFields, async (req, res) => {
  const t = verifyUnsubscribeToken(req.params.token);
  if (t) await suppressions.upsert({ tenantId: t.tenantId, recipient: t.recipient, scope: "all_commercial", source: "one_click" });
  res.status(200).send("You are unsubscribed.");
});
app.get("/u/:token", (req, res) => res.render("confirm-unsubscribe", { token: req.params.token })); // GET never unsubscribes

// before every commercial send
if (await suppressions.isSuppressed(tenantId, recipient)) return skip("suppressed");
```

**Prove it:** Send a test commercial message to a sink; headers include both `List-Unsubscribe` and `List-Unsubscribe-Post` and are covered by the DKIM signature. POST `List-Unsubscribe=One-Click` to the URI with no cookies; the next send to that recipient from any campaign is skipped. A GET to the URI changes nothing.
**Size for now:** Message kinds, one-click headers and endpoint, a tenant-wide suppression list, postal address in templates. A preference center with per-topic opt-outs waits for multiple marketing streams.

### COMP-12 Region and data residency

**How it fails:** Sales promises an EU customer that data stays in the EU. The database is in the EU, but backups replicate to the US, the LLM provider processes in the US, the error tracker and analytics are US-hosted, and support staff in other regions read data. Or personal data is transferred abroad on a mechanism a regulator later finds insufficient.
**Seen in the wild:** In May 2023 Ireland's Data Protection Commission fined Meta Ireland €1.2 billion for continuing EU-to-US transfers of personal data under standard contractual clauses after the CJEU's Schrems II judgment, and ordered transfers suspended within five months (GDPR Article 46(1)) [21]. On the provider side, OpenAI's documented residency is a per-project setting with regional storage in several regions but regional processing only in some, and it does not cover system data such as account data and usage metadata [10].
**Spot it in a plan:** "EU customer", "data must stay in region", "GDPR transfer", "Schrems", "where is our data stored?", "use our US LLM key for everyone".
**Spot it in code:** Single global bucket and database URL; LLM, analytics or error-tracker clients with fixed regions; backups with cross-region replication; no `region` on the tenant.
**Build it right:** A `region` on every tenant from day one, even if all are `us`. All region-bound resources (database, buckets, search, queues, LLM endpoints) are looked up by tenant region through one function, so adding a region is configuration plus a deployment, not a refactor. Every subprocessor records where it stores and processes data (COMP-05); the factory refuses to send a region-bound tenant's data to a processor outside its allowed regions. Backups and replicas stay in region. Transfers that do happen are documented with their mechanism, decided by counsel.

Dangerous:
```ts
const s3 = new S3Client({ region: "us-east-1" });
const llm = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });   // US processing for every tenant
export const store = (tenantId: string, key: string, body: Buffer) =>
  s3.send(new PutObjectCommand({ Bucket: "acme-uploads", Key: `${tenantId}/${key}`, Body: body }));
```

Safe:
```ts
const REGIONS = {
  us: { bucket: "acme-uploads-us", s3: new S3Client({ region: "us-east-1" }),    llm: "openai-us" },
  eu: { bucket: "acme-uploads-eu", s3: new S3Client({ region: "eu-central-1" }), llm: "openai-eu" },
} as const;

export function regional(tenant: { id: string; region: keyof typeof REGIONS }) {
  const r = REGIONS[tenant.region];
  if (!r) throw new Error(`unknown region for tenant ${tenant.id}`);
  return r;
}
export const store = (tenant: TenantRef, key: string, body: Buffer) => {
  const r = regional(tenant);
  return r.s3.send(new PutObjectCommand({ Bucket: r.bucket, Key: `tenants/${tenant.id}/${key}`, Body: body }));
};
```

**Prove it:** Create an EU test tenant and run every feature with a recording egress proxy; every destination is an EU endpoint or a processor whose registry entry allows EU data. A CI check fails on any S3, database or LLM client constructed outside the `regional` module.
**Size for now:** The tenant `region` column, the lookup function, region fields in the subprocessor registry. A second region deployment waits for a signed customer who needs it; the column and lookup make it a project of weeks, not a rewrite.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "We might need the raw payload later." | Unneeded personal data is risk without a purpose, and it must be found, exported and deleted on request. | Parse at the boundary; inventory what you keep (COMP-01). |
| "Soft delete is deletion." | The data is still there, in every copy. | Purge jobs, backup expiry, third-party deletion (COMP-02). |
| "We will handle data requests manually when they come." | Manual searches across stores miss copies and miss deadlines. | A find/export/erase service driven by the inventory (COMP-03). |
| "They agreed to the terms, so we can use the data for anything." | Each purpose needs a basis; reusing data for a new purpose is how the Twitter case happened. | Basis per purpose, consent events where consent is the basis (COMP-04). |
| "It is just an API call to an LLM." | It is a transfer of customer data to a subprocessor with its own retention and region. | Registry, DPA, factory check (COMP-05). |
| "Our logs are the audit trail." | Logs are mutable, sampled, rotated and lack actor and target. | A dedicated append-only audit log (COMP-06). |
| "We are too small for access reviews." | The auditor will ask for evidence regardless of size, and departures happen at any size. | SSO access, quarterly review from an export (COMP-07). |
| "The private network is safe." | Internal traffic is where attackers move after the first foothold. | Verified TLS on every hop (COMP-08). |
| "Full Gmail scope is simpler." | Restricted scopes add a verification and annual assessment, and broaden what a breach exposes. | Narrowest scope per feature; plan CASA if truly needed (COMP-09). |
| "The user sends the email, so unsubscribe is their problem." | The product runs the sequence and controls whether opt-outs are honored. | One-click unsubscribe and a suppression list (COMP-11). |
| "Our database is in the EU, so we have residency." | Backups, processors, analytics and support access also move data. | Region-aware lookups and processor region checks (COMP-12). |

## Attack recipes

1. **Unlisted column.** Add a `phone_alt` column in a branch and open a PR. If CI passes without a data inventory entry, COMP-01 failed.
2. **Deletion sweep.** Seed a person with a canary email across rows, attachments, search, vector index, cache, error-tracker events and an LLM provider file in a test tenant; run erasure; search every store (and a restored backup after replaying the deletion log) for the canary. Any hit means COMP-02 or COMP-03 failed.
3. **Cross-tenant erasure.** Seed the same email in two tenants and run erasure for one. Any change in the other means COMP-03 failed.
4. **Consent default.** Create a contact through every creation path (UI, API, import, sync) and run the marketing send. Any message sent without a granting consent event means COMP-04 failed.
5. **Rogue processor.** Configure a test tenant that excludes provider X and run all AI and analytics features through a recording proxy. Any request to X means COMP-05 failed.
6. **Audit tamper.** As the app's database role, try `UPDATE`, `DELETE` and `TRUNCATE` on the audit table, and perform a role change with a forced rollback. Any successful modification, or an audit row without the change (or the reverse), means COMP-06 failed.
7. **Unreviewed deploy.** Try to deploy from a feature branch, push directly to `main`, and run the deploy workflow manually without approval. Any that reaches production means COMP-07 failed.
8. **TLS downgrade.** Put a proxy with a self-signed certificate between the app and the database, cache and one external API. Any successful connection means COMP-08 failed.
9. **Scope creep.** Grep the OAuth and Slack manifests for scopes; for each, find the feature and code path that uses it. Any restricted Gmail scope without a verification ticket, or any Slack scope without a code path, means COMP-09 or COMP-10 failed.
10. **Scanner unsubscribe.** Issue a GET (as a mail scanner would) to the unsubscribe URI, then a cookie-less POST with `List-Unsubscribe=One-Click`. If the GET unsubscribes, the POST does not, the POST redirects, or a later campaign still mails the recipient, COMP-11 failed.
11. **Residency egress.** For an EU tenant, record all outbound connections during a full feature run. Any destination outside allowed regions for that tenant means COMP-12 failed.

## Sources

1. Federal Trade Commission, "FTC Charges Twitter with Deceptively Using Account Security Data to Sell Targeted Ads" (25 May 2022). https://www.ftc.gov/news-events/news/press-releases/2022/05/ftc-charges-twitter-deceptively-using-account-security-data-sell-targeted-ads
2. GDPR Article 30, Records of processing activities (gdpr-info.eu). https://gdpr-info.eu/art-30-gdpr/
3. Simmons & Simmons, "Data graveyard: Berlin DPA fines real estate company EUR 14.5m for GDPR violations" (November 2019). https://www.simmons-simmons.com/en/publications/ck3irb5h14o5o0b48f8ee9g5e/data-graveyard-berlin-dpa-fines-real-estate-company-eur-14-5m-for-gdpr-violations
4. UK ICO, Right to erasure. https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/
5. GDPR Article 12 (gdpr-info.eu). https://gdpr-info.eu/art-12-gdpr/
6. GDPR Article 15, Right of access (gdpr-info.eu). https://gdpr-info.eu/art-15-gdpr/
7. GDPR Article 17, Right to erasure (gdpr-info.eu). https://gdpr-info.eu/art-17-gdpr/
8. GDPR Article 28, Processor (gdpr-info.eu). https://gdpr-info.eu/art-28-gdpr/
9. GDPR Article 6, Lawfulness of processing (gdpr-info.eu). https://gdpr-info.eu/art-6-gdpr/
10. OpenAI, "Data controls in the OpenAI platform" (your data). https://developers.openai.com/api/docs/guides/your-data
11. Bytebase, "Database Access Control for SOC 2: CC6, CC7, and CC8 at the Database" (secondary summary of AICPA criteria). https://www.bytebase.com/blog/database-access-control-for-soc2/
12. AICPA & CIMA, System and Organization Controls (SOC) suite of services. https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services
13. CircleCI, "CircleCI incident report for January 4, 2023 security incident". https://circleci.com/blog/jan-4-2023-incident-report/
14. Google Cloud Help, restricted scope verification (Gmail restricted scopes list). https://support.google.com/cloud/answer/13464325
15. Google Cloud Help, security assessment for restricted scopes (CASA). https://support.google.com/cloud/answer/13465431
16. Google, Google API Services User Data Policy. https://developers.google.com/terms/api-services-user-data-policy
17. Slack, Slack Security Review (Marketplace). https://docs.slack.dev/slack-marketplace/marketplace-terms-conditions/slack-security-review
18. Federal Trade Commission, CAN-SPAM Act: A Compliance Guide for Business. https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
19. Google Workspace Admin Help, Email sender guidelines (bulk sender requirements). https://support.google.com/a/answer/14229414
20. IETF RFC 8058, Signaling One-Click Functionality for List Email Headers. https://datatracker.ietf.org/doc/html/rfc8058
21. Data Protection Commission (Ireland), conclusion of inquiry into Meta Ireland data transfers (22 May 2023). https://www.dataprotection.ie/en/news-media/press-releases/Data-Protection-Commission-announces-conclusion-of-inquiry-into-Meta-Ireland
