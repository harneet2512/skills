# Plan: <feature name>

<!-- Fill every section below in plan mode, then approve once. `scripts/check-gates.sh --plan` lists any section that
is missing or empty. Keep the headings exactly as written: the loop finds each section by its heading text.
A section that does not apply says `n/a: <reason>`. Never leave TBD or a placeholder. -->

## Decisions

<!-- What `grilling` settled with the user: one line each, the requirement or choice and who confirmed it.
Open questions go in "Open questions" with a recommended default, never in this section. -->

## Size and why

<!-- small, normal or large, with the risk reasoning (see feature-loop "Size it first"), and the slug. -->

## External dependencies

<!-- Every key, sandbox account, test workspace, inbox and model provider the live run needs: present or missing
(by name only, never a secret), and the local stand-in used until a missing one arrives. -->

## Files to create or change

<!-- Paths, one line each, with what changes. A shared-contract change (API schema, DB schema, wire format) comes first. -->

## Skeleton ticket

<!-- Ticket 1: the thinnest path through the whole journey, real at every layer it touches, ending in one
happy-path live-verify scenario. Name the scenario. -->

## Tickets and seams

<!-- A table (Ticket, Blocked by, Journey cases, Live items, Seams) of tracer-bullet tickets with blocking edges. For each: journey cases, Live items, topic categories, and the
seams where its tests attach (existing seams preferred, the highest possible). Approving the plan confirms these seams. -->

## Skill per stage

<!-- The skill that runs at each loop stage, so nobody guesses: stage 1 shape, stage 2 deep-engineering, stage 3
to-spec then to-tickets, stage 4 tdd with code-review per slice, stage 5 evals and live-verify, stage 6
adversarial-review, stage 7 wp-loop merge gate, stage 9 retro. Say where this feature differs. -->

## Verification

<!-- How each Live item is proved (test, live-verify scenario, eval gate) and the command or scenario name. -->

## Failure modes

<!-- What breaks, for whom, and what the product does: the Critical and High items from the concerns, each with its
mechanism. -->

## Time box

<!-- The demo_by time (with a zone) when there is one, else `none`, and the order of cuts if time runs short. -->

## Concerns

<!-- Output of `behavioral-envelope/scripts/detect-packs.sh --plan <this file or the request>`: the packs selected and
the triggering lines. Run it while planning, so the concern checklist is part of the approved plan. -->

## Design challenge

<!-- The result of the read-only reviewer subagent that attacked this draft (design-challenge.md): CONFIRMED findings
with how each was resolved in this plan, PLAUSIBLE ones with the decision, and the cuts accepted. For small work with no
Critical item: `n/a: <reason>`. This section must be filled before the plan is approved. -->

## Open questions

<!-- Only when grilling hit its cap (3 rounds or 20 minutes): each open question with the recommended default, for one
yes-or-edit answer. Empty once approved. -->

## Changes

<!-- Written during the build, never before. One line per deviation from the plan, appended as it happens:
- Changed: <what differs from the plan> because <what the build found>
-->
