# Fork

Skills this fork adds on top of upstream. Each one is shipped in the plugin. See [FORK.md](../../FORK.md) for what each one builds on and why it exists.

How they fit: `feature-loop` runs a feature through `shape`, `deep-engineering` (which calls `behavioral-envelope`, `concern-topics` and `evals`), Matt's `to-spec` and `to-tickets`, `wp-loop` per ticket (which calls `tdd`, `live-verify` and `adversarial-review`), then ship and Matt's `retro`.

## User-invoked

- **[feature-loop](./feature-loop/SKILL.md)**: Take one feature from request to shipped: shape, design from concerns, plan, build, prove (tests, evals, live verification), attack, staged ship, learn.
- **[wp-loop](./wp-loop/SKILL.md)**: Ship one work package end to end: issue, engineering contract, branch, TDD, PR, green CI, two-axis review, verified fixes, gated merge, results comment.

## Model-invoked

- **[shape](./shape/SKILL.md)**: Intent, actors and surfaces, a journey map crossed with interaction cases, the success metric and the scope line, before any design.
- **[deep-engineering](./deep-engineering/SKILL.md)**: Build a system model from repo evidence, derive invariants and risks, and write an engineering contract before any spec or code.
- **[behavioral-envelope](./behavioral-envelope/SKILL.md)**: Find every concern a change must satisfy, with concern packs picked by a script from the code and every item answered, so no run skips the basics.
- **[concern-topics](./concern-topics/SKILL.md)**: Thirteen fixed engineering topics with categories that say how things fail, how to build them right, how to prove it and how to attack it, plus a slop detector.
- **[evals](./evals/SKILL.md)**: Success criteria, case sets, calibrated judges, error bars, paired comparisons and merge gates for anything that calls an LLM.
- **[live-verify](./live-verify/SKILL.md)**: Run the real app in the cloud against recording stand-ins for Slack, Gmail and the model API, drive every journey and injected fault, and keep the evidence.
- **[adversarial-review](./adversarial-review/SKILL.md)**: Attack a finished change axis by axis and topic by topic, counting only reproduced findings.
