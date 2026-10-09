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
  got_reds="$(printf '%s\n' "$out" | grep -cE '^G[1-8] red:')"
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
expect "small: all green" "$d" 0 "gates: green for reply-options (size small): 2 green, 0 red, 6 n/a" 0
expect "small: G1 is n/a" "$d" 0 "G1 n/a: applies to normal and large only, size is small" 0

d=$(new_repo normal); green_normal "$d"
expect "normal: all green" "$d" 0 "gates: green for reply-options (size normal): 6 green, 0 red, 2 n/a" 0
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

# G7 floor: CONFIRMED findings need escapes=<n> floors=<m> on the metrics line, with m >= n.
d=$(new_repo g7-nofloor); green_normal "$d"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 red: CONFIRMED findings but no escapes/floors" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m> (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-escapes-only); green_normal "$d"; put "$d" metrics-escapes-only.md .scratch/loop-metrics.md
expect "G7 red: escapes without floors" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m>" 1

d=$(new_repo g7-low); green_normal "$d"; put "$d" metrics-floor-low.md .scratch/loop-metrics.md
expect "G7 red: floors below escapes" "$d" 1 "G7 red: floors=1 is below escapes=2, so an escape raised no floor (a check, pack item, scenario or eval case) (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-floor-ok); green_normal "$d"; put "$d" metrics-floor.md .scratch/loop-metrics.md
expect "G7 green: floors above escapes" "$d" 0 "G7 green" 0

d=$(new_repo g7-nothing-confirmed); green_normal "$d"; put "$d" review-plausible.md ".scratch/review/$SLUG.md"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 green: no CONFIRMED finding needs no floor" "$d" 0 "G7 green" 0 G7

d=$(new_repo g7-no-review); green_normal "$d"; rm "$d/.scratch/review/$SLUG.md"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 green: no review file, today's rule only" "$d" 0 "G7 green" 0 G7

# G8 ledger: applies to every size once .scratch/loop-status.md exists.
d=$(new_repo g8-na); green_normal "$d"
expect "G8 n/a: no loop-status.md" "$d" 0 "G8 n/a: no .scratch/loop-status.md" 0 G8

d=$(new_repo g8-ok); green_normal "$d"; put "$d" loop-status.md .scratch/loop-status.md
expect "G8 green: done rows carry measured: or inferred: evidence" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-running); green_normal "$d"; put "$d" loop-status-running.md .scratch/loop-status.md
expect "G8 green: a running row is the Stop hook's business" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-columns); green_normal "$d"; put "$d" loop-status-columns.md .scratch/loop-status.md
expect "G8 green: columns found by name, any order, any case" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-noevidence); green_normal "$d"; put "$d" loop-status-no-evidence.md .scratch/loop-status.md
expect "G8 red: done without evidence or with unmarked evidence" "$d" 1 'G8 red: done stage without evidence (measured:, inferred: or assumed:): 1 shape (empty), 2 behavioral-envelope ("looks fine to me") (.scratch/loop-status.md)' 1 G8

d=$(new_repo g8-assumed); green_normal "$d"; put "$d" loop-status-assumed.md .scratch/loop-status.md
expect "G8 red: a stage cannot be done on an assumption" "$d" 1 "G8 red: a stage cannot be done on an assumption: 2 live-verify (.scratch/loop-status.md)" 1 G8

d=$(new_repo g8-small); gates_json "$d" small; put "$d" loop-status-no-evidence.md .scratch/loop-status.md
expect "G8 applies to small work too" "$d" 1 "G8 red: done stage without evidence" 1 G8

d=$(new_repo g8-notable); green_normal "$d"; printf '# Loop status\n\nnothing yet\n' > "$d/.scratch/loop-status.md"
expect "G8 red: loop-status.md without a stage table" "$d" 1 "G8 red: no stage table with Status and Evidence columns (.scratch/loop-status.md)" 1 G8

d=$(new_repo g8-all); green_normal "$d"; put "$d" loop-status.md .scratch/loop-status.md
expect "G8 counted in the summary" "$d" 0 "gates: green for reply-options (size normal): 7 green, 0 red, 1 n/a" 0

# Gate-name filtering and usage.
d=$(new_repo filter); green_normal "$d"; rm "$d/.scratch/shape/$SLUG.md"
expect "filter: G2 G6 ignore a red G1" "$d" 0 "gates: green for reply-options (size normal): 2 green, 0 red, 0 n/a" 0 G2 G6
out="$(cd "$d" && "$check" G2 G6)"
pass_if "filter: prints only the named gates" test "$(printf '%s\n' "$out" | grep -cE '^G[1-8] ')" = 2
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

# ---- gate-hook.sh: commit gate

# A repo on the feature branch with gates.json and src/slop.js staged (not committed).
staged_repo() { local d; d=$(new_repo "$1"); gates_json "$d" normal; cp "$fx/src/slop.js" "$d/src/slop.js"; git -C "$d" add src/slop.js; printf '%s' "$d"; }
no_staged() { [ -z "$(git -C "$1" diff --cached --name-only)" ]; }

crepo=$(staged_repo commit-staged)
hook_case "commit blocked when the staged lines are slop" "$crepo" 'git commit -m "add slop"' 2 "src/slop.js:2"
hook_case "commit block names the fix and the bypass" "$crepo" 'git commit -m x' 2 'Fix: remove each finding, or list its file:line with a reason under "## Justified" in .scratch/review/reply-options.md'
hook_case "commit block says how to bypass" "$crepo" 'git commit -m x' 2 "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON="
hook_case "git -C <repo> commit from elsewhere blocked" "$outside" "git -C $crepo commit -m x" 2 "src/slop.js:2"
hook_case "cd <repo> && git commit blocked" "$outside" "cd $crepo && git commit -m x" 2 "src/slop.js:2"
hook_case "commit chained after another command blocked" "$crepo" "echo hi; git commit -m x && echo done" 2 "src/slop.js:2"
hook_case "git commit --dry-run passes" "$crepo" "git commit --dry-run" 0 ""
hook_case "git status passes" "$crepo" "git status" 0 ""
pass_if "commit hook leaves the real index alone" test "$(git -C "$crepo" diff --cached --name-only)" = "src/slop.js"

