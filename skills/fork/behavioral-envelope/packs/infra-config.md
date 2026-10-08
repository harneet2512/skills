# Infra and config

Deploy config, CI, containers, environment variables, DNS, certificates, caches, CDNs.

### INF-01 Config per environment
- **Ask:** Does the change need a new setting, and is it set in every environment before deploy?
- **Right way:** Config in the environment, validated at startup, documented in the example env file (S13).
- **Proof:** Startup fails clearly when the setting is missing.

### INF-02 Dev and prod parity
- **Ask:** Does it rely on something that differs between local, staging and production?
- **Right way:** Same backing services and versions where possible (S13).
- **Proof:** Run on staging before production.

### INF-03 Deploy and rollback
- **Ask:** How does this deploy, and how is it rolled back in one step?
- **Right way:** Automated deploy from the default branch; a tested rollback; flags for risky behavior.
- **Proof:** Rollback command named and tried on staging.

### INF-04 Caches and CDNs
- **Ask:** After publishing, can users or the AI still see the old version?
- **Right way:** Versioned asset names; explicit invalidation on publish; short cache times on HTML.
- **Proof:** Live check that a published change is visible.

### INF-05 Disk, memory and connections
- **Ask:** Can this fill the disk, leak memory or exhaust database connections over days?
- **Right way:** Rotation and retention; pooled connections with limits; alerts on saturation (S7, S11).
- **Proof:** Saturation metrics and alerts exist.

### INF-06 DNS and certificates
- **Ask:** Does the change add a domain, and who renews its certificate?
- **Right way:** Automated renewal with an expiry alert; DNS verified before switching traffic.
- **Proof:** Certificate expiry monitored.

### INF-07 Secrets in CI and images
- **Ask:** Can a secret end up in an image layer, a build log or a public artifact?
- **Right way:** Secrets injected at runtime from a secret store; secret scanning on the repo.
- **Proof:** Image history and CI logs checked.

### INF-08 Startup and shutdown
- **Ask:** Does the service start healthy and shut down without losing in-flight work?
- **Right way:** Health checks; graceful shutdown that drains requests and jobs (S13).
- **Proof:** Restart under load without errors.

### INF-09 Feature flags
- **Ask:** Is the change behind a flag, and what happens in each state and when the flag service is unreachable?
- **Right way:** A safe default when flag evaluation fails; both states tested; flags removed once fully rolled out.
- **Proof:** Tests with the flag on, off and unavailable.
