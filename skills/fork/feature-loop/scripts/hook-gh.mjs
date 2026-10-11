// What a `gh` command line does, for hook-command.mjs: opening a pull request, merging one, or hiding what it does in a
// file. Pure functions over the argument list (after `gh`). Node 22, no dependencies.

const GH_API_OPTS_WITH_ARG = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);
// Options of `gh` and `gh pr ...` that take a value, so the value is not mistaken for a subcommand or a PR.
const GH_OPTS_WITH_ARG = new Set(['-R', '--repo', '-t', '--title', '--subject', '-b', '--body', '-F', '--body-file',
  '-B', '--base', '-H', '--head', '-a', '--assignee', '-l', '--label', '-m', '--milestone', '-p', '--project',
  '-r', '--reviewer', '-T', '--template', '-A', '--author-email', '--match-head-commit', '--hostname']);
// `gh` arguments split into positionals, the options that matter, and the raw option map.
export function ghParse(args) {
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
export function ghApi(rest) {
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

export function isGhCreate(args) {
  const { pos } = ghParse(args);
  if (pos[0] === 'pr' && (pos[1] === 'create' || pos[1] === 'new')) return true;
  if (pos[0] !== 'api') return false;
  const rest = args.slice(args.indexOf('api') + 1);
  const { method, endpoint, path } = ghApi(rest);
  if (endpoint === 'graphql') return rest.some((a) => a.includes('createPullRequest'));
  return method === 'POST' && /(^|\/)pulls$/.test(path);
}

// Is the PR being opened a draft? `gh pr create --draft`/`-d`, `-f draft=true` on the REST call, `isDraft` in the mutation.
export function isDraftCreate(args) {
  return args.includes('--draft') || args.includes('-d') || /draft\W{0,4}true/i.test(args.join(' '));
}

// A GraphQL call whose query is read from a file or stdin (`-F query=@file`, `-f query=@...`, `--input`): what it does cannot
// be read from the command line, so the gate cannot judge it.
export function isOpaqueGraphql(args) {
  const { pos } = ghParse(args);
  if (pos[0] !== 'api') return false;
  const rest = args.slice(args.indexOf('api') + 1);
  if (ghApi(rest).endpoint !== 'graphql') return false;
  return rest.some((a) => a === '--input' || a.startsWith('--input=') || /query=@/.test(a));
}

const GRAPHQL_MERGES = ['mergePullRequest', 'enablePullRequestAutoMerge'];

// A merge through `gh pr merge`, the REST endpoint (PUT pulls/<n>/merge, POST merges) or a GraphQL mergePullRequest or
// enablePullRequestAutoMerge mutation, or null.
export function ghMerge(args) {
  const { pos, opt } = ghParse(args);
  if (pos[0] === 'pr' && pos[1] === 'merge') {
    return { sha: opt['--match-head-commit'] ?? '', pr: pos[2] ?? '', repo: opt['-R'] ?? opt['--repo'] ?? '' };
  }
  if (pos[0] !== 'api') return null;
  const rest = args.slice(args.indexOf('api') + 1);
  const { method, endpoint, path, fields } = ghApi(rest);
  if (endpoint === 'graphql') {
    if (!rest.some((a) => GRAPHQL_MERGES.some((m) => a.includes(m)))) return null;
    // The head the caller pins: a variable passed with -f/-F, else a literal in the query text.
    const literal = /expectedHeadOid[^0-9a-fA-F]{0,8}([0-9a-fA-F]{7,64})\b/.exec(rest.join(' '));
    return { sha: fields.expectedHeadOid ?? literal?.[1] ?? '', pr: '', repo: '' };
  }
  // POST repos/<o>/<r>/merges merges a branch into another on GitHub's side: the same as the merge of a PR.
  const branchMerge = /^(?:repos\/([^/]+\/[^/]+)\/)?merges$/.exec(path);
  if (method === 'POST' && branchMerge) return { sha: '', pr: '', repo: branchMerge[1] ?? '' };
  const m = /^(?:repos\/([^/]+\/[^/]+)\/)?pulls\/([0-9]+)\/merge$/.exec(path);
  if (method !== 'PUT' || !m) return null;
  return { sha: fields.sha ?? '', pr: m[2], repo: m[1] ?? '' };
}

