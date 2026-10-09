#!/usr/bin/env bash
# End-to-end demonstration of the feature-loop gates on the reference product (live-verify/bench/inbox-assist).
#
# Builds a throwaway git repo holding the product, writes the loop files a real run leaves behind (the shape,
# envelope and review files from the product's loop/ folder, a metrics line, the real eval results), runs the
# live suite there, and checks the gates. Then it breaks one thing at a time and expects the right gate to go red:
#   (a) a scenario covering a journey case is deleted and live-verify rerun -> G3
#   (b) a Proof cell in the envelope's Live table is blanked             -> G2
#   (c) a review finding becomes CONFIRMED HIGH with resolution open     -> G5
#   (d) an unjustified `catch {}` is added to src                        -> G6
#   (e) gate-hook.sh, fed a `git push` command: asks only the build gates (G1 G2 G8), so a red G4 or G6 does not
#       stop a push during Build; blocks (exit 2) while a build gate is red, passes (exit 0) with a recorded bypass,
#       and names exactly the gates check-gates.sh --phase build names.
#
# G4 (evals) applies because the envelope's Packs line names llm. It is checked against the real eval run in
# evals/examples/inbox-assist/results/after/results.json, whose gate pass.lo>=0.6 fails narrowly (58.5%), so the
# demo expects G4 red with that reason and checks the other six gates for exit 0. A results file that passes
# would have to come from a passing eval run, not from this script.
#
# Takes about two minutes (the live suite runs twice). Prints ok/FAIL per step; exits 1 on any FAIL.
#   skills/fork/feature-loop/bench/gates-demo.sh            KEEP=1 keeps the temp repo and prints its path
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fork="$(cd "$here/../.." && pwd)"
app="$fork/live-verify/bench/inbox-assist"
runner="$fork/live-verify/harness/runner.mjs"
check="$fork/feature-loop/scripts/check-gates.sh"
hook="$fork/feature-loop/scripts/gate-hook.sh"
eval_results="$fork/evals/examples/inbox-assist/results/after/results.json"
SLUG=inbox-assist
SIX=(G1 G2 G3 G5 G6 G7)

work="$(mktemp -d)"
if [ "${KEEP:-0}" = 1 ]; then echo "temp repo kept: $work/repo"; else trap 'rm -rf "$work"' EXIT; fi
repo="$work/repo"
unset FEATURE_LOOP_GATES FEATURE_LOOP_BYPASS_REASON CLAUDE_PROJECT_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=demo GIT_AUTHOR_EMAIL=demo@example.com GIT_COMMITTER_NAME=demo GIT_COMMITTER_EMAIL=demo@example.com

fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/       | /'; fail=1; }

# ---- helpers

# The red gate IDs in check-gates output, space separated and sorted.
reds() { printf '%s\n' "$1" | sed -n 's/^\(G[1-7]\) red:.*/\1/p' | sort | tr '\n' ' ' | sed 's/ $//'; }

# expect_gates <label> <exit> <red IDs, "" for none> <needle, "" for none> [gate args]
expect_gates() {
  local label="$1" want="$2" want_reds="$3" needle="$4"; shift 4
  local out code why=""
  out="$(cd "$repo" && "$check" "$@" 2>&1)"; code=$?
  [ "$code" = "$want" ] || why="exit $code, want $want"
  [ "$(reds "$out")" = "$want_reds" ] || why="${why:+$why; }red gates '$(reds "$out")', want '$want_reds'"
  if [ -n "$needle" ] && ! printf '%s\n' "$out" | grep -qF -- "$needle"; then why="${why:+$why; }missing: $needle"; fi
  if [ -z "$why" ]; then
    ok "$label"
    printf '%s\n' "$out" | grep -E '^G[1-7] red:' | sed 's/^/       /'
  else
    bad "$label: $why" "$out"
  fi
}

# Runs the live suite in the repo; prints the run directory it wrote.
live() {
  local before after
  before="$(ls "$repo/.scratch/live" 2>/dev/null | sort | tail -n 1)"
  (cd "$repo" && node --no-warnings "$runner" --app "$repo" --instances 2 --llm stub) > "$work/live.txt" 2>&1
  local code=$?
  after="$(ls "$repo/.scratch/live" 2>/dev/null | sort | tail -n 1)"
  echo "       live: exit $code, $(tail -n 1 "$work/live.txt")" >&2
  [ -n "$after" ] && [ "$after" != "$before" ] && printf '%s' "$repo/.scratch/live/$after"
}

