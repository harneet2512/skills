// Checks an approved plan file (see ../../plan-first/plan-template.md) for the sections the loop reads from it, and
// for the `Changed: X because Y` deviation lines. Used by check-gates.mjs (--plan-check) and by its G8 ledger rule
// ("done, from approved plan"). The plan is a tracked file (docs/plans/), so builders commit it with the code.
// Node 22, no dependencies.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { section, norm, isSeparator } from './md-table.mjs';

export const PLAN_DIR = 'docs/plans';

// The sections the loop reads, as the heading text normalized (lower case, words only), with the name shown to people.
export const PLAN_SECTIONS = [
  ['decisions', 'Decisions'],
  ['size and why', 'Size and why'],
  ['external dependencies', 'External dependencies'],
  ['files to create or change', 'Files to create or change'],
  ['skeleton ticket', 'Skeleton ticket'],
  ['tickets and seams', 'Tickets and seams'],
  ['skill per stage', 'Skill per stage'],
  ['verification', 'Verification'],
  ['failure modes', 'Failure modes'],
  ['time box', 'Time box'],
  ['concerns', 'Concerns'],
  ['design challenge', 'Design challenge'],
];
const PLACEHOLDER = /^(tbd|todo|\?|<[^>]*>)$/i;
const CHANGED_RE = /^\s*(?:[-*]\s*)?Changed:\s*(.*)$/i;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

// Only the stages whose input the plan really holds may be "done, from approved plan": 0 baseline, 1 understand
// (shape) and 3 plan (to-tickets). Stage 2 (the deeper check against the code), the build, the proof and every later
// stage still run, so they cannot be marked from the plan.
const FROM_PLAN_STAGES = new Set([0, 1, 3]);
const FROM_PLAN_SKILLS = new Set(['baseline', 'shape', 'grilling', 'domain-modeling', 'to-spec', 'to-tickets']);
const STILL_RUNS = new Set(['deep-engineering', 'behavioral-envelope', 'concern-topics', 'evals', 'tdd', 'implement-spec',
  'code-review', 'live-verify', 'adversarial-review', 'wp-loop', 'pr', 'retro', 'prototype']);
export function PLAN_STAGES_OK(stage, skill) {
  const sk = String(skill ?? '').trim().toLowerCase();
  if (STILL_RUNS.has(sk)) return false;
  const n = /^\D*?(\d+)/.exec(String(stage ?? '').trim());
  if (n) return FROM_PLAN_STAGES.has(Number(n[1]));
  return FROM_PLAN_SKILLS.has(sk);
}

// Does the section have a line that is not blank, an HTML comment, a placeholder or the frame of an empty table
// (its header and separator rows)? Lines inside a code fence count as content; the fence markers do not.
function bodyHasContent(lines) {
  if (!lines) return false;
  const text = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  return text.some((l, i) => {
    if (FENCE_RE.test(l)) return false;
    if (l.includes('|') && isSeparator(text[i + 1] ?? '')) return false; // a table's header row
    if (isSeparator(l)) return false;
    const s = l.trim().replace(/^[-*]\s+/, '').trim();
    return s !== '' && !PLACEHOLDER.test(s) && !/^[-|:\s]+$/.test(s);
  });
}

const sectionBody = (md, key) => section(md, key, true);
export const planSectionHasBody = (md, name) => bodyHasContent(sectionBody(md, norm(name)));

// Evidence for a "done, from approved plan" row: `inferred:` followed by one or more `docs/plans/<file>.md#<Section>`
// citations separated by `;`. Every citation must name a plan file that exists and a section with content.
// `readPlan(path)` returns the file's text or null.
export function planCitationsOk(ev, readPlan) {
  if (!/^[`*_\s]*inferred:/i.test(ev)) return false;
  const cites = [...ev.matchAll(/(docs\/plans\/[^\s`#|;]+\.md)#([^`|;]+)/g)];
  if (!cites.length) return false;
  return cites.every((m) => {
    if (m[1].includes('..')) return false;
    const md = readPlan(m[1]);
    return md !== null && planSectionHasBody(md, m[2].trim());
  });
}

// The slug of the active loop (.scratch/gates.json), or ''.
function loopSlug(root) {
  try { return String(JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8'))?.slug ?? ''); } catch { return ''; }
}

// The plan for the loop's slug (docs/plans/<slug>.md) when there is one, else the newest docs/plans/*.md under root,
// or null. Claude Code names plan files itself, so the slug match is a convenience, not a requirement.
function newestPlan(root) {
  const dir = join(root, PLAN_DIR);
  if (!existsSync(dir)) return null;
  const slug = loopSlug(root);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) && !slug.includes('..') && existsSync(join(dir, `${slug}.md`))) return join(dir, `${slug}.md`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? files[0].f : null;
}

// A relative file argument is tried from the current directory, then from the repo root.
function resolvePlanFile(root, file) {
  if (!file) return newestPlan(root);
  if (isAbsolute(file)) return file;
  const here = resolve(file);
  return existsSync(here) ? here : join(root, file);
}

// -> { code, lines }. code 0 complete, 1 sections missing or deviation lines malformed, 2 no plan file.
export function checkPlan(root, file) {
  const path = resolvePlanFile(root, file);
  if (!path || !existsSync(path)) {
    return { code: 2, lines: [`plan: no plan file (${file || `${PLAN_DIR}/*.md`}); plan mode writes it there when plansDirectory is "${PLAN_DIR}"`] };
  }
  const md = readFileSync(path, 'utf8');
  const lines = [];
  const missing = [];
  for (const [key, label] of PLAN_SECTIONS) {
    const sec = sectionBody(md, key);
    if (!sec) { missing.push(label); lines.push(`plan red: missing section "${label}" (${path})`); }
    else if (!bodyHasContent(sec)) { missing.push(label); lines.push(`plan red: empty section "${label}" (${path})`); }
  }
  // Deviation lines live in "## Changes": `Changed: <what> because <why>`.
  const changes = (sectionBody(md, 'changes') ?? []).join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const changed = changes.map((l) => CHANGED_RE.exec(l)).filter(Boolean).map((m) => m[1].trim());
  const noReason = changed.filter((c) => !/\sbecause\s+\S/i.test(c) || /^because\b/i.test(c));
  for (const c of noReason) lines.push(`plan red: Changed line without "because <reason>": ${JSON.stringify(c)} (${path})`);
  const bad = missing.length + noReason.length;
  lines.push(bad
    ? `plan: red, ${missing.length} section${missing.length === 1 ? '' : 's'} missing or empty${missing.length ? ` (${missing.join(', ')})` : ''}${noReason.length ? `, ${noReason.length} Changed line${noReason.length === 1 ? '' : 's'} without a reason` : ''}`
    : `plan: complete (${PLAN_SECTIONS.length} sections, ${changed.length} deviation line${changed.length === 1 ? '' : 's'}) (${path})`);
  return { code: bad ? 1 : 0, lines };
}
