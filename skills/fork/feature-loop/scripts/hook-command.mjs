// Reads a Claude Code PreToolUse hook payload on stdin and classifies the Bash command for gate-hook.sh.
// Node 22, no dependencies.
//
// Shipping code: `git push`. (Opening a PR is its own action, `create`, below.) Reported on lines 1 to 4, unchanged:
//   1. 1 when the command ships code, else 0
//   2. the directory to check: the session cwd, moved by any `cd <dir>` or `git -C <dir>` before the push
//   3. the effective FEATURE_LOOP_GATES value (an assignment in the command wins over the environment)
//   4. the effective FEATURE_LOOP_BYPASS_REASON, on one line
//
// Further actions follow, one per line, fields separated by a tab, an empty field written as `-`. Each action
// carries the bypass variables that were in force for that command alone:
//   commit <dir> <gates> <reason> <all> <adds>
//       `git commit` (not --dry-run), including `git -C <dir> commit`, `-a`/`-am` (all = 1) and `commit` chained
//       after `git add ...` (adds = the earlier add commands in that directory, commands joined by U+001E, the
//       arguments of a command by U+001F, interactive flags dropped), so the hook can judge the index as it will be
//   create <dir> <gates> <reason> <draft>
//       `gh pr create` (or `gh pr new`), a POST to a `.../pulls` endpoint through `gh api`, or a `createPullRequest`
//       mutation through `gh api graphql` (fork.9: gated by the pr phase); draft = 1 for a draft PR (--draft/-d, `draft=true`,
//       `isDraft: true`)
//   merge <dir> <gates> <reason> <sha> <pr> <repo>
//       `gh pr merge [<pr>]`, `gh api -X PUT .../pulls/<n>/merge`, `gh api -X POST .../merges`, or a `mergePullRequest` or
//       `enablePullRequestAutoMerge` mutation through `gh api graphql`; sha is the --match-head-commit value (the `sha=` field of the REST call, the
//       `expectedHeadOid` of the mutation), pr is the positional argument or the number, repo is -R/--repo
//   opaque <dir> <gates> <reason>
//       `gh api graphql` whose query is read from a file or stdin (`-F query=@file`, `--input`): it cannot be inspected,
//       so while a loop is active the hook refuses it (fork.9.1)
//   ambiguous <dir> <gates> <reason>
//       a command with a PR-creation or merge signature (`pr create`, `pulls`, `createPullRequest`, `/merges`, ...) that no
//       parser of gh looked at (`foo gh pr create`, a deeply nested shell): refused while a loop is active (fork.9.1)
//   pushref <dir> <gates> <reason> <refs>
//       one per `git push` that ships (not --dry-run or --delete); refs are the refspecs after the remote, joined
//       by U+001F (`*` for --all or --mirror), `-` when the push names none, so the hook can refuse a push to the
//       base branch
// Input that is not a JSON object exits 3 with a message on stderr.
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { segments } from './shell-lex.mjs';
import { ghMerge, isDraftCreate, isGhCreate, isOpaqueGraphql } from './hook-gh.mjs';

// On Windows the command runs in Git Bash, so its paths are POSIX (/c/repo, /tmp/x); node would resolve them
// against the current drive and check a directory that does not exist. Map them to native paths first.
function nativePath(p) {
  if (process.platform !== 'win32' || !p.startsWith('/') || p.startsWith('//')) return p;
  const drive = /^\/([a-zA-Z])(\/|$)/.exec(p);
  if (drive) return `${drive[1]}:/${p.slice(3)}`;
  const r = spawnSync('cygpath', ['-m', p], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : p;
}

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
// Input that is not a JSON object cannot be judged: say so and exit 3, so gate-hook.sh can fail closed (when a loop
// is active) instead of treating the command as harmless.
function unjudgeable(reason) {
  console.error(`hook input ${reason}`);
  process.exit(3);
}
let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch (e) {
  unjudgeable(`is not valid JSON: ${e.message}`);
}
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) unjudgeable('is not a JSON object');
const input = parsed;

