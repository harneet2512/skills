// What the owner sees (fork.9, gates.md "Visibility"): for one PostToolUse / PostToolUseFailure payload, write the
// timeline rows and return the ONE systemMessage line (escalations first, each starting `ESCALATION:`), or ''.
// Reads, greps and edits of ordinary files produce nothing. The hook does this, so the agent cannot skip it.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry, readLog, storeStatus } from './stage-log.mjs';
import { commandEscalations, codexSevere } from './escalation.mjs';
import { appendTimeline } from './timeline.mjs';
import { changesSection, newestPlan, sha256 } from './vis-root.mjs';
import { clean, tables } from './md-table.mjs';

const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();
const unquoted = (cmd) => cmd.replace(/'[^']*'|"[^"]*"/g, ' ');
const PACKS_RE = /^\s*[-*]?\s*\*\*Packs:?\*\*:?/;
const short = (s, n = 90) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const squash = (s) => String(s).replace(/\s+/g, ' ');

// The tool's output as text (stdout, stderr, a string response, or the failure's error).
export function responseText(input) {
  const r = input.tool_response;
  const parts = [typeof input.error === 'string' ? input.error : ''];
  if (typeof r === 'string') parts.push(r);
  else if (r && typeof r === 'object') parts.push(r.stdout, r.stderr, r.output, typeof r.content === 'string' ? r.content : '');
  return parts.filter((p) => typeof p === 'string' && p).join('\n');
}
export function didFail(input) {
  if (input.hook_event_name === 'PostToolUseFailure') return true;
  const r = input.tool_response;
  if (!r || typeof r !== 'object') return false;
  const code = r.exit_code ?? r.exitCode ?? r.returncode;
  return (typeof code === 'number' && code !== 0) || r.success === false || r.is_error === true || r.interrupted === true;
}
const lastLine = (text, re) => {
  const ls = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (re && [...ls].reverse().find((l) => re.test(l))) || ls[ls.length - 1] || '';
};
const g4State = (text) => (/^G4 red\b/m.test(text) ? true : /^G4 green\b/m.test(text) ? false : null);

// ---- Bash classification
const TEST_RE = /\b(?:npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+test|npx\s+(?:vitest|jest)|pytest|go\s+test|cargo\s+test|node\s+--test|merge_check|test-[\w.-]+\.sh)\b|\be2e\b/;
const PR_RE = /\bgh\s+pr\s+create\b|\bgh\s+api\b[^;&|\n]*\/pulls\b[^;&|\n]*(?:-X\s*POST|--method\s*POST|\s-[fF]\s)|createPullRequest/;

function bashEvents(cmd, text, failed, run) {
  const c = unquoted(cmd);
  const ev = [];
  const merge = typeof run?.merge_check === 'string' && run.merge_check.trim() ? run.merge_check.trim() : null;
  if (/(?:^|[\s/;&|])check-gates(?:\.sh|\.mjs)?(?:\s|$)/.test(c)) {
    const line = lastLine(text, /^gates: /);
    const red = failed || /^gates: red\b/m.test(text);
    ev.push({ event: 'gates', detail: `${red ? 'red' : 'green'}: ${line || cmd}`, note: `gates ${red ? 'RED' : 'green'}: ${short(line.replace(/^gates:\s*/, '') || 'see output', 120)}`, g4: g4State(text) });
  }
  if (/codex-review(?:\.sh)?\s+(?:plan|code)\b/.test(c)) {
    const line = lastLine(text, /codex/i);
    ev.push({ event: 'codex-review', detail: failed ? `failed: ${line}` : line, note: failed ? `codex review FAILED: ${short(line)}` : short(line, 160), codex: true });
  }
  if (/\bgit\b[^;&|\n]*\bpush\b/.test(c) && !/--dry-run/.test(c)) {
    ev.push({ event: 'push', detail: `${failed ? 'failed' : 'ok'}: ${short(squash(cmd))}`, note: `git push ${failed ? 'FAILED' : 'ok'}: ${short(squash(cmd), 70)}` });
  }
  if (PR_RE.test(c)) {
    const url = /https?:\/\/\S+\/pull\/\d+/.exec(text)?.[0] ?? '';
    ev.push({ event: 'pr created', detail: failed ? 'failed' : url || short(cmd), evidence: url, note: failed ? 'PR create FAILED' : `PR created${url ? `: ${url}` : ''}` });
  }
  const isCi = /\bgh\s+run\b/.test(c);
  const isLive = /live[-_ ]?verify|\.scratch\/live|\blive[-_]run\b/.test(c);
  if (isCi || isLive || TEST_RE.test(c) || (merge && c.includes(merge))) {
    const kind = isCi ? 'ci' : isLive ? 'live' : 'test';
    ev.push({ event: `${kind} run`, detail: `${failed ? 'FAIL' : 'pass'}: ${short(squash(cmd))}`, note: `${kind} ${failed ? 'FAIL' : 'pass'}: ${short(squash(cmd), 70)}` });
  }
  return ev;
}

// ---- state that lives in the signed log (so the agent cannot reset it): plan Changes, Packs line, G4 state
const lastOf = (entries, pred) => [...entries].reverse().find(pred);

