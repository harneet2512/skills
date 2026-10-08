# Identity and access

Users, roles, permissions, tenants, sessions, contact identity.

### ID-01 Tenant isolation
- **Ask:** Can any path return or change another tenant's data?
- **Right way:** Tenant scope enforced in every query, ideally by the database (row-level security) or a single scoped data layer (S9).
- **Proof:** Tests for each changed path as a user of another tenant.

### ID-02 Object-level authorization
- **Ask:** Within a tenant, is access checked per object and per role?
- **Right way:** Check on the server for every read and write; never trust ids or roles sent by the client (S9).
- **Proof:** Tests with a lower role and with another user's object id.

### ID-03 Internal versus external
- **Ask:** Can internal-only content (notes, admin fields) reach customers or the public?
- **Right way:** Visibility as a typed property; external views built from an allowlist.
- **Proof:** Test that internal items never render in external views.

### ID-04 Sessions
- **Ask:** What happens on logout, password change, role change or a shared computer?
- **Right way:** Invalidate sessions on these events; short-lived tokens; secure cookie flags.
- **Proof:** Test that an old session fails after logout and role change.

### ID-05 One person, many identities
- **Ask:** Does one person appear as several (email, chat, Slack), or do several share one address?
- **Right way:** Explicit merge with an audit trail and an undo; never auto-merge on weak signals.
- **Proof:** Tests for merge and unmerge.

### ID-06 Anonymous to signed in
- **Ask:** What happens to anonymous activity when the user signs in or signs up?
- **Right way:** Defined carry-over rule; no data from a previous user on a shared device.
- **Proof:** Test of the transition on a shared session.

### ID-07 Audit
- **Ask:** Can you tell who did what, when, for sensitive actions?
- **Right way:** Append-only audit records for permission, money and data-deletion actions.
- **Proof:** Audit record written in a test.

### ID-08 Passwords and sign-in
- **Ask:** Does the change store credentials or add a sign-in path?
- **Right way:** Slow password hashing (bcrypt, scrypt or argon2), never reversible; rate limits and lockout on attempts; MFA available; generic error messages that do not reveal which accounts exist (S9).
- **Proof:** Tests for hashing, the attempt limit and the error message.
