# Retrieval

Search, embeddings, vector stores, ranking, scraping or ingesting content as context.

### RET-01 Finds the answer
- **Ask:** Does it return what answers the question, not just text with similar words?
- **Right way:** A labeled query set; measure recall at k; combine keyword and vector search and rerank where it helps.
- **Proof:** Recall and precision on the query set before and after.

### RET-02 Freshness
- **Ask:** When the source changes or disappears, how soon does the index reflect it?
- **Right way:** Re-ingest on change events or a schedule; delete removed content from the index.
- **Proof:** Test that an edited and a deleted document change results.

### RET-03 Conflicting sources
- **Ask:** When docs, website and past answers disagree, which wins?
- **Right way:** A source priority and recency rule, stated and applied.
- **Proof:** Eval case with conflicting sources.

### RET-04 Chunking keeps meaning
- **Ask:** Do chunks cut tables, lists or answers in half, or drag in boilerplate such as site footers?
- **Right way:** Structure-aware chunking; strip navigation and boilerplate.
- **Proof:** Sample of chunks inspected; eval on questions needing a whole table.

### RET-05 Hard formats
- **Ask:** Are PDFs, scanned images, and pages that need JavaScript handled?
- **Right way:** Text extraction with OCR fallback; a rendering scraper for script-built pages.
- **Proof:** Test documents of each kind.

### RET-06 Reindexing
- **Ask:** What happens when the embedding model or chunking changes?
- **Right way:** Version the index; rebuild alongside and switch atomically.
- **Proof:** Index version recorded with each result.

### RET-07 Access control
- **Ask:** Can a user retrieve content they are not allowed to see?
- **Right way:** Filter by tenant and permission inside the query, not after.
- **Proof:** Cross-tenant and restricted-document tests.

### RET-08 Injected content
- **Ask:** Can ingested pages carry instructions that steer the model?
- **Right way:** Treat retrieved text as data (see `llm` LLM-03).
- **Proof:** Eval case with an injected page.

### RET-09 Citations are real
- **Ask:** Can an answer cite a source that was not retrieved, does not support the claim, belongs to another tenant, or links somewhere the reader cannot open?
- **Right way:** Structured output mapping each claim to retrieved chunk ids; validate every citation against the retrieved set and the current index version; drop or hand off when a claim is unsupported.
- **Proof:** Eval cases with fabricated and mismatched citations.

### RET-10 Customer-supplied URLs
- **Ask:** Does ingestion fetch pages from URLs a customer entered?
- **Right way:** Treat it as server-side request forgery risk: see `api` API-10 (allowlist, block private addresses after DNS resolution, re-check after redirects, size and time caps).
- **Proof:** Tests with a metadata address and a redirect to a private address.
