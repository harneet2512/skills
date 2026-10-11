// G10 (codex plan review) and G11 (codex code attack), fork.9, see ../gates.md. The reports are written by the
// codex-review skill's script: .scratch/review/codex-<plan|code>-<slug>.json = { kind, model, codex_version,
// subject_sha, base, started, finished, exit_code, summary, findings: [{ id, severity, status, title, where, evidence,
// repro }] }; the lead's answers are in codex-<kind>-<slug>.resolutions.md, a table `| id | resolution |` whose
// resolution starts with `fixed: <commit>` or `rejected: <reason>`. Repros: .scratch/review/codex-repros/<id>/.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { clean, tables } from './md-table.mjs';
import { git, isAncestor, stripChanges } from './stage-detect.mjs';
import { fullSha, headFresh } from './gates-head.mjs';
import { sha256Lf } from './lf-sha.mjs';

const DEFAULT_MODEL = 'gpt-6-astra';
const gitRaw = (dir, args) => { try { return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const SHA256_RE = /^[0-9a-f]{64}$/i;
const TEST_PATH_RE = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test[-_][^/]*$|_test\.[a-z]+$/i;
const list = (xs, n = 4) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
const red = (msg, file) => ({ state: 'red', msg: `${msg} (${file})` });
const green = () => ({ state: 'green' });

export const configuredModel = () => process.env.CODEX_REVIEW_MODEL || DEFAULT_MODEL;

// The report of a kind, checked for what both gates need: { rep, file } or { fail }.
function loadReport(root, slug, kind) {
  const file = `.scratch/review/codex-${kind}-${slug}.json`;
  if (!existsSync(join(root, file))) return { fail: red(`no codex ${kind} report: run the codex-review skill in ${kind} mode`, file) };
  let rep;
  try { rep = JSON.parse(readFileSync(join(root, file), 'utf8')); } catch (e) { return { fail: red(`codex ${kind} report is not valid JSON: ${e.message}`, file) }; }
  const problems = [];
  if (rep?.kind !== kind) problems.push(`kind is ${JSON.stringify(rep?.kind)}, not "${kind}"`);
  if (rep?.exit_code !== 0) problems.push(`exit_code is ${JSON.stringify(rep?.exit_code)}, not 0: the review did not run to the end`);
  if (rep?.model !== configuredModel()) problems.push(`model is ${JSON.stringify(rep?.model)}, not the configured ${configuredModel()}`);
  if (!Array.isArray(rep?.findings)) problems.push('no findings list');
  return problems.length ? { fail: red(problems.join('; '), file) } : { rep, file };
}

// { id: resolution text } from the resolutions file, or null when the file is missing.
function resolutions(root, slug, kind) {
  let md;
  try { md = readFileSync(join(root, '.scratch', 'review', `codex-${kind}-${slug}.resolutions.md`), 'utf8'); } catch { return null; }
  const out = {};
  for (const t of tables(md.split(/\r?\n/))) {
    const idCol = t.header.indexOf('id'), resCol = t.header.indexOf('resolution');
    if (idCol < 0 || resCol < 0) continue;
    for (const r of t.rows) out[clean(r[idCol] ?? '')] = clean(r[resCol] ?? '');
  }
  return out;
}

const RES_RE = /^(fixed|rejected):\s*(\S.*)$/i;
// Findings of `rep` that need an answer (confirmed, of these severities) and have none: ids.
function unanswered(rep, res, severities) {
  return rep.findings
    .filter((f) => String(f?.status).toUpperCase() === 'CONFIRMED' && (!severities || severities.includes(String(f?.severity).toUpperCase())))
    .filter((f) => !RES_RE.test(res?.[String(f?.id)] ?? ''))
    .map((f) => `${f?.id} ${String(f?.severity).toUpperCase()}`);
}

// The approved plan is whatever a signed `approve plan` entry holds (fork.9.1): the plan file legitimately changes after
// the owner approves it (the loop requires `Changed:` lines under `## Changes`), so asking for approval of the file as it
// is now would send the owner the same plan again and again. `plan_sha` in gates.json is informational and plays no part.
//
// G10's plan check is green when some signed `approve plan` holds the sha of a COMMITTED version of the plan file, the
// codex plan review is of a committed version at or before that one, and the plan file now differs from the approved
// version only inside `## Changes`.

// Every committed version of `rel`, newest first: [{ commit, sha (of the LF form), text }].
function planHistory(dir, rel) {
  const commits = (git(dir, ['log', '--format=%H', '--', rel]).stdout ?? '').split(/\s+/).filter(Boolean);
  return commits.flatMap((commit) => {
    const body = gitRaw(dir, ['show', `${commit}:${rel}`]);
    return body === null ? [] : [{ commit, sha: sha256Lf(body), text: body.toString('utf8') }];
  });
}

const short12 = (s) => String(s ?? '').slice(0, 12);
const normRel = (p) => String(p ?? '').replaceAll('\\', '/').replace(/^\.\//, '');

// '' when the plan check passes, else the reason.
function planProblem(dir, approvals, planFile, subject) {
  const want = String(subject ?? '').toLowerCase();
  let reviewFail = '', changedFail = '', unmatched = '';
  for (const a of [...approvals].reverse()) {
    const rel = normRel(a.plan_file) || normRel(planFile);
    if (!rel) { unmatched = 'there is no plan file (docs/plans/*.md)'; continue; }
    const hist = planHistory(dir, rel);
    const approved = hist.filter((v) => v.sha === String(a.plan_sha).toLowerCase());
    if (!approved.length) { unmatched = `${rel} has no committed version that hashes to ${short12(a.plan_sha)}: commit the plan before the owner approves it`; continue; }
    let current = null;
    try { current = readFileSync(join(dir, rel), 'utf8'); } catch { /* missing */ }
    for (const v of approved) {
      const reviewed = SHA256_RE.test(want) && hist.some((h) => h.sha === want && isAncestor(dir, h.commit, v.commit));
      const unchanged = current !== null && stripChanges(current) === stripChanges(v.text);
      if (reviewed && unchanged) return '';
      if (!reviewed) reviewFail = `the review is of plan ${short12(want)}, which is not a committed version of ${rel} at or before the approved one (${short12(a.plan_sha)}): run the codex plan review on the committed plan`;
      if (!unchanged) changedFail = `the plan file ${rel} changed outside "## Changes" since the owner approved it (${short12(a.plan_sha)}): a changed plan needs "approve plan" again`;
    }
  }
  if (changedFail) return changedFail;
  if (reviewFail) return reviewFail;
  return `the signed log has no "approve plan" for a committed version of the plan${unmatched ? ` (${unmatched})` : ''}: only the owner can give it, in a prompt`;
}

export function g10({ root, work, slug, appr, planFile }) {
  const r = loadReport(root, slug, 'plan');
  if (r.fail) return r.fail;
  const { rep, file } = r;
  const problems = [];
  if (!appr.ok) problems.push(appr.why);
  else {
    const plans = appr.list.filter((a) => a?.stop === 'plan' && SHA256_RE.test(String(a.plan_sha)));
    const why = planProblem(work ?? root, plans, planFile, rep.subject_sha);
    if (why) problems.push(why);
  }
  const res = resolutions(root, slug, 'plan');
  const open = unanswered(rep, res);
  if (open.length) problems.push(`CONFIRMED finding${open.length > 1 ? 's' : ''} with no "fixed: <commit>" or "rejected: <reason>" row in .scratch/review/codex-plan-${slug}.resolutions.md: ${list(open)}`);
  return problems.length ? red(problems.join('; '), file) : green();
}

// Does the repo hold a test equivalent to the repro of a fixed finding? The repro file is in the tree (by name), or the
// fixing commit touched a test file.
function hasEquivalentTest(work, reproFiles, commit) {
  const tracked = git(work, ['ls-files', '-z']);
  if (tracked.status === 0) {
    const names = new Set(tracked.stdout.split('\0').filter(Boolean).map((p) => p.split('/').pop()));
    if (reproFiles.some((f) => names.has(f))) return true;
  }
  const t = git(work, ['show', '--name-only', '--format=', '-z', commit]);
  return t.status === 0 && t.stdout.split('\0').some((p) => p && TEST_PATH_RE.test(p));
}

function checkFixed(root, work, rep, res) {
  const problems = [];
  for (const f of rep.findings) {
    const m = RES_RE.exec(res?.[String(f?.id)] ?? '');
    if (!m || m[1].toLowerCase() !== 'fixed') continue;
    const id = String(f.id);
    const dir = join(root, '.scratch', 'review', 'codex-repros', id);
    let files = [];
    try { files = readdirSync(dir).filter((n) => !n.startsWith('.')); } catch { /* no dir */ }
    if (!files.length) { problems.push(`${id} is fixed but its repro is not in .scratch/review/codex-repros/${id}/`); continue; }
    const commit = fullSha(work, m[2].trim().split(/\s+/)[0]);
    if (!commit || !isAncestor(work, commit, 'HEAD')) { problems.push(`${id}: "fixed: ${m[2].trim().split(/\s+/)[0]}" is not a commit on this branch`); continue; }
    if (!hasEquivalentTest(work, files, commit)) problems.push(`${id}: the repo has no test equivalent to its repro (add the repro as a test, in the fix commit or by name)`);
  }
  return problems;
}

export function g11({ root, work, slug }) {
  const r = loadReport(root, slug, 'code');
  if (r.fail) return r.fail;
  const { rep, file } = r;
  const problems = [];
  const fresh = headFresh(work, rep.subject_sha);
  if (!fresh.ok) problems.push(`the attack ${fresh.msg}; run the code attack again on this head`);
  const res = resolutions(root, slug, 'code');
  const open = unanswered(rep, res, ['CRITICAL', 'HIGH']);
  if (open.length) problems.push(`CONFIRMED finding${open.length > 1 ? 's' : ''} with no "fixed: <commit>" or "rejected: <reason>" in .scratch/review/codex-code-${slug}.resolutions.md: ${list(open)}`);
  problems.push(...checkFixed(root, work, rep, res));
  return problems.length ? red(problems.join('; '), file) : green();
}
