# Envelope: <change, in the project's GLOSSARY.md terms>

**Purpose:** <what the change is for, and for whom>
**Properties:** <what must hold for that purpose, comma separated>
**Packs:** <from detect-packs.sh, with the triggering line for each> <+ any added by judgment, with why>
**Second pass:** <not required | done: model, and which Live items it added or disputed>

## Live

| ID | Failure path in this code | Right way | Proof | Source |
|---|---|---|---|---|
| EMAIL-02 | `sendFollowUp` retries on timeout and calls the provider again (`src/mail/send.ts:sendFollowUp`) | Idempotency key per message, stored before the provider call, sent with it | Test: injected timeout then retry produces one provider call | packs/outbound.md, S4 |

## Later

- <ID>: <one line>, filed as <issue or note>

## N/A

- <ID>, <ID>, <ID>: <one clause each, or one clause for a group with the same reason>

## Extra (from purpose, not in any pack)

| Item | Failure path | Right way | Proof |
|---|---|---|---|

## Open questions

- <unverified item>: <what would settle it>, blocking | not blocking
