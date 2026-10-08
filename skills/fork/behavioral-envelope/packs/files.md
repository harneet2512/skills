# Files

Uploads, downloads, object storage, images, documents.

### FILE-01 Type and content
- **Ask:** Is the file what it claims to be, and can a malicious file harm users or servers?
- **Right way:** Check the actual content type, not the extension; scan where risk warrants; serve user files from a separate domain or with safe headers.
- **Proof:** Tests with a renamed executable and an SVG containing script.

### FILE-02 Size
- **Ask:** What is the largest file accepted, and what happens above it?
- **Right way:** Limit at the edge; stream rather than load whole files into memory.
- **Proof:** Test with an oversized file.

### FILE-03 Access
- **Ask:** Who can fetch a stored file, and for how long?
- **Right way:** Private by default; short-lived signed URLs; tenant scope on file keys.
- **Proof:** Test fetching another tenant's file and an expired link.

### FILE-04 Broken and missing files
- **Ask:** What does the user see when an image or file is missing or corrupt?
- **Right way:** Fallback display; never a broken layout.
- **Proof:** Screenshot with a missing file.

### FILE-05 Processing
- **Ask:** Do resizing, conversion or extraction run in the request, and what if they fail?
- **Right way:** Process in the background; keep the original; retry idempotently.
- **Proof:** Test with a file that fails processing.

### FILE-06 Orphans and deletion
- **Ask:** When the owning record is deleted, is the file deleted too?
- **Right way:** Delete or expire files with their owner; a cleanup job for orphans.
- **Proof:** Test deleting the owner removes the file.
