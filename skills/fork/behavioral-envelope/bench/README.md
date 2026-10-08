# Bench: is the envelope complete and consistent?

Two layers, measured separately.

## 1. Pack selection (deterministic)

`scripts/test-detect.sh` runs `detect-packs.sh` on the fixtures in `scripts/fixtures/` and checks the packs each must and must not select, plus that two runs give identical output. Run it after any change to the script or its patterns. Every escaped pack miss adds a fixture here.

## 2. Envelope answers (model judgment)

The model answers items, so its output can vary. Measure that variation instead of assuming it away.

For each case below, run the skill on the fixture (as if planning the change) **5 times in fresh contexts**, then score:

- **Recall**: the share of the case's must-be-Live items that each run marked Live, averaged over runs.
- **Agreement**: for every item in the selected packs, the share of runs that gave the majority answer, averaged over items.
- **False Live**: items marked Live with no failure path in the touched code.

A change to the skill or a pack must not lower recall or agreement on any case. Record each run's scores in the PR that changes the skill.

| Case (fixture) | Must be Live |
|---|---|
| `color-token.diff`: primary color token changed | VIS-01 contrast, VIS-02 states, VIS-04 every usage, VIS-05 themes |
| `resend-button.diff`: button that resends a message | UIB-01 double submit, API-03 retry safety, OUT-01 sent once, OUT-04 must not send, API-01 who may call, CORE-03 visible failure |
| `webhook-handler.diff`: email bounce webhook | IN-01 duplicates, IN-02 out of order, IN-04 authentic (verification shown is not proof of replay protection), IN-05 acknowledge fast, OUT-02 delivered states |
| `llm-reply.diff`: model drafts a reply | LLM-01 task-set grading, LLM-02 made-up facts, LLM-03 injection from the thread text, LLM-07 size and cost, LLM-08 provider failure, LLM-09 pinned model |
| `migration.diff`: column added with a default, plus an index | DATA-01 existing rows, DATA-02 lock at size (a plain `CREATE INDEX` blocks writes on Postgres; build it concurrently. The constant default does not rewrite the table on Postgres 11 and later), DATA-03 old version against new schema |
| `scheduled-send.diff`: follow-ups queued on a schedule | JOB-01 silent stop, JOB-02 overlapping runs, JOB-06 daylight saving, OUT-01 sent once (the script misses `outbound` here; the step 4 purpose pass must add it) |

The last case is deliberate: the script cannot see that a queue named `send-followup` sends email. It checks that the purpose step (step 4 of the skill) catches what patterns miss. If the purpose step misses it too, add a pattern and a fixture.