jrepo=$(staged_repo commit-justified); put "$jrepo" review-justified.md ".scratch/review/$SLUG.md"
hook_case "commit allowed when every finding is justified with a reason" "$jrepo" "git commit -m x" 0 ""
nrepo=$(staged_repo commit-noreason); put "$nrepo" review-justified-no-reason.md ".scratch/review/$SLUG.md"
hook_case "commit blocked when a justification has no reason" "$nrepo" "git commit -m x" 2 "src/slop.js"

prepo=$(new_repo commit-plain); cp "$fx/src/slop.js" "$prepo/src/slop.js"; git -C "$prepo" add src/slop.js
hook_case "commit never blocked without gates.json" "$prepo" "git commit -m x" 0 ""

urepo=$(new_repo commit-unstaged); gates_json "$urepo" normal; cp "$fx/src/slop.js" "$urepo/src/slop.js"
hook_case "untracked slop is not part of a plain commit" "$urepo" "git commit -m x" 0 ""
hook_case "git add -A && git commit sees what the add will stage" "$urepo" 'git add -A && git commit -m "x"' 2 "src/slop.js:2"
hook_case "git add <clean file> && git commit passes" "$urepo" 'git add src/clean.js && git commit -m "x"' 0 ""
hook_case "git add <slop file>; git commit blocked" "$urepo" 'git add src/slop.js; git commit -m "x"' 2 "src/slop.js:2"
pass_if "chained add leaves the real index alone" no_staged "$urepo"

arepo=$(new_repo commit-all); gates_json "$arepo" normal
printf 'export const f = () => { console.log("hi"); };\n' >> "$arepo/src/clean.js"
hook_case "commit without -a ignores unstaged edits" "$arepo" "git commit -m x" 0 ""
hook_case "git commit -am sees tracked edits" "$arepo" 'git commit -am "x"' 2 "src/clean.js"
hook_case "git commit -a -m sees tracked edits" "$arepo" 'git commit -a -m "x"' 2 "src/clean.js"
hook_case "git commit --all sees tracked edits" "$arepo" 'git commit --all -m "x"' 2 "src/clean.js"
hook_case "a -a inside the message is not the flag" "$arepo" 'git commit -m "-a"' 0 ""
pass_if "commit -a leaves the real index alone" no_staged "$arepo"

hook_case "commit bypass without reason still blocked" "$crepo" "git commit -m x" 2 "without FEATURE_LOOP_BYPASS_REASON" FEATURE_LOOP_GATES=off
hook_case "commit bypass with reason allowed" "$crepo" "git commit -m x" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=spike branch"
pass_if "commit bypass logged" grep -qE "^[0-9T:Z-]+ reply-options gates bypassed: spike branch \(commit\)$" "$crepo/.scratch/loop-metrics.md"
hook_case "inline commit bypass allowed" "$crepo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='wip checkpoint' git commit -m x" 0 ""
hook_case "a bypass on the commit does not cover a later push" "$red_repo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=cp git commit -m x && git push" 2 "G1 red"

# ---- gate-hook.sh: merge gate

bin="$work/bin"; mkdir -p "$bin"
cat > "$bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stand-in for gh: FAKE_GH_HEAD is the PR head, FAKE_GH_REQUIRED / FAKE_GH_CHECKS the exit codes of
# `gh pr checks --required` / `gh pr checks`, FAKE_GH_VIEW_FAIL makes `gh pr view` fail, FAKE_GH_LOG records calls.
[ -n "${FAKE_GH_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") if [ -n "${FAKE_GH_VIEW_FAIL:-}" ]; then echo "HTTP 502" >&2; exit 1; fi; echo "${FAKE_GH_HEAD:-}"; exit 0 ;;
  "pr checks")
    for a in "$@"; do if [ "$a" = --required ]; then exit "${FAKE_GH_REQUIRED:-1}"; fi; done
    echo "build	fail	1m"; exit "${FAKE_GH_CHECKS:-1}" ;;
esac
exit 1
STUB
chmod +x "$bin/gh"
gh_env=("PATH=$bin:$PATH")

mrepo=$(new_repo merge-green); green_normal "$mrepo"
sha=$(git -C "$mrepo" rev-parse HEAD); short=${sha:0:9}
mlog="$work/gh.log"

hook_case "merge without --match-head-commit blocked" "$mrepo" "gh pr merge 5 --squash" 2 "merge exactly the head you checked: --match-head-commit <sha>" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge with sha, green gates and green CI allowed" "$mrepo" "gh pr merge 5 --squash --match-head-commit $sha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge with --match-head-commit=<sha> allowed" "$mrepo" "gh pr merge 5 --match-head-commit=$sha --squash" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge with an abbreviated sha matching the head allowed" "$mrepo" "gh pr merge 5 --match-head-commit $short" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge blocked when the PR head is not the sha" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "the PR head is deadbeef, not $sha" "${gh_env[@]}" FAKE_GH_HEAD=deadbeef FAKE_GH_REQUIRED=0
hook_case "merge blocked when CI is red" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "CI is not green on $sha" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=1 FAKE_GH_CHECKS=1
hook_case "merge blocked when CI is still pending" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "CI is not green" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=1 FAKE_GH_CHECKS=8
hook_case "merge allowed when no check is required but all pass" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=1 FAKE_GH_CHECKS=0
hook_case "merge fails closed when gh pr view fails" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "gh pr view failed" "${gh_env[@]}" FAKE_GH_VIEW_FAIL=1 FAKE_GH_REQUIRED=0
hook_case "merge fails closed on an empty PR head" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "the PR head is unknown" "${gh_env[@]}" FAKE_GH_HEAD= FAKE_GH_REQUIRED=0
hook_case "merge blocked for a sha that is not hex" "$mrepo" "gh pr merge 5 --match-head-commit main" 2 "'main' is not a commit sha" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "gh api PUT .../pulls/5/merge without sha blocked" "$mrepo" "gh api -X PUT repos/o/r/pulls/5/merge -f merge_method=squash" 2 "merge exactly the head you checked" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "gh api PUT .../pulls/5/merge with -f sha allowed" "$mrepo" "gh api -X PUT repos/o/r/pulls/5/merge -f sha=$sha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "gh pr view is not a merge" "$mrepo" "gh pr view 5 --json state" 0 "" "${gh_env[@]}"
hook_case "gh pr merge --help style text in a message passes" "$mrepo" 'echo "run gh pr merge later"' 0 "" "${gh_env[@]}"

