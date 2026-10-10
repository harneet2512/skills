// Reads a Claude Code PreToolUse hook payload on stdin and classifies the tool call for gate-hook.sh: the command of
// a Bash call, the command of a PowerShell call, or an MCP tool call. Node 22, no dependencies.
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
//   psship <dir> <gates> <reason>
//       a PowerShell call whose command ships (git push, gh pr create/new/ready/merge, a gh api write to pulls,
//       merges, contents or git/refs, a create, merge, ready or auto-merge GraphQL mutation); the hook refuses it and
//       points to the Bash tool, where this classifier applies. A token match, not a PowerShell parser
// MCP tools, by the tool name after the last `__`: `create_pull_request` ships like `gh pr create`;
// `merge_pull_request` is a merge (sha from the input's sha, expectedHeadOid or match_head_commit, else empty);
// `push_files`, `create_or_update_file` and `delete_file` ship like a push to `branch` (a missing branch is the
// repository default, so it counts as the base branch); `update_pull_request_branch` ships like a push. Other MCP
// tools are not read. An MCP shipping tool without a tool_input object exits 3.
// Heredoc bodies are data unless the line feeds a shell (bash, sh, zsh, dash, eval, source); an unquoted delimiter
// still expands $(...) and backticks in the body, so those are classified.
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
const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
const toolInput = input.tool_input;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const command = toolName === 'Bash' && typeof toolInput?.command === 'string' ? toolInput.command : '';
// A PowerShell call whose command cannot be read cannot be judged (a Bash call without one ships nothing).
if (toolName === 'PowerShell' && !(isObject(toolInput) && typeof toolInput.command === 'string')) {
  unjudgeable('has no PowerShell command');
}
const psCommand = toolName === 'PowerShell' ? toolInput.command : '';

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

// Heredoc bodies are data for a program like python or cat, and commands for a shell. The body of each heredoc is
// dropped from the command text unless its line feeds a shell; an unquoted delimiter expands $(...) and backticks in
// the body, so the commands inside those stay. `<<<` and a shift inside $((...)) are not heredocs.
const SHELL_LINE = new Set([...SHELLS, 'eval', 'source', '.']);
const lineRunsShell = (line) => line.split(/[\s;&|()<>`'"]+/).some((t) => SHELL_LINE.has(t.split('/').pop()));
const HEREDOC_OP = /^<<(-?)[ \t]*(?:'([^'\n]+)'|"([^"\n]+)"|(\\?[A-Za-z_][A-Za-z0-9_.-]*))/;

function arithmeticEnd(s, i) {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '(') depth++;
    else if (s[j] === ')' && --depth === 0) return j + 1;
  }
  return s.length;
}

// The commands run by $(...) and backticks inside the text of an unquoted heredoc body.
function substitutions(body) {
  const found = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\') { i++; continue; }
    if (body[i] === '`') {
      const j = body.indexOf('`', i + 1);
      const end = j < 0 ? body.length : j;
      found.push(body.slice(i + 1, end));
      i = end;
    } else if (body[i] === '$' && body[i + 1] === '(') {
      let depth = 1, j = i + 2;
      while (j < body.length && depth > 0) { if (body[j] === '(') depth++; else if (body[j] === ')') depth--; j++; }
      found.push(body.slice(i + 2, depth > 0 ? j : j - 1));
      i = j - 1;
    }
  }
  return found;
}

