#!/usr/bin/env bash
# Tests for check-gates.sh and gate-hook.sh. Each case builds a throwaway git repo in a temp dir from the files in
# fixtures/gates/, runs the script, and checks the exit code and the expected line.
# Run: skills/fork/feature-loop/scripts/test-gates.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fx="$here/fixtures/gates"
check="$here/check-gates.sh"
hook="$here/gate-hook.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unset FEATURE_LOOP_GATES FEATURE_LOOP_BYPASS_REASON CLAUDE_PROJECT_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
fail=0
total=0
SLUG=reply-options

# ---- repo builders

# A repo with a main branch and a feature branch that adds clean code. Prints its path.
new_repo() {
  local d="$work/$1"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q -b main
    printf '.scratch/\n' > .gitignore
    printf '# demo\n' > README.md
    git add -A && git commit -q -m base
    git checkout -q -b feature
    mkdir -p src && cp "$fx/src/clean.js" src/clean.js
    git add -A && git commit -q -m feature
  ) || { echo "FAIL could not build repo $1"; exit 1; }
  printf '%s' "$d"
}

last_ct() { git -C "$1" log -1 --format=%ct; }
# Put a file's mtime clearly after (newer) or before (older) the last commit.
newer() { touch -d "@$(( $(last_ct "$1") + 5 ))" "$1/$2"; }
older() { touch -d "@$(( $(last_ct "$1") - 100 ))" "$1/$2"; }

gates_json() { mkdir -p "$1/.scratch"; printf '{ "slug": "%s", "size": "%s", "base": "main" }\n' "$SLUG" "$2" > "$1/.scratch/gates.json"; }
put() { mkdir -p "$(dirname "$1/$3")"; cp "$fx/$2" "$1/$3"; }
put_live() { put "$1" "$2" ".scratch/live/${3:-run1}/report.json"; newer "$1" ".scratch/live/${3:-run1}/report.json"; }
put_evals() { put "$1" "$2" ".scratch/evals/$SLUG/results.json"; newer "$1" ".scratch/evals/$SLUG/results.json"; }

# Every file a normal run needs, all green.
green_normal() {
  local d="$1" size="${2:-normal}"
  gates_json "$d" "$size"
  put "$d" shape.md ".scratch/shape/$SLUG.md"
  put "$d" envelope.md ".scratch/envelope/$SLUG.md"
  put_live "$d" report-pass.json
  put "$d" review.md ".scratch/review/$SLUG.md"
  put "$d" metrics.md .scratch/loop-metrics.md
}

# Commit the slop sample on the feature branch.
add_slop() { mkdir -p "$1/src" && cp "$fx/src/slop.js" "$1/src/slop.js" && git -C "$1" add -A && git -C "$1" commit -q -m slop; }

# ---- assertions

# expect <name> <dir> <exit> <needle> <red lines> [gate args...]
# needle: a fixed string the output must contain ("" for none). red lines: how many "Gn red:" lines, or "-" to skip.
expect() {
  local name="$1" dir="$2" want="$3" needle="$4" reds="$5"; shift 5
  local out code got_reds bad=""
  out="$(cd "$dir" && "$check" "$@" 2>&1)"; code=$?
  got_reds="$(printf '%s\n' "$out" | grep -cE '^G[1-7] red:')"
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$out" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  if [ "$reds" != - ] && [ "$got_reds" != "$reds" ]; then bad="${bad:+$bad; }red lines $got_reds, want $reds"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   $name"; else echo "FAIL $name: $bad"; printf '%s\n' "$out" | sed 's/^/       | /'; fail=1; fi
}

# hook_case <name> <cwd> <command> <exit> <stderr needle> [VAR=value...]
hook_case() {
  local name="$1" cwd="$2" cmd="$3" want="$4" needle="$5"; shift 5
  local payload err code bad=""
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", transcript_path: "/dev/null", cwd: process.argv[1], hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: process.argv[2], description: "test" } }))' "$cwd" "$cmd")"
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$err" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook: $name"; else echo "FAIL hook: $name: $bad"; printf '%s\n' "$err" | sed 's/^/       | /'; fail=1; fi
}

pass_if() { # pass_if <name> <condition command...>
  local name="$1"; shift
  total=$((total + 1))
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fail=1; fi
}

# ---- check-gates.sh

d=$(new_repo none)
expect "no gates.json: not running" "$d" 0 "gates: not running the feature loop (no .scratch/gates.json)" 0

