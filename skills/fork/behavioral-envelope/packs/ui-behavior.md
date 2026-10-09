# UI behavior

Components with state, forms, client-side requests, editors, real-time views.

### UIB-01 Double submit
- **Ask:** What happens when the user clicks twice, or presses Enter while a request is in flight?
- **Right way:** Disable or debounce while pending, and make the server action idempotent anyway (the client guard is not enough).
- **Proof:** Test or live run with two rapid submits producing one effect.

### UIB-02 Loading, empty and error states
- **Ask:** What does the user see while loading, when there is no data, and when the request fails?
- **Right way:** Each state designed and reachable; errors say what to do next.
- **Proof:** Screenshot of each state, forced in a test or live run.

### UIB-03 Honest "Saved"
- **Ask:** Is success shown before the server confirmed it?
- **Right way:** Optimistic updates roll back visibly on failure; "Saved" shows only after confirmation.
- **Proof:** Live run with the request failing shows rollback and an error.

### UIB-04 Unsaved work survives
- **Ask:** What is lost on refresh, navigation, tab close or a dropped connection?
- **Right way:** Autosave or a warning before leaving; drafts persisted where the purpose needs them.
- **Proof:** Refresh mid-edit and confirm what survives.

### UIB-05 Concurrent editors and devices
- **Ask:** What if two people, two tabs or two devices edit the same thing?
- **Right way:** Detect conflicts (version or timestamp check) instead of last write silently winning.
- **Proof:** Two-session test showing the conflict handled.

### UIB-06 Stale view
- **Ask:** Can the user act on data that changed since the screen loaded?
- **Right way:** Refetch or revalidate on focus and before destructive actions; the server checks the current state.
- **Proof:** Live run changing data in another session, then acting in the first.

### UIB-07 Keyboard and screen reader
- **Ask:** Can the flow be completed by keyboard alone, with labels a screen reader announces?
- **Right way:** Native controls or proper roles, labels on inputs, logical focus order (S3).
- **Proof:** Keyboard-only run of the flow; accessibility checker output.

### UIB-08 Mobile realities
- **Ask:** Does the on-screen keyboard cover the input? Does a network switch mid-action break it?
- **Right way:** Scroll inputs into view; retry or resume requests after reconnect.
- **Proof:** Run on a phone-sized viewport with throttled or interrupted network.

### UIB-09 Pasted and huge input
- **Ask:** What happens when the user pastes rich text from another app, or a very large input?
- **Right way:** Sanitize pasted content; set and show length limits.
- **Proof:** Test pasting formatted content and an oversized input.

### UIB-10 Does not slow the page
- **Ask:** Does the component add load time, layout shift or work on every render?
- **Right way:** Lazy-load heavy parts, avoid render loops, measure.
- **Proof:** Before and after page load and interaction timings.

### UIB-11 Rendering user content
- **Ask:** Does the UI render text or HTML that a user, customer or third party wrote?
- **Right way:** Escape by default; when HTML is required, sanitize with an allowlist; never inject raw strings into HTML (cross-site scripting, S9).
- **Proof:** Test rendering `<img src=x onerror=alert(1)>` shows it as text.

### UIB-12 Live connections
- **Ask:** For live updates (WebSocket, server-sent events, polling), what happens on disconnect, reconnect, a server restart, or many tabs?
- **Right way:** Reconnect with backoff and jitter so a restart does not bring every client back at once; authenticate the connection; resync state after reconnect; detect connections that look alive but are not (heartbeats).
- **Proof:** Live run that drops the connection mid-update and confirms state is correct after reconnect.
