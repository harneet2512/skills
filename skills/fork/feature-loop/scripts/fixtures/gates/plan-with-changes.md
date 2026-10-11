# Plan: reply options

## Decisions

- Drafts offer three reply options, confirmed by the user in grilling.
- One reply per thread, never auto-sent.

## Size and why

normal: user-visible behavior with state, nothing irreversible. Slug `reply-options`.

## External dependencies

- Slack test workspace: present (by name). Model provider key: missing, stand-in is the local model endpoint.

## Files to create or change

- `src/replies.js`: add the options builder.

## Skeleton ticket

Ticket 1: one reply option through Slack to the stand-in inbox. Scenario `happy-path`.

## Tickets and seams

| Ticket | Blocked by | Journey cases | Live items | Seams |
|---|---|---|---|---|
| 1 skeleton | none | J1.happy | L1 | HTTP /replies |

## Skill per stage

shape, deep-engineering, to-spec, to-tickets, tdd, live-verify, wp-loop.

## Verification

Live scenario `happy-path`; unit tests at the HTTP seam.

## Failure modes

Double click sends two drafts: idempotency key per thread.

## Time box

none

## Concerns

Packs: core, api (triggering line: "reply endpoint").

## Design challenge

n/a: normal work with no Critical Live item.

## Open questions

## Changes

- Changed: the options builder lives in src/options.js instead of src/replies.js because replies.js already exceeds 800 lines
- Changed: seam moved to the Slack payload handler because the HTTP route does not exist yet

<!-- Changed: <what> because <why> -->