: > "$mlog"
hook_case "merge passes -R and the PR to gh" "$mrepo" "gh pr merge 5 -R o/r --match-head-commit $sha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0 "FAKE_GH_LOG=$mlog"
pass_if "gh was asked about PR 5 in o/r" grep -qF "pr view 5 -R o/r" "$mlog"

mred=$(new_repo merge-red); green_normal "$mred"; rm "$mred/.scratch/shape/$SLUG.md"; msha=$(git -C "$mred" rev-parse HEAD)
hook_case "merge blocked when the feature-loop gates are red" "$mred" "gh pr merge 5 --match-head-commit $msha" 2 "G1 red: shape file missing" "${gh_env[@]}" "FAKE_GH_HEAD=$msha" FAKE_GH_REQUIRED=0
hook_case "merge never blocked without gates.json" "$plain_repo" "gh pr merge 5" 0 "" "${gh_env[@]}"

# merge_check in gates.json replaces the gh checks. {sha} and {pr} are filled in.
merge_check_repo() { # <name> <merge_check command>
  local d; d=$(new_repo "$1"); green_normal "$d"
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ slug: "reply-options", size: "normal", base: "main", merge_check: process.argv[2] }))' "$d/.scratch/gates.json" "$2"
  printf '%s' "$d"
}
cpass=$(merge_check_repo merge-check-pass 'test "{pr}" = 5 && test "{sha}" = "$EXPECT_SHA"')
csha=$(git -C "$cpass" rev-parse HEAD)
hook_case "merge_check run with {sha} and {pr} filled in, exit 0 allows" "$cpass" "gh pr merge 5 --match-head-commit $csha" 0 "" "${gh_env[@]}" FAKE_GH_VIEW_FAIL=1 "EXPECT_SHA=$csha"
hook_case "merge_check replaces gh: a failing gh stub does not matter" "$cpass" "gh pr merge 5 --match-head-commit $csha" 0 "" "${gh_env[@]}" FAKE_GH_VIEW_FAIL=1 FAKE_GH_REQUIRED=1 FAKE_GH_CHECKS=1 "EXPECT_SHA=$csha"
hook_case "merge_check non-zero blocks" "$cpass" "gh pr merge 6 --match-head-commit $csha" 2 "merge_check failed: test \"6\" = 5" "${gh_env[@]}" "EXPECT_SHA=$csha"
hook_case "merge_check refuses a PR reference with shell characters" "$cpass" 'gh pr merge "5;touch pwned" --match-head-commit '"$csha" 2 "cannot go into merge_check" "${gh_env[@]}" "EXPECT_SHA=$csha"
pass_if "merge_check injection did not run" test ! -e "$cpass/pwned"
cfail=$(merge_check_repo merge-check-fail 'false')
hook_case "merge_check false blocks" "$cfail" "gh pr merge 5 --match-head-commit $(git -C "$cfail" rev-parse HEAD)" 2 "merge_check failed: false" "${gh_env[@]}"

hook_case "merge bypass without reason still blocked" "$mrepo" "gh pr merge 5" 2 "without FEATURE_LOOP_BYPASS_REASON" "${gh_env[@]}" FEATURE_LOOP_GATES=off
hook_case "merge bypass with reason allowed" "$mrepo" "gh pr merge 5" 0 "" "${gh_env[@]}" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=CI outage, lead approved"
pass_if "merge bypass logged" grep -qF "reply-options gates bypassed: CI outage, lead approved (merge)" "$mrepo/.scratch/loop-metrics.md"

# ---- stop-hook.sh and session-start-hook.sh

stop_payload() { # <cwd or ""> <stop_hook_active true|false>
  node -e 'const o = { hook_event_name: "Stop", session_id: "s1", stop_hook_active: process.argv[2] === "true" }; if (process.argv[1]) o.cwd = process.argv[1]; process.stdout.write(JSON.stringify(o))' "$1" "$2"
}
start_payload() { node -e 'const o = { hook_event_name: "SessionStart", session_id: "s1", source: "startup" }; if (process.argv[1]) o.cwd = process.argv[1]; process.stdout.write(JSON.stringify(o))' "$1"; }

# event_case <name> <script> <payload> <exit> <out|err> <needle, or @empty for no output> [VAR=value...]
event_case() {
  local name="$1" script="$2" payload="$3" want="$4" stream="$5" needle="$6"; shift 6
  local so="$work/ev.out" se="$work/ev.err" code bad="" text
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$here/$script" >"$so" 2>"$se"); code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ "$stream" = out ]; then text="$(cat "$so")"; else text="$(cat "$se")"; fi
  if [ "$needle" = @empty ]; then
    [ -z "$(cat "$so" "$se")" ] || bad="${bad:+$bad; }expected no output"
  elif [ -n "$needle" ] && ! printf '%s\n' "$text" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   $script: $name"; else echo "FAIL $script: $name: $bad"; printf '%s\n' "$text" | sed 's/^/       | /'; fail=1; fi
}

