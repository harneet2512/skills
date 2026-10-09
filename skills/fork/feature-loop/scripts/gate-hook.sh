#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Bash), registered in the plugin's hooks/hooks.json. It gates four moments,
# each only where a feature loop is active: .scratch/gates.json in the project (or in the main worktree of the
# repository, when the command runs in a linked builder worktree) without "status": "closed". Work that is not
# running the feature loop is never blocked.
#
#   push / PR   `git push`, `gh pr create`, or a `gh api` POST to .../pulls (or a createPullRequest mutation): runs
#               check-gates.sh --phase build, the gates due while building: G1, G2, G8. The first push and the
#               draft PR open during Build, before the live run, the review and the metrics exist.
#   base push   `git push` whose target is the base branch of gates.json ("base"): refused, the merge goes through
#               the PR so that the merge gate runs.
#   commit      `git commit` (also `-a`, `-am`, `git -C <dir> commit`, and `git add ... && git commit`): runs
#               slop-check.sh --staged on what the commit will contain, in the worktree the commit runs in; findings
#               not listed under ## Justified in the loop root's .scratch/review/<slug>.md block it.
#   merge       `gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, or a mergePullRequest mutation: needs the sha
#               being merged (--match-head-commit, sha=, expectedHeadOid), the checked-out HEAD equal to that sha,
#               check-gates.sh --phase merge green (G1 to G6, G8) and green CI on exactly that sha. CI is `gh pr
#               checks` plus the PR head equal to the sha, or the "merge_check" command in .scratch/gates.json
#               ({sha} and {pr} are filled in). G7, the metrics line, is the close gate and is not asked here.
#
# A red gate blocks the command: exit 2 with the reasons on stderr, which Claude Code shows to the model.
# It fails closed: when a loop is active and node is missing, hook-command.mjs fails, the hook input is not JSON,
# gates.json is not valid JSON, or a chained `git add` fails, the command is blocked (exit 2) with the reason. Only
# where no loop is active may those problems end in a warning (exit 1, shown to the user, the command runs).
#
# Deliberate bypass: FEATURE_LOOP_GATES=off together with a non-empty FEATURE_LOOP_BYPASS_REASON, set in the
# environment or as assignments in the command itself. The bypass is appended to .scratch/loop-metrics.md as
# "<date> <slug> gates bypassed: <reason>" (with " (commit)", " (merge)" or " (push to base)" after the reason for
# those gates). FEATURE_LOOP_GATES=off without a reason is ignored. It needs node (to read the command), so it
# cannot unblock a hook that failed closed because node is missing.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
slop="$here/../../concern-topics/scripts/slop-check.sh"
# shellcheck source=loop-root.sh
. "$here/loop-root.sh"
input="$(cat)"

# Fast path: most Bash calls cannot ship, commit or merge, so do not start node for them.
printf '%s' "$input" | grep -qE 'push|pulls|PullRequest|graphql|commit|merge|(^|[^[:alnum:]_])pr([^[:alnum:]_]|$)' || exit 0

# ---- the loop at the session's directory, found without node

# The "cwd" of the payload, read with sed so that a broken payload still has one.
payload_cwd() {
  printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 | sed 's/\\\\/\\/g'
}
session_dir="$(payload_cwd)"
src=0
session_root="$(loop_root "$session_dir")" || src=$?

# fail_closed <what went wrong>: the loop is active, so a command that may ship, commit or merge is not let through.
fail_closed() {
  {
    echo "feature-loop gate hook: $1, so the gates were not checked and this command was blocked (repo: $session_root)."
    echo "$2"
  } >&2
  exit 2
}

if ! command -v node >/dev/null 2>&1; then
  [ "$src" -eq 0 ] && fail_closed "node not found on PATH" "Install Node 22 (or fix PATH) and retry."
  [ "$src" -eq 2 ] && exit 0 # a closed loop is silent
  echo "feature-loop gate hook: node not found on PATH, so the gates were not checked" >&2
  exit 1 # non-blocking: shown to the user, the command runs
fi

parsed="$(printf '%s' "$input" | node "$here/hook-command.mjs")" || {
  [ "$src" -eq 0 ] && fail_closed "could not read the hook input" "Check that the hook payload is JSON and that node works (node --version), then retry."
  echo "feature-loop gate hook: could not read the hook input, so the gates were not checked" >&2
  exit 1
}
{ IFS= read -r match; IFS= read -r dir; IFS= read -r gates_flag; IFS= read -r reason; actions="$(cat)"; } <<< "$parsed"

# ---- helpers

