#!/usr/bin/env bash
# Check the feature-loop gates (G1 to G8 in ../gates.md) for the feature named in .scratch/gates.json.
#
# Usage (run from the target repo's root):
#   check-gates.sh                    every gate that applies to the feature's size (the close phase)
#   check-gates.sh G2 G6              only these gates
#   check-gates.sh --phase build      G1 G2 G8: what must hold before the first push or PR (during Build)
#   check-gates.sh --phase merge      G1 to G6 and G8: what must hold before the merge
#   check-gates.sh --phase close      every gate, G7 (the metrics line, written after the merge) included
#   (a phase and gate IDs together check the gates that are in both)
#   check-gates.sh --plan [FILE]      only the approved plan (default: the newest .scratch/plan/*.md): lists each missing or
#                                     empty section and each Changed line without a reason; needs no gates.json
#   check-gates.sh --timebox          only the time box: "demo_by" in gates.json against the newest passing live
#                                     run; exit 1 when it is overdue (run it at every stage boundary)
#
# Prints one line per gate ("G2 green", "G2 red: <what is missing> (<file>)" or "G4 n/a: <why>"), then a summary.
# Exit: 0 all green, 1 any red, 2 usage error or invalid .scratch/gates.json.
# Without .scratch/gates.json the feature loop is not running: it says so and exits 0; so it does for a loop whose
# gates.json says "status": "closed". Run from a linked git worktree, the run file is the main worktree's, and the
# code checked (G6, the last commit time) is the worktree's.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=loop-root.sh
. "$here/loop-root.sh"

usage() { sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

gates=()
phase=""
timebox=""
plan=""; planfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --phase)
      [ "$#" -ge 2 ] || { echo "check-gates: --phase needs build, merge or close" >&2; exit 2; }
      phase="$2"; shift 2
      case "$phase" in build|merge|close) ;; *) echo "check-gates: unknown phase: $phase (expected build, merge or close)" >&2; exit 2 ;; esac ;;
    --timebox) timebox=1; shift ;;
    --plan)
      plan=1; shift
      case "${1:-}" in ""|-*|[Gg][1-8]) ;; *) planfile="$1"; shift ;; esac ;;
    [Gg][1-8]) gates+=("G${1:1}"); shift ;;
    *) echo "check-gates: unknown argument: $1 (expected gate IDs G1 to G8, --phase build|merge|close, or --timebox)" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -n "$plan" ]; then
  if [ -n "$phase" ] || [ -n "$timebox" ] || [ "${#gates[@]}" -gt 0 ]; then
    echo "check-gates: --plan checks only the approved plan; run it without --phase, --timebox or gate IDs" >&2; exit 2
  fi
  command -v node >/dev/null 2>&1 || { echo "check-gates: node not found on PATH (Node 22 is required)" >&2; exit 2; }
  # The plan is written before the run file exists, so the root is the loop root when there is one, else the repo.
  proot="$(loop_root "$PWD" || true)"
  [ -n "$proot" ] || proot="$(loop_work_tree "$PWD" "$PWD")"
  exec node "$here/check-gates.mjs" --root "$proot" --plan-check "$planfile"
fi

rc=0
root="$(loop_root "$PWD")" || rc=$?
if [ "$rc" -eq 2 ]; then
  echo "gates: loop closed (.scratch/gates.json says \"status\": \"closed\"), nothing to check"
  exit 0
fi
if [ "$rc" -ne 0 ]; then
  echo "gates: not running the feature loop (no .scratch/gates.json)"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "check-gates: node not found on PATH (Node 22 is required)" >&2; exit 2; }

if [ -n "$timebox" ]; then
  if [ -n "$phase" ] || [ "${#gates[@]}" -gt 0 ]; then
    echo "check-gates: --timebox checks only the time box; run it without --phase or gate IDs" >&2; exit 2
  fi
  exec node "$here/check-gates.mjs" --root "$root" --timebox
fi

# The code under check is the worktree this runs in; the run file and the .scratch/ notes are the loop root's.
work="$(loop_work_tree "$PWD" "$root")"

# "Newer than the last commit" compares file mtimes with this. A repo with no commits yet counts as time 0.
last="$(git -C "$work" log -1 --format=%ct 2>/dev/null || true)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac

exec node "$here/check-gates.mjs" --root "$root" --work "$work" --last-commit "$last" ${phase:+--phase "$phase"} \
  --slop "$here/../../concern-topics/scripts/slop-check.sh" ${gates[@]+"${gates[@]}"}
