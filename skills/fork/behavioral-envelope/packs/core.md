# Core (always selected)

Spans the quality characteristics of S1 at the level every change needs.

### CORE-01 Purpose met, not just compiled
- **Ask:** What observable result proves the change does its job for its user?
- **Right way:** Write the done condition as checkable examples before code, including what must not happen.
- **Proof:** Each example run against the real artifact, with output captured.

### CORE-02 Inputs at the boundary
- **Ask:** What inputs reach this change (empty, huge, malformed, unicode, duplicate, hostile), and where are they rejected?
- **Right way:** Validate and parse once at the system boundary; trust internal types after that.
- **Proof:** Boundary tests with the bad inputs, asserting a clear rejection.

### CORE-03 Every failure has a visible outcome
- **Ask:** When a step fails, what does the user, the caller and the operator each see?
- **Right way:** No swallowed errors. Each failure maps to a defined user-facing state and a logged, searchable record.
- **Proof:** A test or live run that forces the failure and shows each outcome.

### CORE-04 Partial failure leaves a correct state
- **Ask:** If the process dies between any two steps, what is persisted, and does a retry converge or duplicate?
- **Right way:** Order writes so every crash point is safe, or make the steps idempotent (S10).
- **Proof:** A test that interrupts at the risky step and retries.

### CORE-05 Existing behavior unchanged where not intended
- **Ask:** What else calls or depends on what this change touches?
- **Right way:** Find the callers and consumers beyond the diff; keep their contract or migrate them in the same change.
- **Proof:** Callers' tests pass, plus one run of the most important caller path.

### CORE-06 Observable in production
- **Ask:** How will you know, without a user telling you, that this broke?
- **Right way:** Errors reported, key outcomes counted, alerts on symptoms the user feels (S7).
- **Proof:** The metric or log line seen once in a real or staging run.

### CORE-07 Reversible
- **Ask:** How is this undone if it misbehaves after deploy?
- **Right way:** Revertable commit, feature flag, or a written roll-forward plan for one-way changes (data, external effects).
- **Proof:** Rollback path named in the PR; for flags, the off state tested.

### CORE-08 Smallest change that does the job
- **Ask:** Is there code, abstraction, option or dependency here that the purpose does not need?
- **Right way:** Remove dead weight first, then add. No speculative generality.
- **Proof:** Every added piece traces to a property in the envelope's purpose line.

### CORE-09 Tests assert behavior, not implementation
- **Ask:** Would the tests still pass if the logic were wrong?
- **Right way:** Call the code the way users do; assert literal expected values derived from the requirement.
- **Proof:** A deliberately broken version fails the tests.

### CORE-10 Cost and performance stay in budget
- **Ask:** Does the change add work per request, per user or per item that grows with scale?
- **Right way:** Name the expected volume; avoid per-item network calls and unbounded loops; set a budget where cost is per call.
- **Proof:** Measurement at realistic size, or a stated reason none is needed.