d=$(new_repo small)
gates_json "$d" small
put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "small: all green" "$d" 0 "gates: green for reply-options (size small): 2 green, 0 red, 5 n/a" 0
expect "small: G1 is n/a" "$d" 0 "G1 n/a: applies to normal and large only, size is small" 0

d=$(new_repo normal); green_normal "$d"
expect "normal: all green" "$d" 0 "gates: green for reply-options (size normal): 6 green, 0 red, 1 n/a" 0
expect "normal: G4 n/a without llm or retrieval" "$d" 0 "G4 n/a: envelope Packs names neither llm nor retrieval" 0
mkdir -p "$d/src/deep"
expect "normal: run from a subdirectory" "$d/src/deep" 0 "gates: green" 0

d=$(new_repo large-llm); green_normal "$d" large
put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-ok.json
expect "large with llm pack and passing evals: all green" "$d" 0 "G4 green" 0

d=$(new_repo no-llm-words); green_normal "$d"
put "$d" envelope-no-llm-words.md ".scratch/envelope/$SLUG.md"
expect "Packs saying 'no llm, no retrieval' needs no evals" "$d" 0 "G4 n/a" 0

d=$(new_repo g1-missing); green_normal "$d"; rm "$d/.scratch/shape/$SLUG.md"
expect "G1 red: shape missing (G3 cannot check coverage either)" "$d" 1 "G1 red: shape file missing (.scratch/shape/reply-options.md)" 2
expect "G1 red: shape missing, filtered to G1" "$d" 1 "G1 red: shape file missing" 1 G1

d=$(new_repo g1-no-ids); green_normal "$d"; put "$d" shape-no-ids.md ".scratch/shape/$SLUG.md"
expect "G1 red: shape without case IDs" "$d" 1 "G1 red: no journey case ID like J3.two-actors (.scratch/shape/reply-options.md)" 1

d=$(new_repo g2-missing); green_normal "$d"; rm "$d/.scratch/envelope/$SLUG.md"
expect "G2 red: envelope missing (G4 fails closed too)" "$d" 1 "G2 red: envelope file missing (.scratch/envelope/reply-options.md)" 2

d=$(new_repo g2-proof); green_normal "$d"; put "$d" envelope-empty-proof.md ".scratch/envelope/$SLUG.md"
expect "G2 red: Live row with empty Proof" "$d" 1 "G2 red: Live rows not filled: API-03 (Proof empty) (.scratch/envelope/reply-options.md)" 1

d=$(new_repo g2-tbd); green_normal "$d"; put "$d" envelope-tbd.md ".scratch/envelope/$SLUG.md"
expect "G2 red: Live row with TBD" "$d" 1 "G2 red: Live rows not filled: OUT-01 (Mechanism TBD)" 1

d=$(new_repo g2-packs); green_normal "$d"
sed 's/^\*\*Packs:\*\*.*$/**Packs:**/' "$fx/envelope.md" > "$d/.scratch/envelope/$SLUG.md"
expect "G2 red: empty Packs line" "$d" 1 "G2 red: **Packs:** line is empty" 1

# The Live table with its header and separator but no rows.
empty_live() { grep -vE '^\s*\|?\s*(OUT-01|API-03)\b' "$fx/envelope.md" > "$1/.scratch/envelope/$SLUG.md"; }

d=$(new_repo g2-empty-normal); green_normal "$d"; empty_live "$d"
expect "G2 red: empty Live table on a normal change" "$d" 1 "G2 red: Live table empty on a normal or large change (.scratch/envelope/reply-options.md)" 1

d=$(new_repo g2-empty-large); green_normal "$d" large; empty_live "$d"
expect "G2 red: empty Live table on a large change" "$d" 1 "G2 red: Live table empty on a normal or large change" 1

d=$(new_repo g2-empty-small); gates_json "$d" small; mkdir -p "$d/.scratch/envelope"; empty_live "$d"
expect "G2 green: empty Live table on a small change" "$d" 0 "G2 green" 0

d=$(new_repo g3-none); green_normal "$d"; rm -r "$d/.scratch/live"
expect "G3 red: no live run" "$d" 1 "G3 red: no live run (.scratch/live/<run>/report.json)" 1

d=$(new_repo g3-fail); green_normal "$d"; put_live "$d" report-fail.json
expect "G3 red: failed scenario" "$d" 1 "G3 red: 1 scenario not passing: two reviewers race [fail] (.scratch/live/run1/report.json)" 1