# hook <label> <command> <exit> <stderr needle> [VAR=value...]
hook() {
  local label="$1" cmd="$2" want="$3" needle="$4"; shift 4
  local payload err code why=""
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "demo", transcript_path: "/dev/null", cwd: process.argv[1], hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: process.argv[2], description: "demo" } }))' "$repo" "$cmd")"
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || why="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$err" | grep -qF -- "$needle"; then why="${why:+$why; }missing: $needle"; fi
  if [ -z "$why" ]; then ok "hook: $label"; else bad "hook: $label: $why" "$err"; fi
}

# ---- build the repo
# The initial commit holds the product's proof harness (scenarios, unit tests, runner config); the feature
# commit adds src/. With the initial commit as base, G6 scans exactly the app's src as added lines.

mkdir -p "$repo"
(
  set -e
  cd "$repo"
  git init -q -b main
  printf '.scratch/\n' > .gitignore
  cp -R "$app/scenarios" "$app/test" "$app/live-verify.json" .
  git add -A && git commit -q -m "proof harness"
  git checkout -q -b feature
  cp -R "$app/src" .
  git add -A && git commit -q -m "inbox-assist"
) || { echo "FAIL could not build the demo repo"; exit 1; }
base="$(git -C "$repo" rev-list --max-parents=0 HEAD)"

mkdir -p "$repo/.scratch/shape" "$repo/.scratch/envelope" "$repo/.scratch/review" "$repo/.scratch/evals/$SLUG"
printf '{ "slug": "%s", "size": "normal", "base": "%s" }\n' "$SLUG" "$base" > "$repo/.scratch/gates.json"
cp "$app/loop/shape.md" "$repo/.scratch/shape/$SLUG.md"
cp "$app/loop/envelope.md" "$repo/.scratch/envelope/$SLUG.md"
cp "$app/loop/review.md" "$repo/.scratch/review/$SLUG.md"
cp "$eval_results" "$repo/.scratch/evals/$SLUG/results.json"
printf '# Loop metrics\n\n2026-10-08 %s: review 14 CONFIRMED (all fixed), 0 open; live scenarios 40 (15 added from review); planted bugs caught 13 of 13; evals all-graders pass +56.7 points, gate pass.lo>=0.6 failing narrowly; escapes=14 floors=14\n' "$SLUG" > "$repo/.scratch/loop-metrics.md"
echo "demo repo: base $base, feature $(git -C "$repo" rev-parse --short HEAD), slug $SLUG, size normal"

# ---- baseline

run="$(live)"
passing="$( [ -n "$run" ] && node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = r.scenarios ?? []; process.stdout.write(`${s.filter((x) => x.result === "pass").length}/${s.length}`)' "$run/report.json" 2>/dev/null)"
if [ -n "$passing" ] && [ "${passing%/*}" = "${passing#*/}" ] && [ "${passing#*/}" != 0 ]; then ok "baseline: live suite green, $passing scenarios pass"
else bad "baseline: live suite not green (${passing:-no report})" "$(tail -n 20 "$work/live.txt")"; fi

expect_gates "baseline: all seven gates, only G4 red (real eval run, pass.lo>=0.6 fails narrowly)" 1 "G4" "eval gates not ok: pass.lo>=0.6"
expect_gates "baseline: G1 G2 G3 G5 G6 G7 all green, exit 0" 0 "" "6 green, 0 red" "${SIX[@]}"

# ---- (a) a scenario covering a journey case is deleted -> G3