// Reads the bodies of the heredocs started on the line that ends at cmd[at]; returns the text to keep and where the
// command resumes.
function heredocBodies(cmd, at, pending, feedsShell) {
  let keep = '', pos = at + 1;
  for (const h of pending) {
    const body = [];
    while (pos < cmd.length) {
      const e = cmd.indexOf('\n', pos);
      const line = cmd.slice(pos, e < 0 ? cmd.length : e);
      pos = e < 0 ? cmd.length : e + 1;
      if ((h.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === h.delim) break;
      body.push(line);
    }
    const kept = feedsShell ? body : h.quoted ? [] : substitutions(body.join('\n'));
    if (kept.length) keep += kept.join('\n') + '\n';
  }
  return { keep, resume: pos };
}

function stripHeredocs(cmd, forceShell = false) {
  if (!cmd.includes('<<')) return cmd;
  let out = '', lineStart = 0, q = '';
  const pending = [];
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { out += c; if (c === "'") q = ''; continue; }
    if (q === '"') {
      if (c === '\\' && i + 1 < cmd.length) { out += c + cmd[++i]; continue; }
      out += c;
      if (c === '"') q = '';
      continue;
    }
    if (c === "'" || c === '"') { q = c; out += c; continue; }
    if (c === '\\') { out += c + (cmd[i + 1] ?? ''); i++; continue; }
    if (c === '#' && (i === 0 || /\s/.test(cmd[i - 1]))) {
      const e = cmd.indexOf('\n', i);
      const end = e < 0 ? cmd.length : e;
      out += cmd.slice(i, end);
      i = end - 1;
      continue;
    }
    if (c === '$' && cmd.startsWith('$((', i)) { const end = arithmeticEnd(cmd, i + 1); out += cmd.slice(i, end); i = end - 1; continue; }
    if (c === '<' && cmd.startsWith('<<<', i)) { out += '<<<'; i += 2; continue; }
    if (c === '<' && cmd[i + 1] === '<') {
      const op = HEREDOC_OP.exec(cmd.slice(i));
      if (!op) { out += '<<'; i++; continue; }
      const word = op[2] ?? op[3] ?? op[4];
      pending.push({ delim: word.replace(/^\\/, ''), strip: op[1] === '-', quoted: op[4] === undefined || op[4].startsWith('\\') });
      out += op[0];
      i += op[0].length - 1;
      continue;
    }
    if (c === '\n' && pending.length) {
      const { keep, resume } = heredocBodies(cmd, i, pending, forceShell || lineRunsShell(out.slice(lineStart)));
      out += '\n' + keep;
      lineStart = out.length;
      pending.length = 0;
      i = resume - 1;
      continue;
    }
    if (c === '\n') lineStart = out.length + 1;
    out += c;
  }
  return out;
}

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

