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

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

gates=()
phase=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --phase)
      [ "$#" -ge 2 ] || { echo "check-gates: --phase needs build, merge or close" >&2; exit 2; }
      phase="$2"; shift 2
      case "$phase" in build|merge|close) ;; *) echo "check-gates: unknown phase: $phase (expected build, merge or close)" >&2; exit 2 ;; esac ;;
    [Gg][1-8]) gates+=("G${1:1}"); shift ;;
    *) echo "check-gates: unknown argument: $1 (expected gate IDs G1 to G8, or --phase build|merge|close)" >&2; usage >&2; exit 2 ;;
  esac
done

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

# The code under check is the worktree this runs in; the run file and the .scratch/ notes are the loop root's.
work="$(loop_work_tree "$PWD" "$root")"

# "Newer than the last commit" compares file mtimes with this. A repo with no commits yet counts as time 0.
last="$(git -C "$work" log -1 --format=%ct 2>/dev/null || true)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac

exec node "$here/check-gates.mjs" --root "$root" --work "$work" --last-commit "$last" ${phase:+--phase "$phase"} \
  --slop "$here/../../concern-topics/scripts/slop-check.sh" ${gates[@]+"${gates[@]}"}