# A string field of .scratch/gates.json, empty when absent. A file that cannot be read is an error, not an empty field.
json_field() { # <root> <key>
  node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; process.stdout.write(typeof v === "string" ? v : "");' "$1/.scratch/gates.json" "$2" || {
    echo "feature-loop gate hook: cannot read \"$2\" from $1/.scratch/gates.json" >&2
    return 1
  }
}

# validate_run <root>: a gates.json that is not JSON stops the command (exit 2), once per root.
validated=" "
validate_run() {
  local err
  case "$validated" in *" $1 "*) return 0 ;; esac
  if err="$(node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$1/.scratch/gates.json" 2>&1)"; then
    validated="$validated$1 "
    return 0
  fi
  {
    echo "feature-loop gate hook: $1/.scratch/gates.json is not valid JSON, so the gates cannot run and this command was blocked:"
    printf '%s\n' "$err" | grep -m1 -E '^[A-Za-z]*Error' || printf '%s\n' "$err" | head -n 1
    echo "Fix the file (see skills/fork/feature-loop/gates.md), or set \"status\": \"closed\" once the loop is over."
  } >&2
  exit 2
}

# bypass <root> <gates flag> <reason> <what>: succeeds when the bypass applies, and records it. A bypass that cannot
# be recorded is not allowed: exit 2.
bypass() {
  local root="$1" flag="$2" why="$3" what="$4" slug note=""
  [ "$flag" = off ] && [ -n "$(printf '%s' "$why" | tr -d '[:space:]')" ] || return 1
  slug="$(json_field "$root" slug)" || exit 2
  slug="${slug:-unknown}"
  [ -n "$what" ] && note=" ($what)"
  if ! printf '%s %s gates bypassed: %s%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$slug" "$why" "$note" >> "$root/.scratch/loop-metrics.md"; then
    echo "feature-loop gates: bypass not allowed, because it could not be recorded in $root/.scratch/loop-metrics.md" >&2
    exit 2
  fi
  return 0
}

bypass_hint() { # <flag>
  if [ "$1" = off ]; then echo "FEATURE_LOOP_GATES=off was set without FEATURE_LOOP_BYPASS_REASON, so the gates ran anyway."; fi
  echo "Bypass on purpose (recorded in .scratch/loop-metrics.md): FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='<why>' <same command>"
}

blocked=0

# ---- push and PR creation

gate_push() { # <root> <dir> <flag> <reason>
  local root="$1" d="$2" flag="$3" why="$4" out code
  bypass "$root" "$flag" "$why" "" && return 0
  out="$(cd "$(loop_work_tree "$d" "$root")" && "$here/check-gates.sh" --phase build 2>&1)"; code=$?
  [ "$code" -eq 0 ] && return 0
  blocked=1
  {
    if [ "$code" -eq 1 ]; then
      echo "feature-loop gates are red, so this push or PR was blocked (repo: $root)."
      printf '%s\n' "$out" | grep -E '^G[1-8] red:'
    else
      echo "feature-loop gates could not run (exit $code), so this push or PR was blocked (repo: $root):"
      printf '%s\n' "$out"
    fi
    echo "Fix: produce or fix each named file (see skills/fork/feature-loop/gates.md), check with check-gates.sh --phase build, then retry."
    bypass_hint "$flag"
  } >&2
}

# ---- push to the base branch

# gate_push_base <root> <dir> <flag> <reason> <refs>: refuse a push whose destination is the loop's base branch.
# <refs> are the refspecs of the push joined by U+001F, empty when it names none (the current branch is pushed).
gate_push_base() {
  local root="$1" d="$2" flag="$3" why="$4" refs="$5" base bare bare2="" first cur ref dst hit=0
  local -a list
  base="$(json_field "$root" base)" || exit 2
  [ -n "$base" ] || return 0
  bare="${base#refs/heads/}"
  case "$bare" in
    */*) first="${bare%%/*}"; if git -C "$d" remote 2>/dev/null | grep -qx -- "$first"; then bare2="${bare#*/}"; fi ;; # origin/main
  esac
  cur="$(git -C "$d" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -n "$refs" ]; then IFS=$'\x1f' read -ra list <<< "$refs"; else list=(HEAD); fi
  for ref in "${list[@]}"; do
    ref="${ref#+}"
    case "$ref" in
      '*') hit=1; continue ;;
      *:*) dst="${ref##*:}" ;;
      *) dst="$ref" ;;
    esac
    dst="${dst#refs/heads/}"
    { [ "$dst" = HEAD ] || [ -z "$dst" ]; } && dst="$cur"
    if [ -n "$dst" ] && { [ "$dst" = "$bare" ] || { [ -n "$bare2" ] && [ "$dst" = "$bare2" ]; }; }; then hit=1; fi
  done
  [ "$hit" -eq 1 ] || return 0
  bypass "$root" "$flag" "$why" "push to base" && return 0
  blocked=1
  {
    echo "feature-loop push gate: this push updates the base branch ($bare) directly, which skips the merge gate (repo: $root): merge through the PR so the merge gate runs."
    bypass_hint "$flag"
  } >&2
}

