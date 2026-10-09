#!/usr/bin/env bash
# Tests for check-invocation.mjs. Each case is a miniature repo under fixtures/invocation/<case>/skills/.
# Run: bash scripts/test-invocation.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lint="$here/check-invocation.mjs"
fx="$here/fixtures/invocation"
fail=0
total=0

# expect <name> <root> <exit> <expected stdout violation lines, newline separated; empty for none>
expect() {
  local name="$1" root="$2" want="$3" lines="$4" out code bad="" got
  out="$(node "$lint" --root "$root" 2>/dev/null)"; code=$?
  got="$(printf '%s\n' "$out" | grep -v '^check-invocation:' || true)"
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  [ "$got" = "$lines" ] || bad="${bad:+$bad; }output differs"
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   $name"; else
    echo "FAIL $name: $bad"; echo "  want:"; printf '%s\n' "$lines" | sed 's/^/       | /'; echo "  got:"; printf '%s\n' "$got" | sed 's/^/       | /'; fail=1
  fi
}

expect "clean: model-invoked calls and a human instruction are fine" "$fx/clean" 0 ""

expect "bad-call: every spelling of a Skill tool call to a user-invoked skill" "$fx/bad-call" 1 \
"skills/eng/also-manual/SKILL.md:7: calls user-invoked skill setup via the Skill tool
skills/eng/loop/SKILL.md:6: calls user-invoked skill setup via the Skill tool
skills/eng/loop/SKILL.md:7: calls user-invoked skill setup via the Skill tool
skills/eng/loop/SKILL.md:8: calls user-invoked skill setup via the Skill tool
skills/eng/loop/SKILL.md:9: calls user-invoked skill setup via the Skill tool
skills/eng/loop/SKILL.md:10: calls user-invoked skill also-manual via the Skill tool"

expect "yaml-missing: a user-invoked skill needs allow_implicit_invocation: false" "$fx/yaml-missing" 1 \
"skills/eng/other/agents/openai.yaml:1: user-invoked skill other lacks allow_implicit_invocation: false in agents/openai.yaml
skills/eng/setup/agents/openai.yaml:1: user-invoked skill setup lacks allow_implicit_invocation: false in agents/openai.yaml"

expect "yaml-extra: a model-invoked skill must not carry the flag" "$fx/yaml-extra" 1 \
"skills/eng/domain/agents/openai.yaml:5: model-invoked skill domain has allow_implicit_invocation: false in agents/openai.yaml"

# The summary line goes to stdout on success and the count to stderr on failure; neither is a violation line.
out="$(node "$lint" --root "$fx/clean")"
total=$((total + 1))
case "$out" in "check-invocation: 4 skills, 1 user-invoked, no violations") echo "ok   summary line on success" ;; *) echo "FAIL summary line: $out"; fail=1 ;; esac

# Usage errors exit 2.
node "$lint" --bogus >/dev/null 2>&1; code=$?
total=$((total + 1)); if [ "$code" = 2 ]; then echo "ok   unknown flag exits 2"; else echo "FAIL unknown flag exited $code"; fail=1; fi
node "$lint" --root "$here/fixtures" >/dev/null 2>&1; code=$?
total=$((total + 1)); if [ "$code" = 2 ]; then echo "ok   a root without skills/ exits 2"; else echo "FAIL root without skills/ exited $code"; fail=1; fi

# The real repo must be clean.
expect "this repo: no violations" "$here/.." 0 ""

echo
if [ "$fail" -eq 0 ]; then echo "test-invocation: all $total passed"; else echo "test-invocation: failures above ($total cases)"; fi
exit "$fail"