d=$(new_repo g3-old); green_normal "$d"; older "$d" .scratch/live/run1/report.json
expect "G3 red: live report older than the last commit" "$d" 1 "G3 red: newest live run is older than the last commit, rerun live-verify" 1

d=$(new_repo g3-case); green_normal "$d"; put_live "$d" report-missing-case.json
expect "G3 red: journey case missing from report" "$d" 1 "G3 red: journey cases in no scenario: J2.two-actors" 1

d=$(new_repo g3-newest); green_normal "$d"
put "$d" report-fail.json .scratch/live/run0/report.json; touch -d "@$(( $(last_ct "$d") + 2 ))" "$d/.scratch/live/run0/report.json"
expect "G3 green: an older failed run is ignored, the newest passes" "$d" 0 "G3 green" 0

d=$(new_repo g4-missing); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 red: llm pack without eval results" "$d" 1 "G4 red: eval results missing (.scratch/evals/reply-options/results.json)" 1

d=$(new_repo g4-bad); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-bad.json
expect "G4 red: eval gate ok:false" "$d" 1 "G4 red: eval gates not ok: pass.lo>=0.8 (.scratch/evals/reply-options/results.json)" 1

d=$(new_repo g4-old); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-ok.json
older "$d" ".scratch/evals/$SLUG/results.json"
expect "G4 red: eval results older than the last commit" "$d" 1 "G4 red: eval results are older than the last commit" 1

d=$(new_repo g4-small); gates_json "$d" small; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 applies to small work with the llm pack" "$d" 1 "G4 red: eval results missing" 1

d=$(new_repo g5); green_normal "$d"; put "$d" review-open-high.md ".scratch/review/$SLUG.md"
expect "G5 red: open CONFIRMED HIGH finding" "$d" 1 "G5 red: open CONFIRMED finding: F1 HIGH (.scratch/review/reply-options.md)" 1

d=$(new_repo g5-missing); green_normal "$d"; rm "$d/.scratch/review/$SLUG.md"
expect "G5 red: review missing" "$d" 1 "G5 red: review file missing" 1 G5

d=$(new_repo g6-open); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
expect "G6 red: slop findings not justified" "$d" 1 "G6 red: slop findings not justified under ## Justified: CRAFT-06.todo src/slop.js:2, CRAFT-06.debug-output src/slop.js:3 (.scratch/review/reply-options.md)" 1

d=$(new_repo g6-ok); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
put "$d" review-justified.md ".scratch/review/$SLUG.md"
expect "G6 green: every finding justified with a reason" "$d" 0 "G6 green" 0

d=$(new_repo g6-noreason); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
put "$d" review-justified-no-reason.md ".scratch/review/$SLUG.md"
expect "G6 red: a justification without a reason does not count" "$d" 1 "not justified under ## Justified: CRAFT-06.todo src/slop.js:2 (" 1

d=$(new_repo g6-uncommitted); green_normal "$d"; cp "$fx/src/slop.js" "$d/src/slop.js"
expect "G6 red: uncommitted slop counts too" "$d" 1 "CRAFT-06.todo src/slop.js:2" 1 G6

d=$(new_repo g7); green_normal "$d"; printf '# Loop metrics\n\n2026-10-01 other-feature: 1 finding\n' > "$d/.scratch/loop-metrics.md"
expect "G7 red: no metrics line" "$d" 1 "G7 red: no metrics line containing reply-options (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-bypass); green_normal "$d"; put "$d" metrics-bypass-only.md .scratch/loop-metrics.md
expect "G7 red: a bypass record is not a metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1

# Gate-name filtering and usage.
d=$(new_repo filter); green_normal "$d"; rm "$d/.scratch/shape/$SLUG.md"
expect "filter: G2 G6 ignore a red G1" "$d" 0 "gates: green for reply-options (size normal): 2 green, 0 red, 0 n/a" 0 G2 G6
out="$(cd "$d" && "$check" G2 G6)"
pass_if "filter: prints only the named gates" test "$(printf '%s\n' "$out" | grep -cE '^G[1-7] ')" = 2
expect "filter: lowercase g1 accepted" "$d" 1 "G1 red: shape file missing" 1 g1
expect "usage: unknown gate G9" "$d" 2 "unknown argument: G9" 0 G9
expect "usage: unknown flag" "$d" 2 "unknown argument: --bogus" 0 --bogus
expect "usage: --help" "$d" 0 "Usage (run from the target repo's root)" 0 --help

