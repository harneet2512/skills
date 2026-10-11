// What G9 asks of the review and verification stages at the merge and pr phases (fork.9, gates.md "G9"): a Skill call
// alone no longer counts, the stage must have left evidence on the head.
//   code-review  .scratch/review/<slug>.md has a ## Findings table, and names the head it reviewed: a `Head: <sha>` line
//                (any label starting with "head" or "reviewed", bold or not) inside the Findings section, or a `head`
//                column in the table. The sha is HEAD, or HEAD with only non-source changes since (gates-head.mjs).
//   live-verify  the newest .scratch/live/<run>/report.json records a fresh "head" (G3 judges the scenarios).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, firstTable, section } from './md-table.mjs';
import { headFresh } from './gates-head.mjs';
import { newestLiveReport } from './timebox.mjs';

const HEAD_LINE_RE = /^\s*[-*]?\s*\**\s*(?:reviewed\s+)?head(?:\s+sha|\s+commit)?\s*\**\s*[:=]\s*\**\s*`?([0-9a-f]{7,64})\b/i;

// '' when the review file is good evidence for the head, else what is missing.
export function reviewProblem(root, work, slug) {
  const rel = `.scratch/review/${slug}.md`;
  let md;
  try { md = readFileSync(join(root, rel), 'utf8'); } catch { return `no review file ${rel}`; }
  const sec = section(md, 'findings');
  const table = sec && firstTable(sec);
  if (!table) return `${rel} has no ## Findings table`;
  const named = [];
  for (const l of sec) { const m = HEAD_LINE_RE.exec(l); if (m) named.push(m[1]); }
  const col = table.header.findIndex((h) => h === 'head' || h === 'sha' || h === 'head sha');
  if (col >= 0) for (const r of table.rows) { const m = /\b([0-9a-f]{7,64})\b/i.exec(clean(r[col] ?? '')); if (m) named.push(m[1]); }
  if (!named.length) return `${rel} names no head sha (add a "Head: <sha>" line under ## Findings)`;
  const stale = named.map((s) => ({ s, f: headFresh(work, s) })).filter((x) => !x.f.ok);
  if (stale.length === named.length) return `${rel} is for ${stale[0].s.slice(0, 9)}: it ${stale[0].f.msg}; review the final code again`;
  return '';
}

// '' when the newest live report is on a fresh head, else what is missing.
export function liveProblem(root, work) {
  const rel = newestLiveReport(root)?.rel;
  if (!rel) return 'no live run (.scratch/live/<run>/report.json)';
  let rep;
  try { rep = JSON.parse(readFileSync(join(root, rel), 'utf8')); } catch { return `${rel} is not valid JSON`; }
  if (!rep?.head) return `${rel} has no "head": rerun live-verify`;
  const f = headFresh(work, rep.head);
  return f.ok ? '' : `${rel}: the live run ${f.msg}; rerun live-verify`;
}
