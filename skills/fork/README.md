# Fork

Skills this fork adds on top of upstream. Each one is shipped in the plugin. See [FORK.md](../../FORK.md) for what each one builds on and why it exists.

How they fit: `plan-first` plans, `codex-review` attacks the plan, and `feature-loop` runs the feature through `shape`, `deep-engineering` (which calls `behavioral-envelope`, `concern-topics` and `evals`), Matt's `to-spec` and `to-tickets`, `wp-loop` per ticket (which calls `tdd`, `live-verify` and `adversarial-review`), then ship and Matt's `retro`.

## User-invoked

- **[feature-loop](./feature-loop/SKILL.md)**: Take one feature from an approved plan to a PR the owner merges, telling the owner every step (fork.9): shape, design from concerns, a walking skeleton proven live first, build, prove (tests, evals, live verification), a codex code attack, then the owner's three stops. Hooks print each step and enforce gates G1 to G12; the owner merges.

## Model-invoked

- **[plan-first](./plan-first/SKILL.md)**: The planning half of the owner's workflow (fork.9): caps the grilling, ends it with 3 to 5 acceptance tests the owner confirms (stop 1), fills the plan template in plan mode, hands the plan to the codex plan review instead of implementing, and shows the owner the revised plan (stop 2) before `feature-loop` builds.
- **[codex-review](./codex-review/SKILL.md)**: A second model (OpenAI `gpt-6-astra`, through the local codex CLI) attacks the plan (read-only, before anything is built) or the finished branch (in a throwaway worktree, with a repro test for every claim). Reports are stamped with the plan hash or HEAD and feed gates G10 and G11.
- **[wp-loop](./wp-loop/SKILL.md)**: Ship one work package end to end: issue, engineering contract, branch, TDD, PR, green CI, two-axis review, verified fixes, gated merge, results comment.
- **[shape](./shape/SKILL.md)**: Intent, actors and surfaces, a journey map crossed with interaction cases, the success metric and the scope line, before any design.
- **[deep-engineering](./deep-engineering/SKILL.md)**: Build a system model from repo evidence, derive invariants and risks, and write an engineering contract before any spec or code.
- **[behavioral-envelope](./behavioral-envelope/SKILL.md)**: Find every concern a change must satisfy, with concern packs picked by a script from the code and every item answered, so no run skips the basics.
- **[concern-topics](./concern-topics/SKILL.md)**: Thirteen fixed engineering topics with categories that say how things fail, how to build them right, how to prove it and how to attack it, plus a slop detector.
- **[evals](./evals/SKILL.md)**: Success criteria, case sets, calibrated judges, error bars, paired comparisons and merge gates for anything that calls an LLM.
- **[live-verify](./live-verify/SKILL.md)**: Run the real app in the cloud against recording stand-ins for Slack, Gmail and the model API, drive every journey and injected fault, and keep the evidence.
- **[adversarial-review](./adversarial-review/SKILL.md)**: Attack a finished change axis by axis and topic by topic, counting only reproduced findings.