srepo=$(new_repo stop-running); green_normal "$srepo"; put "$srepo" loop-status-running.md .scratch/loop-status.md
msg='feature-loop: stage 2 behavioral-envelope is running with no result; finish it and record its gate result, or mark it "blocked: <decision needed>" in .scratch/loop-status.md'
event_case "running stage blocks stopping" stop-hook.sh "$(stop_payload "$srepo" false)" 2 err "$msg"
event_case "stop_hook_active never loops" stop-hook.sh "$(stop_payload "$srepo" true)" 0 err @empty
mkdir -p "$srepo/src/deep"
event_case "subdirectory cwd finds the repo root" stop-hook.sh "$(stop_payload "$srepo/src/deep" false)" 2 err "stage 2 behavioral-envelope is running"
event_case "no cwd in the input: CLAUDE_PROJECT_DIR" stop-hook.sh "$(stop_payload "" false)" 2 err "stage 2 behavioral-envelope is running" "CLAUDE_PROJECT_DIR=$srepo"
event_case "unreadable input never blocks" stop-hook.sh "not json" 0 err @empty "CLAUDE_PROJECT_DIR=$work/outside"

put "$srepo" loop-status-columns.md .scratch/loop-status.md
event_case "columns found by name, status case-insensitive" stop-hook.sh "$(stop_payload "$srepo" false)" 2 err "stage 2 behavioral-envelope is running"
put "$srepo" loop-status-blocked.md .scratch/loop-status.md
event_case "blocked, done, pending and skipped never block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
put "$srepo" loop-status.md .scratch/loop-status.md
event_case "done, pending and skipped never block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
rm "$srepo/.scratch/loop-status.md"
event_case "no loop-status.md: nothing to block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
srepo2=$(new_repo stop-nogates); put "$srepo2" loop-status-running.md .scratch/loop-status.md
event_case "no gates.json: not running the loop" stop-hook.sh "$(stop_payload "$srepo2" false)" 0 err @empty
srepo3=$(new_repo stop-two); green_normal "$srepo3"; printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 2 | shape | running | | | | |\n| 3 | tdd | running | | | | |\n' > "$srepo3/.scratch/loop-status.md"
event_case "every running stage is named" stop-hook.sh "$(stop_payload "$srepo3" false)" 2 err "stage 3 tdd is running with no result"

trepo=$(new_repo start-summary); green_normal "$trepo"; put "$trepo" loop-status.md .scratch/loop-status.md
event_case "summary names slug and size" session-start-hook.sh "$(start_payload "$trepo")" 0 out 'feature-loop is running for "reply-options" (size normal)'
event_case "summary lists rows that are not done" session-start-hook.sh "$(start_payload "$trepo")" 0 out "- 3 tdd: pending"
event_case "summary lists skipped rows too" session-start-hook.sh "$(start_payload "$trepo")" 0 out "- 4 live-verify: skipped: no UI change"
event_case "summary says where to resume" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Resume at: stage 3 tdd (pending)"
pass_if "done rows are not listed" test -z "$(printf '%s' "$(start_payload "$trepo")" | bash "$here/session-start-hook.sh" | grep -F -- '- 1 shape')"
put "$trepo" loop-status-blocked.md .scratch/loop-status.md
event_case "a blocked stage is the resume point" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Resume at: stage 2 behavioral-envelope (blocked: which rollout order do you want)"
printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 1 | shape | done | G1 | measured: x | | |\n| 2 | tdd | skipped: trivial | | | | |\n' > "$trepo/.scratch/loop-status.md"
event_case "all stages done or skipped" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Every stage is done or skipped"
rm "$trepo/.scratch/loop-status.md"
event_case "no loop-status.md yet" session-start-hook.sh "$(start_payload "$trepo")" 0 out "no .scratch/loop-status.md yet"
event_case "no gates.json: prints nothing" session-start-hook.sh "$(start_payload "$plain_repo")" 0 out @empty
bad_repo=$(new_repo start-bad); mkdir -p "$bad_repo/.scratch"; printf '{ nope' > "$bad_repo/.scratch/gates.json"
event_case "invalid gates.json never fails the session" session-start-hook.sh "$(start_payload "$bad_repo")" 0 out @empty
event_case "garbage input never fails the session" session-start-hook.sh "not json" 0 out @empty "CLAUDE_PROJECT_DIR=$outside"


# ======================================================================================================
# Fix round: phases, builder worktrees, fail-closed hooks, closed loops, other merge paths, G7, parity
# ======================================================================================================

# silent_case <name> <cwd> <command> [VAR=value...]: exit 0 and nothing on stdout or stderr.
silent_case() {
  local name="$1" cwd="$2" cmd="$3"; shift 3
  local payload so se code bad=""
  payload="$(node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_name: "Bash", tool_input: { command: process.argv[2] } }))' "$cwd" "$cmd")"
  so="$work/sc.out"; se="$work/sc.err"
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" >"$so" 2>"$se"); code=$?
  [ "$code" = 0 ] || bad="exit $code, want 0"
  [ -z "$(cat "$so" "$se")" ] || bad="${bad:+$bad; }expected no output"
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook (silent): $name"; else echo "FAIL hook (silent): $name: $bad"; cat "$so" "$se" | sed 's/^/       | /'; fail=1; fi
}

# raw_hook_case <name> <raw stdin> <exit> <stderr needle> [VAR=value...]: a payload that is not built from JSON.
raw_hook_case() {
  local name="$1" payload="$2" want="$3" needle="$4"; shift 4
  local err code bad=""
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$err" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook: $name"; else echo "FAIL hook: $name: $bad"; printf '%s\n' "$err" | sed 's/^/       | /'; fail=1; fi
}

