// Reads a Claude Code PreToolUse hook payload on stdin and classifies the Bash command for gate-hook.sh.
// Node 22, no dependencies.
//
// Shipping code: `git push`, `gh pr create` (or its alias `gh pr new`), a POST to a `.../pulls` endpoint through
// `gh api`, or a `createPullRequest` mutation through `gh api graphql`. Reported on lines 1 to 4, unchanged:
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
//   merge <dir> <gates> <reason> <sha> <pr> <repo>
//       `gh pr merge [<pr>]`, `gh api -X PUT .../pulls/<n>/merge`, or a `mergePullRequest` mutation through
//       `gh api graphql`; sha is the --match-head-commit value (the `sha=` field of the REST call, the
//       `expectedHeadOid` of the mutation), pr is the positional argument or the number, repo is -R/--repo
//   pushref <dir> <gates> <reason> <refs>
//       one per `git push` that ships (not --dry-run or --delete); refs are the refspecs after the remote, joined
//       by U+001F (`*` for --all or --mirror), `-` when the push names none, so the hook can refuse a push to the
//       base branch
// Input that is not a JSON object exits 3 with a message on stderr.
import { resolve } from 'node:path';

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

const startDir = (typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const command = input?.tool_name === 'Bash' && typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';

// Shell-ish lexer: segments split on unquoted ; & | newline ( ) ` and $( ; tokens split on unquoted whitespace.
// It does not expand variables or globs. Unterminated quotes run to the end, which is the safe direction.
function segments(cmd) {
  const out = [];
  let toks = [], cur = '', has = false, q = '';
  const endTok = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const endSeg = () => { endTok(); if (toks.length) out.push(toks); toks = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = ''; else cur += c; continue; }
    if (q === '"') {
      if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) { cur += cmd[++i]; continue; }
      if (c === '"') q = ''; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { if (cmd[i + 1] !== '\n') { cur += cmd[i + 1]; has = true; } i++; continue; }
    if (c === '#' && !has && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== '\n') i++; endSeg(); continue; }
    if (c === '$' && cmd[i + 1] === '(') { endSeg(); i++; continue; }
    if (';&|\n()`'.includes(c)) { endSeg(); continue; }
    if (/\s/.test(c)) { endTok(); continue; }
    cur += c; has = true;
  }
  endSeg();
  return out;
}

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
const setVar = (k, v) => { if (k in vars) vars[k] = v; };
// The variables as one command sees them: its own `X=... cmd` prefix wins over the shell's.
const bypassFor = (local) => ({
  gates: local.FEATURE_LOOP_GATES ?? vars.FEATURE_LOOP_GATES,
  reason: local.FEATURE_LOOP_BYPASS_REASON ?? vars.FEATURE_LOOP_BYPASS_REASON,
});

const GIT_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const GH_API_OPTS_WITH_ARG = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);
// Options of `gh` and `gh pr ...` that take a value, so the value is not mistaken for a subcommand or a PR.
const GH_OPTS_WITH_ARG = new Set(['-R', '--repo', '-t', '--title', '--subject', '-b', '--body', '-F', '--body-file',
  '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project',
  '-r', '--reviewer', '-T', '--template', '-A', '--author-email', '--match-head-commit', '--hostname']);
const COMMIT_SHORT_WITH_ARG = 'mFCct';
const COMMIT_LONG_WITH_ARG = new Set(['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message',
  '--template', '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file']);
const ADD_INTERACTIVE = new Set(['-p', '--patch', '-i', '--interactive', '-e', '--edit']);

// `git [global options] <sub> <args>`: the subcommand, its arguments, and the directory after any -C.
function gitCall(args, dir) {
  let i = 0, d = dir;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C' && i + 1 < args.length) d = resolve(d, args[i + 1]);
    i += GIT_OPTS_WITH_ARG.has(a) ? 2 : 1;
  }
  return { sub: args[i], rest: args.slice(i + 1), dir: d };
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

// `gh` arguments split into positionals, the options that matter, and the raw option map.
function ghParse(args) {
  const pos = [], opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    if (GH_OPTS_WITH_ARG.has(flag)) { opt[flag] = eq > 0 ? a.slice(eq + 1) : (args[++i] ?? ''); continue; }
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  return { pos, opt };
}