function analyze(cmd, dir, depth, forceShell = false) {
  for (const seg of segments(stripHeredocs(cmd, forceShell))) {
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
        analyze(inner, dir, depth + 1, name === 'eval');
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

// ---- PowerShell: a conservative token match for shipping commands (no PowerShell parser, no second classifier)

const PS_LAUNCHERS = new Set(['powershell', 'pwsh', 'cmd', 'iex', 'invoke-expression', 'start-process', 'saps', 'start',
  'bash', 'sh', 'zsh', 'dash', 'wsl', 'call']);
const PS_VALUED_OPTS = new Set(['-workingdirectory', '-redirectstandardoutput', '-redirectstandarderror',
  '-redirectstandardinput', '-verb', '-windowstyle', '-credential']);
const GH_WRITE_MUTATION = /createPullRequest|mergePullRequest|markPullRequestReadyForReview|enablePullRequestAutoMerge/;
const GH_WRITE_PATH = /(^|\/)(pulls|merges|contents|git\/refs)(\/|$)/;
const psName = (t) => base(t).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');

function ghShips(args) {
  const { pos } = ghParse(args);
  const [a, b] = [pos[0]?.toLowerCase(), pos[1]?.toLowerCase()];
  if (a === 'pr') return ['create', 'new', 'ready', 'merge'].includes(b);
  if (a !== 'api') return false;
  const rest = args.slice(args.findIndex((x) => x.toLowerCase() === 'api') + 1);
  if (GH_WRITE_MUTATION.test(rest.join(' '))) return true;
  const { method, endpoint, path } = ghApi(rest);
  return endpoint !== 'graphql' && method !== 'GET' && GH_WRITE_PATH.test(path);
}

function psSegmentShips(toks, depth) {
  let i = 0;
  while (i < toks.length && (toks[i] === '{' || toks[i] === '}')) i++;
  if (i >= toks.length) return false;
  const name = psName(toks[i]);
  const rest = toks.slice(i + 1);
  if (name === 'git') {
    const call = gitCall(rest, '.');
    return call.sub?.toLowerCase() === 'push' && !rest.some((a) => a === '--dry-run' || a === '-n');
  }
  if (name === 'gh') return ghShips(rest);
  if (!PS_LAUNCHERS.has(name)) return false;
  // A launcher: its own arguments are a command line (quoted as one token or spread over several).
  const words = [];
  for (let k = 0; k < rest.length; k++) {
    const t = rest[k];
    if (PS_VALUED_OPTS.has(t.toLowerCase())) { k++; continue; }
    if (/^-[A-Za-z]/.test(t) || /^\/[A-Za-z]$/.test(t)) continue;
    words.push(t);
  }
  return psShips(words.filter((w) => /\s/.test(w)).join('\n'), depth + 1) || psSegmentShips(words, depth + 1);
}

function psShips(cmd, depth = 0) {
  if (depth > 3) return true; // nested too deep to read: refuse
  const flat = cmd
    .replace(/@'[\s\S]*?'@/g, "''").replace(/@"[\s\S]*?"@/g, '""') // here-strings are data
    .replace(/`\r?\n/g, ' ').replace(/`/g, '').replace(/\\/g, '/'); // continuation, escape, Windows paths
  return segments(flat).some((toks) => psSegmentShips(toks, depth));
}

// ---- MCP: shipping tools by the name after the last `__`

const MCP_BRANCH_WRITES = new Set(['push_files', 'create_or_update_file', 'delete_file']);
const mcpText = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

function mcpShipping(tool) {
  const create = tool === 'create_pull_request';
  const merge = tool === 'merge_pull_request';
  const branchWrite = MCP_BRANCH_WRITES.has(tool);
  if (!create && !merge && !branchWrite && tool !== 'update_pull_request_branch') return;
  if (!isObject(toolInput)) unjudgeable(`for ${toolName} has no tool_input object`);
  const bypass = bypassFor({});
  if (merge) {
    const repo = mcpText(toolInput.owner) && mcpText(toolInput.repo) ? `${toolInput.owner}/${toolInput.repo}` : '';
    const sha = mcpText(toolInput.sha) || mcpText(toolInput.expectedHeadOid) || mcpText(toolInput.match_head_commit);
    actions.push({ kind: 'merge', dir: startDir, ...bypass, sha, pr: mcpText(toolInput.pullNumber) || mcpText(toolInput.pull_number), repo });
    return;
  }
  push = { dir: startDir, ...bypass };
  if (branchWrite) actions.push({ kind: 'pushref', dir: startDir, ...bypass, refs: [mcpText(toolInput.branch) || '*'] });
}

if (command) analyze(command, startDir, 0);
if (psCommand && psShips(psCommand)) actions.push({ kind: 'psship', dir: startDir, ...bypassFor({}) });
if (toolName.startsWith('mcp__')) mcpShipping(toolName.slice(toolName.lastIndexOf('__') + 2));

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
  if (a.kind === 'psship') {
    out.push(common.join('	'));
  } else if (a.kind === 'pushref') {
    out.push([...common, a.refs.map((x) => x.replace(/[\t\r\n\u001e\u001f]+/g, ' ')).join('\u001f') || '-'].join('\t'));
  } else if (a.kind === 'commit') {
    const addField = a.adds.map((args) => args.map((x) => x.replace(/[\t\r\n\u001e\u001f]+/g, ' ')).join('\u001f')).join('\u001e');
    out.push([...common, a.all ? '1' : '0', addField || '-'].join('\t'));
  } else {
    out.push([...common, field(a.sha), field(a.pr), field(a.repo)].join('\t'));
  }
}
process.stdout.write(out.join('\n') + '\n');