hook_code() { # <cwd> <command> [VAR=value...]: the hook's exit code
  local cwd="$1" cmd="$2"; shift 2
  local payload code
  payload="$(node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_name: "Bash", tool_input: { command: process.argv[2] } }))' "$cwd" "$cmd")"
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" >/dev/null 2>&1); code=$?
  printf '%s' "$code"
}

set_status() { # <dir> <status>: gates.json with a status field
  printf '{ "slug": "%s", "size": "normal", "base": "main", "status": "%s" }\n' "$SLUG" "$2" > "$1/.scratch/gates.json"
}

# ---- phases (check-gates.sh --phase)

d=$(new_repo ph-build); gates_json "$d" normal; put "$d" shape.md ".scratch/shape/$SLUG.md"; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "phase build: green with only G1 G2 G8 in place (no live run, review or metrics)" "$d" 0 "gates: green for reply-options (size normal): 2 green, 0 red, 1 n/a" 0 --phase build
out="$(cd "$d" && "$check" --phase build)"
pass_if "phase build evaluates exactly G1 G2 G8" test "$(printf '%s\n' "$out" | grep -E '^G[1-8] ' | cut -c1-2 | tr '\n' ' ')" = "G1 G2 G8 "
expect "no phase evaluates every gate: G3 G5 G7 red here" "$d" 1 "G7 red" 3
expect "phase close evaluates every gate" "$d" 1 "G3 red" 3 --phase close
expect "explicit gates before --phase work too" "$d" 0 "gates: green" 0 G1 G2 --phase build

d=$(new_repo ph-merge); green_normal "$d"; rm "$d/.scratch/loop-metrics.md"
expect "phase merge: G1 to G6 and G8 only, so a missing metrics line (G7) is fine" "$d" 0 "gates: green for reply-options (size normal): 5 green, 0 red, 2 n/a" 0 --phase merge
expect "phase close: G7 red without the metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1 --phase close
expect "no phase: G7 red without the metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1
out="$(cd "$d" && "$check" --phase merge)"
pass_if "phase merge prints no G7 line" test -z "$(printf '%s\n' "$out" | grep -E '^G7 ')"

d=$(new_repo ph-g5); green_normal "$d"; put "$d" review-open-high.md ".scratch/review/$SLUG.md"
expect "phase merge: G5 red blocks" "$d" 1 "G5 red: open CONFIRMED finding: F1 HIGH" 1 --phase merge
expect "phase build ignores G5" "$d" 0 "gates: green" 0 --phase build
d=$(new_repo ph-list); green_normal "$d"; rm "$d/.scratch/loop-metrics.md"
out="$(cd "$d" && "$check" --phase merge G6 G7)"
pass_if "explicit gates and a phase intersect (G7 is not a merge gate)" test "$(printf '%s\n' "$out" | grep -E '^G[1-8] ' | cut -c1-2 | tr '\n' ' ')" = "G6 "
expect "usage: unknown phase" "$d" 2 "unknown phase: soon" 0 --phase soon
expect "usage: --phase needs a value" "$d" 2 "--phase needs" 0 --phase

# The hooks use the phases: push and PR creation need only G1 G2 G8; the merge gate needs G1 to G6 and G8.
bd=$(new_repo ph-hook-build); gates_json "$bd" normal; put "$bd" shape.md ".scratch/shape/$SLUG.md"; put "$bd" envelope.md ".scratch/envelope/$SLUG.md"
hook_case "push during Build passes with only G1 G2 G8 green" "$bd" "git push -u origin feature" 0 ""
hook_case "draft PR during Build passes with only G1 G2 G8 green" "$bd" 'gh pr create --draft --title x --body y' 0 ""
hook_case "gh api POST pulls during Build passes with only G1 G2 G8 green" "$bd" "gh api repos/o/r/pulls -f title=x -f head=feature -f base=main" 0 ""
bd2=$(new_repo ph-hook-build-g8); gates_json "$bd2" normal; put "$bd2" shape.md ".scratch/shape/$SLUG.md"; put "$bd2" envelope.md ".scratch/envelope/$SLUG.md"; put "$bd2" loop-status-no-evidence.md .scratch/loop-status.md
hook_case "push during Build is still blocked by a red G8" "$bd2" "git push origin feature" 2 "G8 red: done stage without evidence"
bd3=$(new_repo ph-hook-build-g2); gates_json "$bd3" normal; put "$bd3" shape.md ".scratch/shape/$SLUG.md"
hook_case "push during Build is still blocked by a red G2" "$bd3" "git push origin feature" 2 "G2 red: envelope file missing"

mnm=$(new_repo ph-merge-nometrics); green_normal "$mnm"; rm "$mnm/.scratch/loop-metrics.md"; nsha=$(git -C "$mnm" rev-parse HEAD)
hook_case "merge passes without the metrics line: G7 is the close gate" "$mnm" "gh pr merge 5 --match-head-commit $nsha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$nsha" FAKE_GH_REQUIRED=0
mg5=$(new_repo ph-merge-g5); green_normal "$mg5"; put "$mg5" review-open-high.md ".scratch/review/$SLUG.md"; g5sha=$(git -C "$mg5" rev-parse HEAD)
hook_case "merge blocked when G5 is red" "$mg5" "gh pr merge 5 --match-head-commit $g5sha" 2 "G5 red: open CONFIRMED finding: F1 HIGH" "${gh_env[@]}" "FAKE_GH_HEAD=$g5sha" FAKE_GH_REQUIRED=0

# ---- builder worktrees: the loop root is the main worktree

