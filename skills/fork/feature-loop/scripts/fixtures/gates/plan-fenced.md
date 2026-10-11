# Plan: reply options

## Decisions

- Drafts offer three reply options.

## Size and why

normal: user-visible behavior with state.

## External dependencies

none: no external system

## Files to create or change

- `src/replies.js`

## Skeleton ticket

Ticket 1: one reply option end to end.

## Tickets and seams

1 skeleton, seam: HTTP /replies

## Skill per stage

shape, deep-engineering, to-spec, to-tickets, tdd, live-verify.

## Verification

```
## not a heading, a command in a block
npm test -- replies
```

## Failure modes

Double click: idempotency key.

## Time box

none

## Concerns

Packs: core.

## Design challenge

n/a: no Critical Live item.
