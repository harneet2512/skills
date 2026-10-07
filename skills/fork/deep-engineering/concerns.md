# Concern discovery prompts

Discovery aid, not a checklist. For each prompt ask "does the system model make this live for *this* change?" Emit a line only when yes; otherwise fold into one `Irrelevant:` line. Add what is missing.

## State and data
- Who owns this state, and is there now a second writer or a second source of truth?
- What are the legal transitions? Who enforces them (type, constraint, trigger, code)? Can a retry or a late event move state backwards?
- Which DB constraints/triggers already guard this, and does my write path satisfy them at commit time (deferred constraints)?
- Migrations, backfills, existing rows: what do old rows look like to the new code?

## Time, ordering, concurrency
- Which clock? (wall vs. event/replay time, per-process vs. DB). Does any "as of" logic silently use the wrong one?
- Two callers at once; same caller twice; event delivered twice or out of order.
- Lock scope and transaction boundaries: is any slow or non-idempotent call (network, LLM) inside a transaction or lock?
- Leases, tokens, deadlines: do their lifetimes outlast the longest legitimate path?

## Failure and recovery
- Partial failure at each step: what is persisted, what is visible, what retries, does a retry converge or duplicate?
- Retryable vs terminal failures: does the failure state free or wedge the unit of work (uniqueness, open-run predicates)?
- Dependency down/slow: breakers, timeouts, budgets; does the new call path go through the same guard as its siblings?
- Idempotency key: what is it, who generates it, is it stable across retries?

## Boundaries and contracts
- Trust boundary and authorization: enforced where? Does data leak across account/tenant/visibility/time (e.g. future data in a replay)?
- API/schema contract and its conformance tests; mixed-version and rollout behavior.
- External system semantics (queues, SDKs, protocols, LLM providers): documented guarantee or assumption?
- Dry-run vs live: can the new path cause an external effect where the mode says it must not?

## Design quality
- Right layer? Existing abstraction already owns it? Transport-neutral core vs adapter logic?
- Illegal states representable? Hidden coupling or implicit ordering between steps?
- Names and types express domain intent (project glossary)?
- Speculative generality, accidental complexity, duplicated responsibility?
- Conventions of neighbouring code; will a future reader see why it is this way?

## Operability and cost
- Observability: can a stuck/failed unit be diagnosed from persisted records, not logs only?
- Performance/scale; resource lifecycle; cost per unit (tokens, API calls) and a budget.
- Determinism and reproducibility (replays, evals, cassettes, seeds); nondeterministic output that must be pinned.
- Config and secrets; rollback.

## Human surface
- UX failure states, accessibility, what the user sees when the backend part-fails.

## Testing
- Which seams are public? Which invariant needs which evidence form (example / table / state machine / property / concurrency / integration)?
- Is each expected value independent of the implementation?