// `gh api ...`: the method, the endpoint and the -f/-F fields (the first `name=value` of each).
function ghApi(rest) {
  let method = '', hasFields = false, endpoint = '';
  const fields = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (/^-X./.test(a)) { method = a.slice(2); continue; }
    if (GH_API_OPTS_WITH_ARG.has(flag)) {
      const v = inline ?? rest[++i] ?? '';
      if (flag === '-X' || flag === '--method') method = v;
      if (['-f', '--raw-field', '-F', '--field', '--input'].includes(flag)) hasFields = true;
      if (['-f', '--raw-field', '-F', '--field'].includes(flag) && v.includes('=')) fields[v.slice(0, v.indexOf('='))] = v.slice(v.indexOf('=') + 1);
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!endpoint) endpoint = a;
  }
  method = (method || (hasFields ? 'POST' : 'GET')).toUpperCase();
  const path = endpoint.replace(/[?#].*$/, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return { method, endpoint, path, fields };
}

function isGhCreate(args) {
  const { pos } = ghParse(args);
  if (pos[0] === 'pr' && (pos[1] === 'create' || pos[1] === 'new')) return true;
  if (pos[0] !== 'api') return false;
  const rest = args.slice(args.indexOf('api') + 1);
  const { method, endpoint, path } = ghApi(rest);
  if (endpoint === 'graphql') return rest.some((a) => a.includes('createPullRequest'));
  return method === 'POST' && /(^|\/)pulls$/.test(path);
}

// A merge through `gh pr merge`, the REST endpoint or a GraphQL mergePullRequest mutation, or null.
function ghMerge(args) {
  const { pos, opt } = ghParse(args);
  if (pos[0] === 'pr' && pos[1] === 'merge') {
    return { sha: opt['--match-head-commit'] ?? '', pr: pos[2] ?? '', repo: opt['-R'] ?? opt['--repo'] ?? '' };
  }
  if (pos[0] !== 'api') return null;
  const rest = args.slice(args.indexOf('api') + 1);
  const { method, endpoint, path, fields } = ghApi(rest);
  if (endpoint === 'graphql') {
    if (!rest.some((a) => a.includes('mergePullRequest'))) return null;
    // The head the caller pins: a variable passed with -f/-F, else a literal in the query text.
    const literal = /expectedHeadOid[^0-9a-fA-F]{0,8}([0-9a-fA-F]{7,64})\b/.exec(rest.join(' '));
    return { sha: fields.expectedHeadOid ?? literal?.[1] ?? '', pr: '', repo: '' };
  }
  const m = /^(?:repos\/([^/]+\/[^/]+)\/)?pulls\/([0-9]+)\/merge$/.exec(path);
  if (method !== 'PUT' || !m) return null;
  return { sha: fields.sha ?? '', pr: m[2], repo: m[1] ?? '' };
}

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
    if (name === '') { for (const [k, v] of Object.entries(local)) setVar(k, v); continue; }
    if (name === 'export') { for (const a of args) { const m = ASSIGN.exec(a); if (m) setVar(m[1], m[2]); } continue; }
    if (name === 'cd') { if (args[0] && args[0] !== '-' && !args[0].startsWith('$')) dir = resolve(dir, args[0]); continue; }
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
      const call = gitCall(args, dir);
      const pushDir = isGitPush(call);
      if (pushDir) {
        if (!push) push = { dir: pushDir, ...bypassFor(local) };
        actions.push({ kind: 'pushref', dir: pushDir, ...bypassFor(local), refs: pushRefs(call.rest) });
        continue;
      }
      if (call.sub === 'add') {
        adds.push({ dir: call.dir, args: call.rest.filter((a) => !ADD_INTERACTIVE.has(a)) });
      } else if (call.sub === 'commit' && !call.rest.includes('--dry-run')) {
        actions.push({ kind: 'commit', dir: call.dir, ...bypassFor(local), all: commitStagesAll(call.rest),
          adds: adds.filter((a) => a.dir === call.dir).map((a) => a.args) });
      }
    } else if (name === 'gh') {
      if (isGhCreate(args)) { if (!push) push = { dir, ...bypassFor(local) }; continue; }
      const merge = ghMerge(args);
      if (merge) actions.push({ kind: 'merge', dir, ...bypassFor(local), ...merge });
    }
  }
}

if (command) analyze(command, startDir, 0);

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
  } else if (a.kind === 'commit') {
    const addField = a.adds.map((args) => args.map((x) => x.replace(/[\t\r\n\u001e\u001f]+/g, ' ')).join('\u001f')).join('\u001e');
    out.push([...common, a.all ? '1' : '0', addField || '-'].join('\t'));
  } else {
    out.push([...common, field(a.sha), field(a.pr), field(a.repo)].join('\t'));
  }
}
process.stdout.write(out.join('\n') + '\n');