victim="$(cd "$repo/scenarios" && ls 31-*.mjs)"
case_id="$(sed -n "s/^  journey: '\(J[0-9]*\.[a-z0-9-]*\) .*/\1/p" "$repo/scenarios/$victim")"
rm "$repo/scenarios/$victim"
broken_run="$(live)"
expect_gates "(a) $victim deleted, live rerun: G3 red, $case_id in no scenario" 1 "G3" "journey cases in no scenario: $case_id" "${SIX[@]}"
git -C "$repo" checkout -q -- "scenarios/$victim"
[ -n "$broken_run" ] && rm -rf "$broken_run" # the evidence of the broken run goes; the green baseline run is newest again
expect_gates "(a) restored: six gates green again" 0 "" "" "${SIX[@]}"

# ---- (b) one Proof cell blanked -> G2

env_file="$repo/.scratch/envelope/$SLUG.md"
cp "$env_file" "$work/envelope.bak"
awk 'BEGIN { FS = OFS = "|" } $2 ~ /^ OUT-01 $/ && !done { $7 = " "; done = 1 } { print }' "$work/envelope.bak" > "$env_file"
expect_gates "(b) OUT-01 Proof blanked: G2 red" 1 "G2" "Live rows not filled: OUT-01 (Proof empty)" "${SIX[@]}"
cp "$work/envelope.bak" "$env_file"

# ---- (c) a review finding marked CONFIRMED HIGH open -> G5

rev_file="$repo/.scratch/review/$SLUG.md"
cp "$rev_file" "$work/review.bak"
awk 'BEGIN { FS = OFS = "|" } $2 ~ /^ F1 $/ { $5 = " HIGH "; $6 = " CONFIRMED "; $7 = " open " } { print }' "$work/review.bak" > "$rev_file"
expect_gates "(c) F1 CONFIRMED HIGH open: G5 red" 1 "G5" "open CONFIRMED finding: F1 HIGH" "${SIX[@]}"
cp "$work/review.bak" "$rev_file"

# ---- (d) an unjustified catch {} in src -> G6, and (e) the hook

cp "$repo/src/log.mjs" "$work/log.bak"
printf '\nexport function quietly(fn) {\n  try { return fn(); } catch {}\n}\n' >> "$repo/src/log.mjs"
line="$(grep -n 'catch {}' "$repo/src/log.mjs" | head -n 1 | cut -d: -f1)"
expect_gates "(d) catch {} added at src/log.mjs:$line: G6 red" 1 "G6" "src/log.mjs:$line" "${SIX[@]}"

hook "(e) git push while G6 is red: allowed, G6 is a merge gate" "git push -u origin feature" 0 ""
cp "$work/log.bak" "$repo/src/log.mjs"
expect_gates "(d) restored: six gates green again" 0 "" "" "${SIX[@]}"
hook "(e) git push with only G4 red: allowed during Build, evals gate the merge" "git push origin feature" 0 ""
awk 'BEGIN { FS = OFS = "|" } $2 ~ /^ OUT-01 $/ && !done { $7 = " "; done = 1 } { print }' "$work/envelope.bak" > "$env_file"
hook "(e) git push with a Proof cell blanked: blocked, names G2" "git push origin feature" 2 "G2 red: Live rows not filled: OUT-01 (Proof empty)"
out="$(cd "$work" && node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_name: "Bash", tool_input: { command: "git push origin feature" } }))' "$repo" | bash "$hook" 2>&1 >/dev/null)"
if [ "$(printf '%s\n' "$out" | grep -cE '^G[1-7] red:')" = 1 ]; then ok "hook: (e) blocks on exactly the gates check-gates --phase build names (G2)"; else bad "hook: (e) red lines differ from check-gates" "$out"; fi
hook "(e) git push with a recorded bypass: allowed" "git push origin feature" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=envelope proof to follow, accepted for the demo"
if grep -qF "$SLUG gates bypassed: envelope proof to follow, accepted for the demo" "$repo/.scratch/loop-metrics.md"; then ok "hook: (e) bypass recorded in loop-metrics.md"; else bad "hook: (e) bypass not recorded" "$(cat "$repo/.scratch/loop-metrics.md")"; fi
cp "$work/envelope.bak" "$env_file"
hook "(e) an unrelated command passes" "git status" 0 ""

expect_gates "end: six gates still green after the bypass record" 0 "" "" "${SIX[@]}"

echo
if [ "$fail" -eq 0 ]; then echo "gates-demo: all steps ok"; else echo "gates-demo: failures above"; fi
exit "$fail"
