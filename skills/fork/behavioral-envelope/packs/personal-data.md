# Personal data

Names, emails, phone numbers, messages, payment details, anything that identifies a person.

### PII-01 Minimum collected
- **Ask:** Does the change store personal data the purpose does not need?
- **Right way:** Collect and keep only what the feature uses.
- **Proof:** Each stored field traced to a use.

### PII-02 Not in logs
- **Ask:** Do logs, error reports, analytics or traces capture personal data or secrets?
- **Right way:** Redact at the logger; never log request bodies or tokens wholesale.
- **Proof:** Log output from a test run inspected for personal data.

### PII-03 Pasted where it should not be
- **Ask:** What if a user pastes a card number or password into a free-text field or chat?
- **Right way:** Detect and mask known sensitive patterns before storing or forwarding.
- **Proof:** Test pasting a card-shaped number.

### PII-04 Deletion everywhere
- **Ask:** When someone asks to be deleted, is their data removed from the database, files, search index, caches, logs, third parties and model context?
- **Right way:** A deletion path that covers every store; backups expire on a stated schedule.
- **Proof:** Deletion test followed by a search of each store.

### PII-05 Sent to third parties
- **Ask:** Which providers (including LLM providers) receive personal data, and is that disclosed and allowed?
- **Right way:** List data flows per provider; send the minimum; check provider retention terms.
- **Proof:** Data-flow list in the contract.

### PII-06 Export and access
- **Ask:** Can a person get a copy of their data if they ask?
- **Right way:** An export path that matches what is stored.
- **Proof:** Export test for one user.
