# Envelope: <change, in the project's GLOSSARY.md terms>

**Purpose:** <what the change is for, and for whom>
**Properties:** <what must hold for that purpose, comma separated>
**Packs:** <from detect-packs.sh --plan and --paths, with the triggering line for each> <+ any added by judgment, with why>
**Second pass:** <not required | done: model, and which Live items it added or disputed>

## Live

| ID | Severity | Failure path | Mechanism | Enforced at | Proof | Runtime signal |
|---|---|---|---|---|---|---|
| OUT-01 | Critical | `sendFollowUp` retries on timeout and calls the provider again (`src/mail/send.ts:sendFollowUp`) | M1 idempotency key per message | `outbound_sends` table, unique key | Injected timeout then retry: one provider call | Count of duplicate-key rejections |

## Mechanisms

| ID | Mechanism | Covers | Enforced at | Built in slice |
|---|---|---|---|---|
| M1 | Idempotency key per outbound message, written before the provider call | OUT-01, API-03, LLM-05 | Unique constraint on `outbound_sends.idempotency_key` | 1 (foundation) |

## Build plan

1. Foundation: <mechanisms several slices depend on>, proven by <proofs>
2. Slice: <thin end-to-end behavior>, carrying <Live IDs>
3. Rollout: <migration order, flag, backfill, staged enable>
4. Operate: <runtime signals wired to alerts before users get it>

## Later

- <ID>: <one line>, filed as <issue or note>

## N/A

- <ID>, <ID>, <ID>: <one clause each, or one clause for a group with the same reason>

## Extra (from purpose, not in any pack)

| Item | Failure path | Mechanism | Proof |
|---|---|---|---|

## Open questions

- <unverified item>: <what would settle it>, blocking | not blocking
