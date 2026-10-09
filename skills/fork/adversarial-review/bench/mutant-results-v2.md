# Mutant results v2

Harness: live-verify runner, 2 instances, stub LLM, plus the app unit tests, on the repo's inbox-assist app. Patches: patches/ (bug-05, 07, 11, 13 rebased by hand onto the improved app).

| Bug | v1 caught | v2 scenarios | v2 unit tests | v2 failing scenarios |
| --- | --- | --- | --- | --- |
| control | all green | all green | all green | (none) |
| bug-01 | yes (10-two-users-race) | yes | no | 09-double-click, 40-click-storm |
| bug-02 | yes (11-gmail-send-timeout-after-success) | yes | no | 11-gmail-send-timeout-after-success |
| bug-03 | yes (19-stale-timestamp) | yes | yes | 19-stale-timestamp |
| bug-04 | yes (20-cross-tenant) | yes | no | 20-cross-tenant |
| bug-05 | yes (15-prompt-injection) | yes | yes | 15-prompt-injection |
| bug-06 | yes (16-no-reply-loop) | yes | yes | 16-no-reply-loop |
| bug-07 | yes (07-out-of-order-push) | yes | no | 07-out-of-order-push |
| bug-08 | no | yes | no | 39-slow-views-open-ack |
| bug-09 | yes (23-long-thread-truncated) | yes | yes | 23-long-thread-truncated |
| bug-10 | yes (13-slack-429-on-post) | yes | no | 13-slack-429-on-post |
| bug-11 | no | no | yes | (none) |
| bug-12 | yes (15-prompt-injection) | yes | yes | 15-prompt-injection |
| bug-13 | yes (21-crash-between-claim-and-send) | yes | yes | 21-crash-between-claim-and-send |

Caught by scenarios: 12 of 13. Caught by scenarios or unit tests: 13 of 13. v1: 11 of 13 by scenarios.
