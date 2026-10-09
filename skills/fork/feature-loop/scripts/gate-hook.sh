#!/usr/bin/env bash
# Claude Code PreToolUse hook (matcher: Bash), registered in the plugin's hooks/hooks.json.
# Before `git push`, `gh pr create`, or a `gh api` POST to .../pulls, it runs check-gates.sh in the repo being
# pushed. Red gates block the command: exit 2, with the red gates on stderr, which Claude Code shows to the model.
# Work that is not running the feature loop (no .scratch/gates.json) is never blocked.
#
# Deliberate bypass: FEATURE_LOOP_GATES=off together with a non-empty FEATURE_LOOP_BYPASS_REASON, set in the
# environment or as assignments in the command itself. The bypass is appended to .scratch/loop-metrics.md as
# "<date> <slug> gates bypassed: <reason>". FEATURE_LOOP_GATES=off without a reason is ignored.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input="$(cat)"

# Fast path: most Bash calls cannot be a push or a PR, so do not start node for them.
printf '%s' "$input" | grep -qE 'push|pulls|PullRequest|(^|[^[:alnum:]_])pr([^[:alnum:]_]|$)' || exit 0

if ! command -v node >/dev/null 2>&1; then
  echo "feature-loop gate hook: node not found on PATH, so the gates were not checked" >&2
  exit 1 # non-blocking: shown to the user, the command runs
fi

parsed="$(printf '%s' "$input" | node "$here/hook-command.mjs")" || {
  echo "feature-loop gate hook: could not read the hook input, so the gates were not checked" >&2
  exit 1
}
{ IFS= read -r match; IFS= read -r dir; IFS= read -r gates_flag; IFS= read -r reason; } <<< "$parsed"
[ "${match:-0}" = 1 ] || exit 0

[ -n "${dir:-}" ] && [ -d "$dir" ] || dir="${CLAUDE_PROJECT_DIR:-$PWD}"
root="$dir"
if [ ! -f "$root/.scratch/gates.json" ]; then
  top="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$top" ] && [ -f "$top/.scratch/gates.json" ]; then root="$top"; fi
fi
[ -f "$root/.scratch/gates.json" ] || exit 0

trimmed_reason="$(printf '%s' "${reason:-}" | tr -d '[:space:]')"
if [ "${gates_flag:-}" = off ] && [ -n "$trimmed_reason" ]; then
  slug="$(node -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).slug; process.stdout.write(typeof s === "string" && s ? s : "unknown"); } catch { process.stdout.write("unknown"); }' "$root/.scratch/gates.json")"
  if ! printf '%s %s gates bypassed: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$slug" "$reason" >> "$root/.scratch/loop-metrics.md"; then
    echo "feature-loop gates: bypass not allowed, because it could not be recorded in $root/.scratch/loop-metrics.md" >&2
    exit 2
  fi
  exit 0
fi

out="$(cd "$root" && "$here/check-gates.sh" 2>&1)"
code=$?
[ "$code" -eq 0 ] && exit 0

{
  if [ "$code" -eq 1 ]; then
    echo "feature-loop gates are red, so this push or PR was blocked (repo: $root)."
    printf '%s\n' "$out" | grep -E '^G[1-7] red:'
  else
    echo "feature-loop gates could not run (exit $code), so this push or PR was blocked (repo: $root):"
    printf '%s\n' "$out"
  fi
  if [ "${gates_flag:-}" = off ]; then
    echo "FEATURE_LOOP_GATES=off was set without FEATURE_LOOP_BYPASS_REASON, so the gates ran anyway."
  fi
  echo "Fix: produce or fix each named file (see skills/fork/feature-loop/gates.md), check with check-gates.sh, then retry."
  echo "Bypass on purpose (recorded in .scratch/loop-metrics.md): FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='<why>' <same command>"
} >&2
exit 2