const startDir = nativePath((typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
const command = input?.tool_name === 'Bash' && typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WRAPPERS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'nohup',
  'command', 'builtin', 'exec', 'sudo', 'env', 'xargs', 'nice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const base = (t) => t.split('/').pop();

// Effective variables: the hook's environment, overridden by `export X=...` or `X=... cmd` in the command.
const vars = {
  FEATURE_LOOP_GATES: process.env.FEATURE_LOOP_GATES ?? '',
  FEATURE_LOOP_BYPASS_REASON: process.env.FEATURE_LOOP_BYPASS_REASON ?? '',
};
const setVar = (k, v) => { if (k in vars) vars[k] = v; else if (k in gitEnv) gitEnv[k] = v; };
// The variables as one command sees them: its own `X=... cmd` prefix wins over the shell's.
const bypassFor = (local) => ({
  gates: local.FEATURE_LOOP_GATES ?? vars.FEATURE_LOOP_GATES,
  reason: local.FEATURE_LOOP_BYPASS_REASON ?? vars.FEATURE_LOOP_BYPASS_REASON,
});

const GIT_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const COMMIT_SHORT_WITH_ARG = 'mFCct';
const COMMIT_LONG_WITH_ARG = new Set(['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message',
  '--template', '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file']);
const ADD_INTERACTIVE = new Set(['-p', '--patch', '-i', '--interactive', '-e', '--edit']);

// `git [global options] <sub> <args>`: the subcommand, its arguments, the directory after any -C, and every directory the
// command may really act on: `--work-tree`/`GIT_WORK_TREE` and the parent of `--git-dir`/`GIT_DIR` (a bare repository is
// its own directory) point at a repository other than the one the shell is in. `dir` is the one that holds a loop's run
// file when one does, else the first of them.
const gitEnv = { GIT_DIR: '', GIT_WORK_TREE: '' }; // `export GIT_DIR=...` earlier in the command
const hasRunFile = (d) => existsSync(join(d, '.scratch', 'gates.json'));
function gitCall(args, dir, env = {}) {
  let i = 0, d = dir;
  let gitDir = env.GIT_DIR ?? gitEnv.GIT_DIR, workTree = env.GIT_WORK_TREE ?? gitEnv.GIT_WORK_TREE;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i], next = args[i + 1];
    if (a === '-C' && next !== undefined) d = resolve(d, nativePath(next));
    if (a === '--git-dir' && next !== undefined) gitDir = next;
    else if (a.startsWith('--git-dir=')) gitDir = a.slice('--git-dir='.length);
    if (a === '--work-tree' && next !== undefined) workTree = next;
    else if (a.startsWith('--work-tree=')) workTree = a.slice('--work-tree='.length);
    i += GIT_OPTS_WITH_ARG.has(a) ? 2 : 1;
  }
  const cands = [d];
  if (workTree) cands.push(resolve(d, nativePath(workTree)));
  if (gitDir) {
    const g = resolve(d, nativePath(gitDir));
    cands.push(basename(g) === '.git' ? dirname(g) : g);
  }
  const dirs = [...new Set(cands)];
  const primary = dirs.length === 1 ? d : (dirs.find(hasRunFile) ?? dirs[dirs.length - 1]);
  return { sub: args[i], rest: args.slice(i + 1), dir: primary, dirs };
}

function isGitPush({ sub, rest, dir }) {
  if (sub !== 'push') return null;
  // A dry run or a remote branch deletion ships nothing.
  if (rest.some((a) => a === '--dry-run' || a === '-n' || a === '--delete' || a === '-d')) return null;
  return dir;
}

// The refspecs of a `git push`: the positionals after the remote. `*` stands for --all and --mirror (every branch).
const PUSH_OPTS_WITH_ARG = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
function pushRefs(rest) {
  const pos = [];
  let all = false, remoteGiven = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') { pos.push(...rest.slice(i + 1)); break; }
    if (a === '--all' || a === '--mirror') all = true;
    if (a === '--repo') remoteGiven = true;
    if (PUSH_OPTS_WITH_ARG.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  const refs = remoteGiven ? pos : pos.slice(1);
  if (all) refs.push('*');
  return refs;
}

// Does this `git commit` stage tracked changes itself (-a, -am, --all)? Arguments of -m, -F ... are skipped.
function commitStagesAll(rest) {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--') break;
    if (a === '--all') return true;
    if (a.startsWith('--')) { if (COMMIT_LONG_WITH_ARG.has(a)) i++; continue; }
    if (!/^-[A-Za-z]/.test(a)) continue;
    for (let k = 1; k < a.length; k++) {
      if (a[k] === 'a') return true;
      if (COMMIT_SHORT_WITH_ARG.includes(a[k])) { if (k === a.length - 1) i++; break; }
    }
  }
  return false;
}

// A command that carries a PR-creation or merge signature but that no gh parser looked at is ambiguous: the hook cannot tell
// what it does (fork.9.1). A signature inside the text of a harmless command (echo, git commit -m, grep) is not one.
const SIGNATURE = /pr\s+(?:create|new|merge)|pulls|createPullRequest|mergePullRequest|enablePullRequestAutoMerge|\/merges/;
const TEXT_ONLY = new Set(['git', 'echo', 'printf', 'cat', 'grep', 'egrep', 'rg', 'head', 'tail', 'less', 'ls', 'find', 'sed', 'awk', 'tee', 'wc', 'diff']);
let ambiguous = false;
let push = null; // the first command that ships code: { dir, gates, reason }
const actions = []; // commits and merges
const adds = []; // `git add` commands seen so far: { dir, args }