wr=$(new_repo wt-root); gates_json "$wr" normal; put "$wr" shape.md ".scratch/shape/$SLUG.md"; put "$wr" envelope.md ".scratch/envelope/$SLUG.md"
wt="$work/wt-builder"; git -C "$wr" worktree add -q -b builder "$wt" >/dev/null 2>&1 || { echo "FAIL could not add a worktree"; fail=1; }
cp "$fx/src/slop.js" "$wt/src/slop.js"; git -C "$wt" add src/slop.js
pass_if "the worktree has no .scratch of its own" test ! -e "$wt/.scratch/gates.json"
hook_case "commit in a builder worktree is slop-checked" "$wt" 'git commit -m "add slop"' 2 "src/slop.js:2"
hook_case "git -C <worktree> commit from elsewhere is slop-checked" "$outside" "git -C $wt commit -m x" 2 "src/slop.js:2"
pass_if "worktree commit hook leaves its index alone" test "$(git -C "$wt" diff --cached --name-only)" = "src/slop.js"
put "$wr" review-justified.md ".scratch/review/$SLUG.md"
hook_case "justifications are read from the loop root's review file" "$wt" "git commit -m x" 0 ""
wr2=$(new_repo wt-root-red); gates_json "$wr2" normal
wt2="$work/wt-builder-red"; git -C "$wr2" worktree add -q -b builder "$wt2" >/dev/null 2>&1
hook_case "git push in a builder worktree is gated (G1 red)" "$wt2" "git push origin builder" 2 "G1 red: shape file missing"
hook_case "draft PR from a builder worktree is gated" "$wt2" "gh pr create --draft --title x --body y" 2 "G1 red"
put "$wr" loop-status-running.md .scratch/loop-status.md
event_case "stop hook finds the loop from a builder worktree" stop-hook.sh "$(stop_payload "$wt" false)" 2 err "stage 2 behavioral-envelope is running"
event_case "session-start hook finds the loop from a builder worktree" session-start-hook.sh "$(start_payload "$wt")" 0 out 'feature-loop is running for "reply-options"'
rm "$wr/.scratch/loop-status.md"

# A merge run from a worktree judges that worktree's code, not the main checkout's.
wm=$(new_repo wt-merge-root); green_normal "$wm"
wmt="$work/wt-merge"; git -C "$wm" worktree add -q -b builder2 "$wmt" >/dev/null 2>&1
add_slop "$wmt"; wsha=$(git -C "$wmt" rev-parse HEAD)
touch -d "@$(( $(git -C "$wmt" log -1 --format=%ct) + 5 ))" "$wm/.scratch/live/run1/report.json"
hook_case "merge from a worktree checks that worktree's code (G6)" "$wmt" "gh pr merge 5 --match-head-commit $wsha" 2 "CRAFT-06.todo src/slop.js:2" "${gh_env[@]}" "FAKE_GH_HEAD=$wsha" FAKE_GH_REQUIRED=0
put "$wm" review-justified.md ".scratch/review/$SLUG.md"
hook_case "merge from a worktree passes once the findings are justified" "$wmt" "gh pr merge 5 --match-head-commit $wsha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$wsha" FAKE_GH_REQUIRED=0

# ---- fail closed when a loop is active

nonode="$work/nonode-bin"; mkdir -p "$nonode"
nonode_path() { # PATH without node, other tools kept
  local p f b out=""
  local -a parts
  IFS=: read -ra parts <<< "$PATH"
  for p in "${parts[@]}"; do
    if [ -x "$p/node" ] || [ -x "$p/node.exe" ]; then
      for f in "$p"/*; do
        b="${f##*/}"
        case "$b" in node|node.exe) continue ;; esac
        if [ -f "$f" ] && [ -x "$f" ] && [ ! -e "$nonode/$b" ]; then ln -s "$f" "$nonode/$b" 2>/dev/null || true; fi
      done
      p="$nonode"
    fi
    out="${out:+$out:}$p"
  done
  printf '%s' "$out"
}
np="$(nonode_path)"
pass_if "test setup: the PATH built for the node-absent cases has no node" bash -c 'PATH="$1"; ! command -v node >/dev/null 2>&1' _ "$np"
hook_case "node absent, loop active: push fails closed" "$red_repo" "git push" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: commit fails closed" "$crepo" "git commit -m x" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: merge fails closed" "$mrepo" "gh pr merge 5" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: the message says what to do" "$red_repo" "git push" 2 "Install Node" "PATH=$np"
hook_case "node absent, no loop: a warning, not a block" "$plain_repo" "git push" 1 "node not found" "PATH=$np"
hook_case "node absent, command that cannot ship: passes" "$red_repo" "ls -la" 0 "" "PATH=$np"
badbin="$work/badnode-bin"; mkdir -p "$badbin"; printf '#!/bin/sh\necho "node exploded" >&2\nexit 1\n' > "$badbin/node"; chmod +x "$badbin/node"
hook_case "node failing, loop active: push fails closed" "$red_repo" "git push" 2 "could not read the hook input" "PATH=$badbin:$PATH"
hook_case "node failing, no loop: a warning, not a block" "$plain_repo" "git push" 1 "could not read the hook input" "PATH=$badbin:$PATH"
raw_hook_case "malformed hook JSON, loop active: fails closed" '{"cwd":"'"$red_repo"'","tool_name":"Bash","tool_input":{"command":"git push origin' 2 "could not read the hook input"
raw_hook_case "malformed hook JSON without a cwd, loop active via CLAUDE_PROJECT_DIR: fails closed" 'tool_input git push {{' 2 "could not read the hook input" "CLAUDE_PROJECT_DIR=$red_repo"
raw_hook_case "malformed hook JSON, no loop: a warning, not a block" '{"cwd":"'"$plain_repo"'","tool_input":{"command":"git push' 1 "could not read the hook input"

# ---- gates.json: malformed, closed