d=$(new_repo bad-size); gates_json "$d" huge
expect "invalid gates.json: bad size" "$d" 2 'size" must be small, normal or large' 0
d=$(new_repo bad-slug); mkdir -p "$d/.scratch"; printf '{ "slug": "../etc", "size": "normal", "base": "main" }\n' > "$d/.scratch/gates.json"
expect "invalid gates.json: slug with a path" "$d" 2 '"slug" must be a plain name' 0
d=$(new_repo bad-json); mkdir -p "$d/.scratch"; printf '{ nope' > "$d/.scratch/gates.json"
expect "invalid gates.json: not JSON" "$d" 2 "invalid .scratch/gates.json" 0

# ---- gate-hook.sh

red_repo=$(new_repo hook-red); green_normal "$red_repo"; rm "$red_repo/.scratch/shape/$SLUG.md"
green_repo=$(new_repo hook-green); green_normal "$green_repo"
plain_repo=$(new_repo hook-plain)
outside="$work/outside"; mkdir -p "$outside"

hook_case "unrelated command passes" "$red_repo" "ls -la src" 0 ""
hook_case "commit message mentioning push passes" "$red_repo" 'git commit -m "push the fix later"' 0 ""
hook_case "git push blocked when red" "$red_repo" "git push -u origin feature" 2 "G1 red: shape file missing"
hook_case "block message says how to bypass" "$red_repo" "git push" 2 "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON="
hook_case "git -C <repo> push from elsewhere blocked" "$outside" "git -C $red_repo push" 2 "G1 red"
hook_case "cd <repo> && git push blocked" "$outside" "cd $red_repo && git push origin HEAD" 2 "G1 red"
hook_case "bash -c 'git push' blocked" "$red_repo" "bash -c 'git push origin feature'" 2 "G1 red"
hook_case "git push --dry-run passes" "$red_repo" "git push --dry-run" 0 ""
hook_case "gh pr create blocked when red" "$red_repo" 'gh pr create --title "x" --body "y"' 2 "G1 red"
hook_case "gh api POST to pulls blocked when red" "$red_repo" "gh api repos/o/r/pulls -f title=x -f head=feature -f base=main" 2 "G1 red"
hook_case "gh api -X POST /pulls blocked when red" "$red_repo" "gh api -X POST /repos/o/r/pulls --input body.json" 2 "G1 red"
hook_case "gh api GET pulls passes" "$red_repo" "gh api repos/o/r/pulls" 0 ""
hook_case "gh api POST to a PR comment passes" "$red_repo" "gh api repos/o/r/pulls/3/comments -f body=hi" 0 ""
hook_case "git push allowed when green" "$green_repo" "git push origin feature" 0 ""
hook_case "git push allowed without gates.json" "$plain_repo" "git push origin feature" 0 ""
hook_case "bypass without reason still blocked" "$red_repo" "git push" 2 "without FEATURE_LOOP_BYPASS_REASON" FEATURE_LOOP_GATES=off
hook_case "bypass with blank reason still blocked" "$red_repo" "git push" 2 "G1 red" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=   "
hook_case "bypass with reason allowed" "$red_repo" "git push" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=demo deadline"
pass_if "bypass logged in loop-metrics.md" grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z reply-options gates bypassed: demo deadline$" "$red_repo/.scratch/loop-metrics.md"
hook_case "inline bypass in the command allowed" "$red_repo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='CI is down, approved by lead' git push" 0 ""
pass_if "inline bypass logged" grep -qF "reply-options gates bypassed: CI is down, approved by lead" "$red_repo/.scratch/loop-metrics.md"
hook_case "inline off without reason still blocked" "$red_repo" "FEATURE_LOOP_GATES=off git push" 2 "without FEATURE_LOOP_BYPASS_REASON"
payload='{"tool_name":"Write","cwd":"'"$red_repo"'","tool_input":{"file_path":"x","content":"git push"}}'
code=0; printf '%s' "$payload" | bash "$hook" >/dev/null 2>&1 || code=$?
pass_if "hook: a Write tool payload is never gated" test "$code" = 0

echo
if [ "$fail" -eq 0 ]; then echo "test-gates: all $total passed"; else echo "test-gates: failures above ($total cases)"; fi
exit "$fail"