function analyze(cmd, dir, depth) {
  for (const seg of segments(cmd)) {
    let i = 0;
    const local = {};
    // Leading assignments and wrappers: `FOO=1 env -i sudo git push`.
    for (;;) {
      if (i >= seg.length) break;
      const t = seg[i];
      const m = ASSIGN.exec(t);
      if (m) { local[m[1]] = m[2]; i++; continue; }
      if (WRAPPERS.has(base(t))) { i++; while (i < seg.length && seg[i].startsWith('-') && base(seg[i - 1]) !== '{') i++; continue; }
      break;
    }
    const name = i < seg.length ? base(seg[i]) : '';
    const args = seg.slice(i + 1);
    if (name && name !== 'gh' && !TEXT_ONLY.has(name) && !((SHELLS.has(name) || name === 'eval') && depth < 3) && SIGNATURE.test(seg.slice(i).join(' '))) ambiguous = true;
    if (name === '') { for (const [k, v] of Object.entries(local)) setVar(k, v); continue; }
    if (name === 'export') { for (const a of args) { const m = ASSIGN.exec(a); if (m) setVar(m[1], m[2]); } continue; }
    if (name === 'cd') { if (args[0] && args[0] !== '-' && !args[0].startsWith('$')) dir = resolve(dir, nativePath(args[0])); continue; }
    if ((SHELLS.has(name) || name === 'eval') && depth < 3) {
      const ci = name === 'eval' ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const inner = name === 'eval' ? args.join(' ') : ci >= 0 ? args[ci + 1] : undefined;
      if (inner !== undefined) {
        const saved = { ...vars };
        for (const [k, v] of Object.entries(local)) setVar(k, v);
        analyze(inner, dir, depth + 1);
        if (name !== 'eval') Object.assign(vars, saved); // a subshell's assignments do not leak out
      }
      continue;
    }
    if (name === 'git') {
      const call = gitCall(args, dir, local);
      const pushDir = isGitPush(call);
      if (pushDir) {
        if (!push) push = { dir: pushDir, ...bypassFor(local) };
        // One base-branch check per repository the push may reach (see gitCall).
        for (const d of call.dirs) actions.push({ kind: 'pushref', dir: d, ...bypassFor(local), refs: pushRefs(call.rest) });
        continue;
      }
      if (call.sub === 'add') {
        adds.push({ dir: call.dir, args: call.rest.filter((a) => !ADD_INTERACTIVE.has(a)) });
      } else if (call.sub === 'commit' && !call.rest.includes('--dry-run')) {
        actions.push({ kind: 'commit', dir: call.dir, ...bypassFor(local), all: commitStagesAll(call.rest),
          adds: adds.filter((a) => a.dir === call.dir).map((a) => a.args) });
      }
    } else if (name === 'gh') {
      if (isOpaqueGraphql(args)) { actions.push({ kind: 'opaque', dir, ...bypassFor(local) }); continue; }
      if (isGhCreate(args)) { actions.push({ kind: 'create', dir, ...bypassFor(local), draft: isDraftCreate(args) }); continue; }
      const merge = ghMerge(args);
      if (merge) actions.push({ kind: 'merge', dir, ...bypassFor(local), ...merge });
    }
  }
}

if (command) analyze(command, startDir, 0);
if (ambiguous) actions.push({ kind: 'ambiguous', dir: startDir, ...bypassFor({}) });

const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
const field = (s) => String(s ?? '').replace(/[\t\r\n\u001e\u001f]+/g, ' ').trim() || '-';
const out = [
  push ? 1 : 0,
  oneLine(push ? push.dir : startDir),
  oneLine(push ? push.gates : vars.FEATURE_LOOP_GATES),
  oneLine(push ? push.reason : vars.FEATURE_LOOP_BYPASS_REASON),
];
for (const a of actions) {
  const common = [a.kind, a.dir, a.gates, a.reason].map(field);
  if (a.kind === 'pushref') {
    out.push([...common, a.refs.map((x) => x.replace(/[\t\r\n\u001e\u001f]+/g, ' ')).join('\u001f') || '-'].join('\t'));
  } else if (a.kind === 'opaque' || a.kind === 'ambiguous') {
    out.push(common.join('	'));
  } else if (a.kind === 'create') {
    out.push([...common, a.draft ? '1' : '0'].join('	'));
  } else if (a.kind === 'commit') {
    const addField = a.adds.map((args) => args.map((x) => x.replace(/[\t\r\n\u001e\u001f]+/g, ' ')).join('\u001f')).join('\u001e');
    out.push([...common, a.all ? '1' : '0', addField || '-'].join('\t'));
  } else {
    out.push([...common, field(a.sha), field(a.pr), field(a.repo)].join('\t'));
  }
}
process.stdout.write(out.join('\n') + '\n');
