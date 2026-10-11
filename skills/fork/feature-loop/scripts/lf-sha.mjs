// sha256 of a plan or acceptance file with its carriage returns removed (fork.9.1). A plan checked out on Windows with
// autocrlf has CRLF in the working file but LF in the Git blob, and every sha the loop compares (the approval's plan_sha,
// the codex review's subject_sha, a committed version of the plan) must be the same number either way. The shell side,
// codex-review.sh, does the same with `tr -d '\r'`.
import { createHash } from 'node:crypto';

export function sha256Lf(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  return createHash('sha256').update(Buffer.from(bytes.toString('latin1').replace(/\r/g, ''), 'latin1')).digest('hex');
}
