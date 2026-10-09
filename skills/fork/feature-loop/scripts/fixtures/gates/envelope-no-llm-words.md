# Envelope: reply options

**Purpose:** let an agent offer reply options in a thread
**Properties:** one draft per message
**Packs:** core, api (no llm, no retrieval)
**Second pass:** not required

## Live

ID | Severity | Failure path | Mechanism | Enforced at | Proof | Runtime signal
---|:---:|---|---|---|---|---
OUT-01 | **Critical** | retry sends twice | M1 idempotency key | `outbound_sends` unique key, `a \| b` | injected timeout then retry: one call | duplicate-key count
  | API-03 |  High  | stale write | M2 version check | `PUT /replies` | two writers race test | 409 rate |

## Later

- none
