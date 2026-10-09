#!/usr/bin/env bash
# Check the feature-loop gates (G1 to G7 in ../gates.md) for the feature named in .scratch/gates.json.
#
# Usage (run from the target repo's root):
#   check-gates.sh            every gate that applies to the feature's size
#   check-gates.sh G2 G6      only these gates
#
# Prints one line per gate ("G2 green", "G2 red: <what is missing> (<file>)" or "G4 n/a: <why>"), then a summary.
# Exit: 0 all green, 1 any red, 2 usage error or invalid .scratch/gates.json.
# Without .scratch/gates.json the feature loop is not running: it says so and exits 0.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

gates=()
for a in "$@"; do
  case "$a" in
    -h|--help) usage; exit 0 ;;
    [Gg][1-7]) gates+=("G${a:1}") ;;
    *) echo "check-gates: unknown argument: $a (expected gate IDs G1 to G7)" >&2; usage >&2; exit 2 ;;
  esac
done

# The repo root is the current directory; from a subdirectory, fall back to the git top level.
root="$PWD"
if [ ! -f "$root/.scratch/gates.json" ]; then
  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ] && [ -f "$top/.scratch/gates.json" ]; then root="$top"; fi
fi
if [ ! -f "$root/.scratch/gates.json" ]; then
  echo "gates: not running the feature loop (no .scratch/gates.json)"
  exit 0
fi

command -v node >/dev/null 2>&1 || { echo "check-gates: node not found on PATH (Node 22 is required)" >&2; exit 2; }

# "Newer than the last commit" compares file mtimes with this. A repo with no commits yet counts as time 0.
last="$(git -C "$root" log -1 --format=%ct 2>/dev/null || true)"
case "$last" in ''|*[!0-9]*) last=0 ;; esac

exec node "$here/check-gates.mjs" --root "$root" --last-commit "$last" \
  --slop "$here/../../concern-topics/scripts/slop-check.sh" ${gates[@]+"${gates[@]}"}