# ---- commit

# slop-check --staged on the index as this commit will leave it: a private copy of the index, with `git add -u`
# applied for -a and with the `git add` commands that came earlier in the same command line. It runs in the worktree
# the commit runs in; the justified file is the loop root's.
staged_findings() { # <root> <dir> <all> <adds> <review file, absolute>
  local root="$1" d="$2" all="$3" adds="$4" review="$5" tmp src c wt addout
  local -a cmds a
  wt="$(loop_work_tree "$d" "$root")"
  tmp="$(mktemp)"
  src="$(git -C "$d" rev-parse --git-path index 2>/dev/null || true)"
  case "$src" in /*|[A-Za-z]:*) ;; *) src="$d/$src" ;; esac
  if [ -f "$src" ]; then cp "$src" "$tmp"; else rm -f "$tmp"; fi
  export GIT_INDEX_FILE="$tmp"
  if [ "$all" = 1 ] && ! addout="$(git -C "$d" add -u 2>&1)"; then
    printf 'git add failed (-a would stage tracked changes): %s\n' "$addout"
    rm -f "$tmp"; return 3
  fi
  if [ -n "$adds" ]; then
    IFS=$'\x1e' read -ra cmds <<< "$adds"
    for c in "${cmds[@]}"; do
      IFS=$'\x1f' read -ra a <<< "$c"
      if ! addout="$(git -C "$d" add ${a[@]+"${a[@]}"} 2>&1)"; then
        printf 'git add failed (git add %s): %s\n' "${a[*]:-}" "$addout"
        rm -f "$tmp"; return 3
      fi
    done
  fi
  (cd "$wt" && bash "$slop" --staged --justified "$review" 2>&1)
  local code=$?
  rm -f "$tmp"
  return "$code"
}

gate_commit() { # <root> <dir> <flag> <reason> <all> <adds>
  local root="$1" d="$2" flag="$3" why="$4" all="$5" adds="$6" slug review out code
  bypass "$root" "$flag" "$why" commit && return 0
  slug="$(json_field "$root" slug)" || exit 2
  slug="${slug:-unknown}"
  review=".scratch/review/$slug.md"
  [ -d "$d" ] || d="$root"
  out="$( staged_findings "$root" "$d" "$all" "$adds" "$root/$review" )"; code=$?
  [ "$code" -eq 0 ] && return 0
  blocked=1
  {
    if [ "$code" -eq 1 ]; then
      echo "feature-loop commit gate: slop findings in the lines this commit adds, so it was blocked (repo: $root)."
      printf '%s\n' "$out"
      echo "Fix: remove each finding, or list its file:line with a reason under \"## Justified\" in $review (rules: skills/fork/concern-topics/topics/code-craft.md), then commit again."
    else
      echo "feature-loop commit gate could not run slop-check (exit $code), so this commit was blocked (repo: $root):"
      printf '%s\n' "$out"
    fi
    bypass_hint "$flag"
  } >&2
}

# ---- merge

# ci_check <root> <sha> <pr> <repo>: prints why and returns 1 unless CI is green on exactly that sha.
ci_check() {
  local root="$1" sha="$2" pr="$3" repo="$4" cmd out head want
  local -a prarg=() repoarg=()
  if ! cmd="$(json_field "$root" merge_check 2>&1)"; then echo "$cmd"; return 1; fi
  if [ -n "$cmd" ]; then
    case "$pr" in *[!A-Za-z0-9._/:#@-]*) echo "the PR reference '$pr' has characters that cannot go into merge_check"; return 1 ;; esac
    cmd="${cmd//\{sha\}/$sha}"; cmd="${cmd//\{pr\}/$pr}"
    out="$(cd "$root" && bash -c "$cmd" 2>&1)" || { echo "merge_check failed: $cmd"; printf '%s\n' "$out" | tail -n 5; return 1; }
    return 0
  fi
  command -v gh >/dev/null 2>&1 || { echo "gh not found on PATH, so CI could not be checked (or set merge_check in .scratch/gates.json)"; return 1; }
  [ -n "$pr" ] && prarg=("$pr")
  [ -n "$repo" ] && repoarg=(-R "$repo")
  head="$(gh pr view ${prarg[@]+"${prarg[@]}"} ${repoarg[@]+"${repoarg[@]}"} --json headRefOid --jq .headRefOid 2>&1)" || { echo "gh pr view failed, so the PR head could not be checked: $head"; return 1; }
  head="$(printf '%s' "$head" | tr -d '[:space:]' | tr 'A-F' 'a-f')"
  want="$(printf '%s' "$sha" | tr 'A-F' 'a-f')"
  case "$head" in
    "$want"*) ;;
    *) echo "the PR head is ${head:-unknown}, not $sha: merge the head you checked, or push and recheck"; return 1 ;;
  esac
  gh pr checks ${prarg[@]+"${prarg[@]}"} ${repoarg[@]+"${repoarg[@]}"} --required >/dev/null 2>&1 && return 0
  out="$(gh pr checks ${prarg[@]+"${prarg[@]}"} ${repoarg[@]+"${repoarg[@]}"} 2>&1)" && return 0
  echo "CI is not green on $sha (gh pr checks):"
  printf '%s\n' "$out" | tail -n 8
  return 1
}

gate_merge() { # <root> <dir> <flag> <reason> <sha> <pr> <repo>
  local root="$1" d="$2" flag="$3" why="$4" sha="$5" pr="$6" repo="$7" out code ci line wt local_head want
  local -a problems=()
  bypass "$root" "$flag" "$why" merge && return 0
  [ -d "$d" ] || d="$root"
  wt="$(loop_work_tree "$d" "$root")"
  if [ -z "$sha" ]; then
    problems+=("merge exactly the head you checked: --match-head-commit <sha> (gh api: -f sha=<sha>; graphql: expectedHeadOid)")
  elif ! [[ "$sha" =~ ^[0-9a-fA-F]{7,64}$ ]]; then
    problems+=("--match-head-commit '$sha' is not a commit sha: pass the head you checked")
    sha=""
  fi
  if [ -n "$sha" ]; then
    # The gates read the local tree, so it has to be the tree being merged.
    local_head="$(git -C "$wt" rev-parse HEAD 2>/dev/null | tr 'A-F' 'a-f')"
    want="$(printf '%s' "$sha" | tr 'A-F' 'a-f')"
    case "$local_head" in
      "$want"*) ;;
      *) problems+=("the checked-out HEAD is ${local_head:-unknown}, not $sha: check out the PR head $sha first, because the gates check the local tree") ;;
    esac
  fi
  out="$(cd "$wt" && "$here/check-gates.sh" --phase merge 2>&1)"; code=$?
  if [ "$code" -eq 1 ]; then
    problems+=("the feature-loop gates are red:")
    while IFS= read -r line; do problems+=("  $line"); done < <(printf '%s\n' "$out" | grep -E '^G[1-8] red:')
  elif [ "$code" -ne 0 ]; then
    problems+=("the feature-loop gates could not run (exit $code): $(printf '%s' "$out" | head -n 1)")
  fi
  if [ -n "$sha" ]; then
    ci="$(ci_check "$root" "$sha" "$pr" "$repo")" || problems+=("$ci")
  fi
  [ "${#problems[@]}" -eq 0 ] && return 0
  blocked=1
  {
    echo "feature-loop merge gate: this merge was blocked (repo: $root)."
    printf '%s\n' "${problems[@]}"
    echo "Fix: make the gates and CI green on the head, then merge it with --match-head-commit <that sha>."
    bypass_hint "$flag"
  } >&2
}

# ---- dispatch

if [ "${match:-0}" = 1 ]; then
  if root="$(loop_root "$dir")"; then
    validate_run "$root"
    gate_push "$root" "$dir" "${gates_flag:-}" "${reason:-}"
  fi
fi

while IFS=$'\t' read -r kind adir aflag areason f1 f2 f3 f4; do
  [ -n "${kind:-}" ] || continue
  [ "$aflag" = - ] && aflag=""
  [ "$areason" = - ] && areason=""
  root="$(loop_root "$adir")" || continue
  validate_run "$root"
  case "$kind" in
    pushref)
      [ "$f1" = - ] && f1=""
      gate_push_base "$root" "$adir" "$aflag" "$areason" "$f1" ;;
    commit)
      [ "$f2" = - ] && f2=""
      gate_commit "$root" "$adir" "$aflag" "$areason" "$f1" "$f2" ;;
    merge)
      [ "$f1" = - ] && f1=""; [ "$f2" = - ] && f2=""; [ "$f3" = - ] && f3=""
      gate_merge "$root" "$adir" "$aflag" "$areason" "$f1" "$f2" "$f3" ;;
  esac
done <<< "$actions"

[ "$blocked" -eq 1 ] && exit 2
exit 0