badj=$(new_repo hook-badjson); mkdir -p "$badj/.scratch"; printf '{ nope' > "$badj/.scratch/gates.json"; cp "$fx/src/slop.js" "$badj/src/slop.js"; git -C "$badj" add src/slop.js
hook_case "malformed gates.json: push fails closed and says so" "$badj" "git push" 2 "is not valid JSON"
hook_case "malformed gates.json: commit fails closed and says so" "$badj" "git commit -m x" 2 "is not valid JSON"
hook_case "malformed gates.json: merge fails closed and says so" "$badj" "gh pr merge 5" 2 "is not valid JSON"

cl=$(new_repo closed-red); green_normal "$cl"; rm "$cl/.scratch/shape/$SLUG.md"; put "$cl" loop-status-running.md .scratch/loop-status.md
cp "$fx/src/slop.js" "$cl/src/slop.js"; git -C "$cl" add src/slop.js
hook_case "(open loop, for contrast) push blocked" "$cl" "git push origin feature" 2 "G1 red"
set_status "$cl" closed
silent_case "closed loop: push is not gated" "$cl" "git push origin feature"
silent_case "closed loop: PR creation is not gated" "$cl" "gh pr create --title x --body y"
silent_case "closed loop: staged slop commit is not gated" "$cl" "git commit -m x"
silent_case "closed loop: merge is not gated" "$cl" "gh pr merge 5" "${gh_env[@]}"
silent_case "closed loop: push to the base branch is not refused" "$cl" "git push origin HEAD:main"
silent_case "closed loop, node absent: silent" "$cl" "git push origin feature" "PATH=$np"
printf '{"slug":"reply-options","size":"normal","base":"main","status":"closed"}\n' > "$cl/.scratch/gates.json"
silent_case "closed loop (compact JSON): push is not gated" "$cl" "git push origin feature"
expect "closed loop: check-gates says so and exits 0" "$cl" 0 "loop closed" 0
event_case "closed loop: stop hook is silent" stop-hook.sh "$(stop_payload "$cl" false)" 0 err @empty
event_case "closed loop: session-start prints nothing" session-start-hook.sh "$(start_payload "$cl")" 0 out @empty
set_status "$cl" running
hook_case "status other than closed keeps the loop active" "$cl" "git push origin feature" 2 "G1 red"

# ---- other merge paths

gq() { printf "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kwDOabc\"%s}) { pullRequest { id } } }'" "${1:+, expectedHeadOid: \"$1\"}"; }
hook_case "graphql mergePullRequest blocked when the gates are red" "$mred" "$(gq "$msha")" 2 "G1 red: shape file missing" "${gh_env[@]}" "FAKE_GH_HEAD=$msha" FAKE_GH_REQUIRED=0
hook_case "graphql mergePullRequest needs the head sha" "$mrepo" "$(gq)" 2 "merge exactly the head you checked" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "graphql mergePullRequest with the head sha, green gates and CI is allowed" "$mrepo" "$(gq "$sha")" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "graphql mergePullRequest blocked when CI is red" "$mrepo" "$(gq "$sha")" 2 "CI is not green" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=1 FAKE_GH_CHECKS=1
hook_case "graphql merge with -f expectedHeadOid=<sha> counts as the sha" "$mrepo" "gh api graphql -f query='mutation(\$id: ID!, \$oid: GitObjectID) { mergePullRequest(input: {pullRequestId: \$id, expectedHeadOid: \$oid}) { clientMutationId } }' -f id=PR_x -f expectedHeadOid=$sha" 0 "" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "a read-only graphql query passes" "$mred" "gh api graphql -f query='query { viewer { login } }'" 0 ""
hook_case "a graphql createPullRequest is still a PR creation" "$red_repo" "gh api graphql -f query='mutation { createPullRequest(input: {title: \"x\"}) { pullRequest { id } } }'" 2 "G1 red"

# A merge is judged on the local tree, so the checked-out HEAD must be the sha being merged.
mh=$(new_repo merge-head); green_normal "$mh"; oldsha=$(git -C "$mh" rev-parse HEAD~1)
hook_case "merge refused when the checked-out HEAD is not the sha" "$mh" "gh pr merge 5 --match-head-commit $oldsha" 2 "check out the PR head $oldsha first" "${gh_env[@]}" "FAKE_GH_HEAD=$oldsha" FAKE_GH_REQUIRED=0
hook_case "a graphql merge is refused too when HEAD is not the sha" "$mh" "$(gq "$oldsha")" 2 "check out the PR head $oldsha first" "${gh_env[@]}" "FAKE_GH_HEAD=$oldsha" FAKE_GH_REQUIRED=0
hook_case "merge_check does not excuse a HEAD that is not the sha" "$cpass" "gh pr merge 5 --match-head-commit $(git -C "$cpass" rev-parse HEAD~1)" 2 "check out the PR head" "${gh_env[@]}" "EXPECT_SHA=$csha"

# A push that targets the base branch skips the merge gate; refuse it.
br=$(new_repo push-base); green_normal "$br"
hook_case "push HEAD:main refused" "$br" "git push origin HEAD:main" 2 "merge through the PR so the merge gate runs"
hook_case "push origin main refused" "$br" "git push origin main" 2 "merge through the PR so the merge gate runs"
hook_case "push feature:main with force-with-lease refused" "$br" "git push --force-with-lease origin feature:main" 2 "merge through the PR"
hook_case "push HEAD:refs/heads/main refused" "$br" "git push origin HEAD:refs/heads/main" 2 "merge through the PR"
hook_case "push --all refused" "$br" "git push --all origin" 2 "merge through the PR"
hook_case "git -C <repo> push origin main refused" "$outside" "git -C $br push origin main" 2 "merge through the PR"
hook_case "the base-branch refusal names the base" "$br" "git push origin main" 2 "base branch (main)"
hook_case "push of the feature branch is fine" "$br" "git push origin feature" 0 ""
hook_case "push of HEAD from a feature branch is fine" "$br" "git push origin HEAD" 0 ""
hook_case "push main:feature (the base as the source) is fine" "$br" "git push origin main:feature" 0 ""
bm=$(new_repo push-base-checkout); green_normal "$bm"; git -C "$bm" checkout -q main
hook_case "plain git push while the base is checked out refused" "$bm" "git push" 2 "merge through the PR so the merge gate runs"
hook_case "git push origin HEAD while the base is checked out refused" "$bm" "git push origin HEAD" 2 "merge through the PR"
hook_case "git push origin feature from the base checkout is fine" "$bm" "git push origin feature" 0 ""
hook_case "push to main without a loop is not refused" "$plain_repo" "git push origin HEAD:main" 0 ""
hook_case "push to the base with a recorded bypass is allowed" "$br" "git push origin HEAD:main" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=hotfix approved by lead"
pass_if "push-to-base bypass logged" grep -qF "reply-options gates bypassed: hotfix approved by lead" "$br/.scratch/loop-metrics.md"

