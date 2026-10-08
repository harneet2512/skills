# Jobs and time

Scheduled jobs, background workers, timers, retries over time, dates and time zones.

### JOB-01 Silent stop
- **Ask:** If this job stops running (crash, deploy, expired credential), who finds out, and when?
- **Right way:** Heartbeat or last-success timestamp with an alert when it goes stale; monitor the monitor (S7).
- **Proof:** The alert fires in a test where the job is stopped.

### JOB-02 Overlapping runs
- **Ask:** Can two runs of the same job, or two workers, process the same item at once?
- **Right way:** A lock or lease per item or per job, with an expiry longer than the longest real run.
- **Proof:** Test running two workers on the same queue.

### JOB-03 Crash midway
- **Ask:** If the worker dies halfway, is the item retried, and does the retry duplicate effects?
- **Right way:** At-least-once processing with idempotent steps (S10); checkpoint long jobs.
- **Proof:** Test killing the worker mid-item, then resuming.

### JOB-04 Retry policy
- **Ask:** Which failures retry, how many times, with what backoff, and what happens after the last try?
- **Right way:** Retry transient errors with backoff and jitter; fail terminal errors fast; dead-letter with an alert.
- **Proof:** Tests for a transient and a terminal failure.

### JOB-05 Store instants in UTC
- **Ask:** Are timestamps stored as instants, and converted only for display or scheduling?
- **Right way:** Store UTC instants; keep the user's named time zone (for example `America/New_York`), not a fixed offset, because zone rules change (S14).
- **Proof:** Test that a stored value is unchanged when the server's zone changes.

### JOB-06 Daylight saving
- **Ask:** What happens for a time that does not exist (spring forward) or happens twice (fall back)?
- **Right way:** Use a time zone library with named zones; define the rule for skipped and repeated times.
- **Proof:** Tests at both daylight saving transitions in the user's zone.

### JOB-07 Which clock
- **Ask:** Does the logic compare times from different machines, or use wall time where an event time is meant?
- **Right way:** Clocks drift and jump (S10); use one authoritative clock (often the database) and monotonic time for durations.
- **Proof:** Name the clock in the contract; test with an injected clock.

### JOB-08 Backlog
- **Ask:** If the queue grows faster than workers drain it, what happens?
- **Right way:** Alert on queue age, not just length; scale workers or shed low-priority work.
- **Proof:** Queue age metric and its alert threshold.

### JOB-09 Calendar rules
- **Ask:** Does a schedule use business days, a send window or a "local morning" for a person whose time zone may be unknown or wrong?
- **Right way:** Define business days and holidays per whose calendar; a stated fallback when the zone is missing (never server time); a missed window rolls to the next valid slot instead of firing late at night.
- **Proof:** Tests with an unknown zone, a weekend, and a backlog that misses the window.
