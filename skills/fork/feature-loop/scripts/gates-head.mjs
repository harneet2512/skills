// Freshness by commit, never by file time (fork.9, gates.md "Head rule"): evidence is fresh when it names the commit
// it ran on and that commit is HEAD, or HEAD differs from it only in files that are not source (stage-detect.mjs
// decides what is source: .scratch/, docs/plans/, docs/agents/, docs/adr/, GLOSSARY.md, the Claude settings file).
// Shared by G3, G4, G9, G11 and G12. Node 22, no dependencies.
import { dirtySource, git, headSha, isAllowed, isAncestor } from './stage-detect.mjs';

const SHA_RE = /^[0-9a-f]{7,64}$/i;
export const isSha = (s) => typeof s === 'string' && SHA_RE.test(s);
export const shortSha = (s) => String(s ?? '').slice(0, 9);
const listShort = (xs, n = 3) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);

// The full sha of a commit in dir, or ''.
export function fullSha(dir, ref) {
  if (!isSha(ref)) return '';
  const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : '';
}

// { ok: true } or { ok: false, msg }: is evidence recorded at `recorded` still about the code in `dir`?
export function headFresh(dir, recorded) {
  if (!isSha(recorded)) return { ok: false, msg: 'names no commit (head is missing or not a sha)' };
  const rec = fullSha(dir, recorded);
  if (!rec) return { ok: false, msg: `ran on ${shortSha(recorded)}, which is not a commit of this repository` };
  const head = headSha(dir);
  const dirty = dirtySource(dir);
  if (dirty.length) return { ok: false, msg: `ran on ${shortSha(rec)} but source is edited since (uncommitted: ${listShort(dirty)})` };
  if (rec === head) return { ok: true };
  if (!isAncestor(dir, rec, head)) return { ok: false, msg: `ran on ${shortSha(rec)}, which is not an ancestor of HEAD ${shortSha(head)}` };
  const d = git(dir, ['diff', '--name-only', '-z', rec, head]);
  if (d.status !== 0) return { ok: false, msg: `ran on ${shortSha(rec)}; the diff to HEAD ${shortSha(head)} could not be read` };
  const src = d.stdout.split('\0').filter((p) => p && !isAllowed(p));
  return src.length ? { ok: false, msg: `ran on ${shortSha(rec)} but HEAD is ${shortSha(head)} and source changed since (${listShort(src)})` } : { ok: true };
}