function newestCodexReport(root) {
  const dir = join(root, '.scratch', 'review');
  try {
    const names = readdirSync(dir).filter((n) => /^codex-.*\.json$/.test(n)).map((n) => ({ n, m: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.m - a.m);
    if (names.length && Date.now() - names[0].m < 300000) return JSON.parse(readFileSync(join(dir, names[0].n), 'utf8'));
  } catch { /* none */ }
  return null;
}

function planChange(root, log, dirs) {
  const plan = newestPlan(dirs);
  if (!plan) return '';
  let cur = '';
  try { cur = sha256(changesSection(readFileSync(plan.file, 'utf8')) ?? ''); } catch { /* unreadable */ }
  const prior = lastOf(log.entries, (e) => e.plan_file === plan.rel && typeof e.changes_sha === 'string' && ['handoff', 'approval', 'plan-changes'].includes(e.kind));
  if (prior && prior.changes_sha === cur) return '';
  appendEntry(root, { kind: 'plan-changes', plan_file: plan.rel, changes_sha: cur, ts: now() });
  return prior ? `the plan's ## Changes section was edited (${plan.rel})` : '';
}

function packsChange(root, run, log, g4red) {
  const slug = typeof run?.slug === 'string' ? run.slug : '';
  const envelope = slug ? join(root, '.scratch', 'envelope', `${slug}.md`) : '';
  if (!envelope || !existsSync(envelope)) return '';
  const line = readFileSync(envelope, 'utf8').split(/\r?\n/).find((l) => PACKS_RE.test(l))?.trim() ?? '';
  const prior = lastOf(log.entries, (e) => e.kind === 'packs');
  if (prior && prior.packs_line === line) return '';
  appendEntry(root, { kind: 'packs', packs_line: line, ts: now() });
  return prior && g4red ? `the envelope **Packs:** line was edited after a red G4 (was: ${short(prior.packs_line, 60)}; now: ${short(line, 60)})` : '';
}

function signedChecks(root, run, dirs, g4now) {
  if (storeStatus(root).kind !== 'ok') return [];
  const log = readLog(root);
  if (log.errors.length) return [];
  let g4red = lastOf(log.entries, (e) => e.kind === 'g4')?.red === true;
  if (typeof g4now === 'boolean' && g4now !== g4red) { appendEntry(root, { kind: 'g4', red: g4now, ts: now() }); g4red = g4now; }
  return [planChange(root, log, dirs), packsChange(root, run, log, g4red)].filter(Boolean);
}

// ---- stage changes, from .scratch/loop-status.md (the table the loop keeps), remembered in .scratch/.timeline-state.json
function stageChanges(root) {
  let md = '';
  try { md = readFileSync(join(root, '.scratch', 'loop-status.md'), 'utf8'); } catch { return []; }
  const t = tables(md.split(/\r?\n/)).find((x) => x.header.includes('status') && x.header.includes('stage'));
  if (!t) return [];
  const cell = (r, n) => (t.header.indexOf(n) < 0 ? '' : clean(r[t.header.indexOf(n)] ?? ''));
  const sp = join(root, '.scratch', '.timeline-state.json');
  let seen = {};
  try { seen = JSON.parse(readFileSync(sp, 'utf8'))?.stages ?? {}; } catch { /* first look */ }
  const next = {};
  const out = [];
  for (const r of t.rows) {
    const key = [cell(r, 'stage'), cell(r, 'skill')].filter(Boolean).join(' ');
    const st = (/^(running|done|pending|skipped|blocked)/i.exec(cell(r, 'status'))?.[1] ?? 'pending').toLowerCase();
    next[key] = st;
    if (key && st !== (seen[key] ?? 'pending')) out.push({ key, from: seen[key] ?? 'pending', to: st, evidence: cell(r, 'evidence') });
  }
  if (out.length) { try { writeFileSync(sp, JSON.stringify({ stages: next }) + '\n'); } catch { /* best effort */ } }
  return out;
}

// ---- entry point: returns the systemMessage ('' when nothing matters)
export function observe(root, input, run, dirs) {
  const rows = [];
  const notes = [];
  const escalations = [...commandEscalations(input)];
  const failed = didFail(input);
  const ti = input.tool_input ?? {};
  const text = responseText(input);
  const ok = input.hook_event_name !== 'PostToolUseFailure';

  let g4 = null;
  if (input.tool_name === 'Bash' && typeof ti.command === 'string') {
    for (const e of bashEvents(ti.command, text, failed, run)) {
      rows.push({ event: e.event, detail: e.detail, evidence: e.evidence ?? '' });
      notes.push(e.note);
      if (typeof e.g4 === 'boolean') g4 = e.g4;
      if (e.codex && !failed) {
        const severe = codexSevere(text, null) || codexSevere('', newestCodexReport(root));
        if (severe) escalations.push(severe);
      }
    }
  } else if (ok && input.tool_name === 'Skill') rows.push({ event: 'skill', detail: String(ti.skill ?? ti.command ?? ti.name ?? ''), evidence: '' });
  else if (ok && (input.tool_name === 'Agent' || input.tool_name === 'Task')) rows.push({ event: 'agent', detail: `${ti.subagent_type ?? ''}: ${ti.description ?? ''}`, evidence: ti.model ?? '' });

  escalations.push(...signedChecks(root, run, dirs, g4));
  for (const c of stageChanges(root)) {
    rows.push({ event: `stage ${c.to}`, detail: c.key, evidence: c.evidence });
    notes.push(`stage ${c.key}: ${c.from} -> ${c.to}`);
  }
  for (const detail of escalations) rows.push({ event: 'ESCALATION', detail, evidence: input.tool_name ?? '' });
  for (const r of rows) appendTimeline(root, r.event, r.detail, r.evidence);
  const parts = [...escalations.map((d) => `ESCALATION: ${d}`), ...notes];
  return parts.join(' | ');
}