# ---- G7 reads the last metrics line and trusts no number it can check

d=$(new_repo g7-escapes-low); green_normal "$d"; put "$d" metrics-escapes-low.md .scratch/loop-metrics.md
expect "G7 red: escapes below the CONFIRMED findings in the review" "$d" 1 "G7 red: escapes=1 is below the 2 CONFIRMED findings in .scratch/review/reply-options.md: every CONFIRMED finding is an escape (.scratch/loop-metrics.md)" 1 G7
d=$(new_repo g7-last-bad); green_normal "$d"
printf '# Loop metrics\n\n2026-10-08 reply-options: escapes=2 floors=2\n2026-10-09 reply-options: findings 3, 1 day\n' > "$d/.scratch/loop-metrics.md"
expect "G7 red: only the last metrics line counts, an earlier good one does not" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m>" 1 G7
d=$(new_repo g7-last-good); green_normal "$d"
printf '# Loop metrics\n\n2026-10-08 reply-options: findings 3, 1 day\n2026-10-09 reply-options: escapes=2 floors=2\n2026-10-09T10:00:00Z reply-options gates bypassed: demo\n' > "$d/.scratch/loop-metrics.md"
expect "G7 green: the last metrics line is good (a later bypass record is not a metrics line)" "$d" 0 "G7 green" 0 G7
d=$(new_repo g7-more); green_normal "$d"; printf '# Loop metrics\n\n2026-10-09 reply-options: escapes=3 floors=3\n' > "$d/.scratch/loop-metrics.md"
expect "G7 green: more escapes than CONFIRMED findings is fine" "$d" 0 "G7 green" 0 G7
d=$(new_repo g7-floors-low-last); green_normal "$d"; put "$d" metrics-floor-low.md .scratch/loop-metrics.md
expect "G7 red: floors still below escapes" "$d" 1 "G7 red: floors=1 is below escapes=2" 1 G7

# ---- the justification rule is one rule: G6 (check-gates) and the commit hook agree on every review file

par=$(new_repo parity); gates_json "$par" normal; cp "$fx/src/slop.js" "$par/src/slop.js"; git -C "$par" add src/slop.js
parity_case() { # <name> <block|allow> <review file content>
  local name="$1" want="$2" content="$3" g c
  mkdir -p "$par/.scratch/review"; printf '%s' "$content" > "$par/.scratch/review/$SLUG.md"
  (cd "$par" && "$check" G6 >/dev/null 2>&1); g=$?
  c="$(hook_code "$par" "git commit -m x")"
  total=$((total + 1))
  if { [ "$want" = allow ] && [ "$g" = 0 ] && [ "$c" = 0 ]; } || { [ "$want" = block ] && [ "$g" = 1 ] && [ "$c" = 2 ]; }; then
    echo "ok   parity: $name"
  else
    echo "FAIL parity: $name: want $want, G6 exit $g, commit hook exit $c"; fail=1
  fi
}
parity_case "both findings justified with reasons" allow $'## Justified\n\n- `src/slop.js:2` CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: the CLI prints on purpose\n'
parity_case "a listing without a reason does not count" block $'## Justified\n\n- src/slop.js:2 CRAFT-06.todo\n- src/slop.js:3 CRAFT-06.debug-output\n'
parity_case "a ./ prefix on the path still counts" allow $'## Justified\n\n- ./src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- ./src/slop.js:3 CRAFT-06.debug-output: the CLI prints on purpose\n'
parity_case "line 20 does not justify line 2" block $'## Justified\n\n- src/slop.js:20 CRAFT-06.todo: another line entirely\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "only one of two findings justified" block $'## Justified\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n'
parity_case "a listing outside the Justified section does not count" block $'## Notes\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n\n## Justified\n\n- none\n'
parity_case "a listing inside a code fence does not count" block $'## Justified\n\n```\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n```\n'
parity_case "a deeper heading level is the same section" allow $'# Review\n\n### Justified\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "a heading with a colon is the same section" allow $'## Justified:\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "a location inside a longer path does not count" block $'## Justified\n\n- other/src/slop.js:2 CRAFT-06.todo: not this file\n- other/src/slop.js:3 CRAFT-06.debug-output: not this file\n'
parity_case "an empty review file justifies nothing" block ''
rm -f "$par/.scratch/review/$SLUG.md"
(cd "$par" && "$check" G6 >/dev/null 2>&1); g=$?; c="$(hook_code "$par" "git commit -m x")"
pass_if "parity: a missing review file blocks both" test "$g/$c" = "1/2"

# ---- errors are not hidden

fa=$(new_repo add-fails); gates_json "$fa" normal
hook_case "a failing chained git add fails closed with its error shown" "$fa" 'git add no-such-file && git commit -m x' 2 "git add failed"
hook_case "a failing chained git add names the path" "$fa" 'git add no-such-file && git commit -m x' 2 "no-such-file"
echo
if [ "$fail" -eq 0 ]; then echo "test-gates: all $total passed"; else echo "test-gates: failures above ($total cases)"; fi
exit "$fail"
