# Mutant results

Harness: live-verify runner, 2 instances, stub LLM, one run per mutant.

| Bug | Caught | Failing scenarios |
| --- | --- | --- |
| control (clean) | all green | (none) |
| bug-01 | yes | 10-two-users-race |
| bug-02 | yes | 11-gmail-send-timeout-after-success |
| bug-03 | yes | 19-stale-timestamp |
| bug-04 | yes | 20-cross-tenant |
| bug-05 | yes | 15-prompt-injection |
| bug-06 | yes | 16-no-reply-loop |
| bug-07 | yes | 07-out-of-order-push |
| bug-08 | no | (none) |
| bug-09 | yes | 23-long-thread-truncated |
| bug-10 | yes | 13-slack-429-on-post |
| bug-11 | no | (none) |
| bug-12 | yes | 15-prompt-injection |
| bug-13 | yes | 21-crash-between-claim-and-send |

Caught 11 of 13.
