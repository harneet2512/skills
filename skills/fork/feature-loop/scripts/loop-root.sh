#!/usr/bin/env bash
# Sourced by gate-hook.sh and check-gates.sh: where is the feature loop's run file?
#
#   loop_root <dir>   prints the directory that holds .scratch/gates.json for <dir> (default: $CLAUDE_PROJECT_DIR, else
#                     $PWD) and returns 0 when the loop is active, 1 when there is none, 2 when it is closed
#                     (gates.json has "status": "closed"; the path is printed then too).
#
# The root is, in order: <dir> itself, the git top level of <dir>, the main worktree of the repository <dir> belongs
# to. The last one matters because .scratch/ is untracked, so `git worktree add` does not copy it: a builder working
# in a linked worktree still answers to the loop of the main worktree.
#
# Pure shell, no node: the hooks use it to decide whether to fail closed when node is missing, and a closed loop is
# read with grep for the same reason.

# loop_run_closed <gates.json>: does the run file say "status": "closed"?
loop_run_closed() {
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"closed"' "$1" 2>/dev/null
}

# loop_main_worktree <dir>: the top level of the main worktree of <dir>'s repository, or nothing.
loop_main_worktree() {
  local common
  common="$(cd "$1" 2>/dev/null && git rev-parse --git-common-dir 2>/dev/null)" || return 1
  [ -n "$common" ] || return 1
  common="$(cd "$1" && cd "$common" 2>/dev/null && pwd)" || return 1
  case "$common" in
    */.git) printf '%s' "${common%/.git}" ;;
    *) return 1 ;;
  esac
}

# loop_work_tree <dir> <fallback>: the git top level of <dir> (the worktree a command runs in), else <fallback>.
loop_work_tree() {
  local top
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ]; then printf '%s' "$top"; else printf '%s' "$2"; fi
}

loop_root() {
  local d="${1:-}" top main cand
  { [ -n "$d" ] && [ -d "$d" ]; } || d="${CLAUDE_PROJECT_DIR:-$PWD}"
  top="$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || true)"
  main="$(loop_main_worktree "$d" || true)"
  for cand in "$d" "$top" "$main"; do
    { [ -n "$cand" ] && [ -f "$cand/.scratch/gates.json" ]; } || continue
    printf '%s' "$cand"
    if loop_run_closed "$cand/.scratch/gates.json"; then return 2; fi
    return 0
  done
  return 1
}
