#!/usr/bin/env bash
# Tests for the fork.9 visibility hooks: the timeline, the one-line systemMessage, escalations, the ExitPlanMode
# hand-off and the owner's approvals. Pipes synthetic hook payloads into stage-hook.sh (as Claude Code does).
# Run: skills/fork/feature-loop/scripts/test-visibility.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin="$(cd "$here/../../../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unset FEATURE_LOOP_GATES CLAUDE_PROJECT_DIR
export FEATURE_LOOP_STATE_DIR="$work/state"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
fail=0
total=0

check() { # check <name> <condition exit code> [detail]
  total=$((total + 1))
  if [ "$2" = 0 ]; then echo "ok   $1"; else echo "FAIL $1${3:+: $3}"; fail=1; fi
}
has() { printf '%s' "$1" | grep -qF -- "$2"; }
lacks() { ! printf '%s' "$1" | grep -qF -- "$2"; }

# Repos
new_repo() {
  local d="$work/$1"
  mkdir -p "$d/docs/plans"
  (cd "$d" && git init -q -b main && printf '.scratch/\n.claude/\n' > .gitignore && printf '# demo\n' > README.md \
    && printf '# Plan\n\n## Acceptance tests\n\n- a\n\n## Changes\n\n- none yet\n' > docs/plans/p.md && git add -A && git commit -q -m base) || exit 1
  printf '%s' "$d"
}
loop_repo() {
  local d; d="$(new_repo "$1")"
  mkdir -p "$d/.scratch/envelope"
  printf '{ "slug": "demo", "size": "normal", "base": "main" }\n' > "$d/.scratch/gates.json"
  printf '%s' "$d"
}

# payload <cwd> <event> <tool> <tool_input json> [tool_response json]
payload() {
  node -e 'const [cwd,ev,tool,ti,tr]=process.argv.slice(1);process.stdout.write(JSON.stringify({session_id:"s1",cwd,hook_event_name:ev,tool_name:tool,tool_input:JSON.parse(ti),tool_response:tr?JSON.parse(tr):undefined,error:ev==="PostToolUseFailure"?(tr?JSON.parse(tr).stdout:"failed"):undefined}))' "$@"
}
hook() { # hook <mode> <payload>; sets out, code
  out="$(printf '%s' "$2" | bash "$here/stage-hook.sh" "$1" 2>"$work/stderr")"; code=$?
}
bash_tool() { # bash_tool <repo> <command> [stdout] [fail]
  local ev=PostToolUse; [ "${4:-}" = fail ] && ev=PostToolUseFailure
  local ti; ti="$(node -e 'process.stdout.write(JSON.stringify({command:process.argv[1]}))' "$2")"
  local tr; tr="$(node -e 'process.stdout.write(JSON.stringify({stdout:process.argv[1]||"",stderr:""}))' "${3:-}")"
  hook post-tool "$(payload "$1" "$ev" Bash "$ti" "$tr")"
}
msg_of() { printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).systemMessage??"")}catch{}})'; }
ctx_of() { printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).hookSpecificOutput?.additionalContext??"")}catch{}})'; }
rows() { grep -c '^| 20' "$1/.scratch/timeline.md" 2>/dev/null || echo 0; }
mjs() { # mjs <expr over (m, root)> <root>: evaluates against stage-log.mjs
  node --input-type=module -e "import * as m from '$(node -p "require('url').pathToFileURL(process.argv[1]).href" "$here/stage-log.mjs")'; const root=process.argv[1]; process.stdout.write(String($1))" "$2"
}

# ---- 1. nothing is active: silent, no timeline
r="$(new_repo quiet)"
bash_tool "$r" "npm test" "ok"
check "inactive repo: no output" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"
check "inactive repo: no timeline" "$([ ! -e "$r/.scratch/timeline.md" ] && echo 0 || echo 1)"

# ---- 2. active loop: what is told and what is not
r="$(loop_repo loop)"
hook post-tool "$(payload "$r" PostToolUse Read '{"file_path":"README.md"}' '{"content":"x"}')"
check "read: no message" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"
bash_tool "$r" "git status" "clean"
check "ordinary Bash: no message" "$([ -z "$(msg_of)" ] && echo 0 || echo 1)"
hook post-tool "$(payload "$r" PostToolUse Edit '{"file_path":"src/a.js","old_string":"a","new_string":"b"}' '{}')"
check "edit of an ordinary file: no message" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"
check "no timeline rows so far" "$([ "$(rows "$r")" = 0 ] && echo 0 || echo 1)"

bash_tool "$r" "git push origin feature" "pushed"
m="$(msg_of)"
check "push: one line" "$(has "$m" 'git push ok' && [ "$(printf '%s' "$m" | wc -l)" = 0 ] && echo 0 || echo 1)" "$m"
check "push: no escalation" "$(lacks "$m" ESCALATION && echo 0 || echo 1)"
check "timeline: header once plus the row" "$([ "$(grep -c '^| time UTC | event | detail | evidence |' "$r/.scratch/timeline.md")" = 1 ] && grep -q '| push |' "$r/.scratch/timeline.md" && echo 0 || echo 1)"

bash_tool "$r" "npm test" "1 failing" fail
check "test failure is told" "$(has "$(msg_of)" 'test FAIL' && echo 0 || echo 1)" "$(msg_of)"
bash_tool "$r" "pytest -q" "3 passed"
check "test pass is told" "$(has "$(msg_of)" 'test pass' && echo 0 || echo 1)" "$(msg_of)"
bash_tool "$r" "gh run watch 123" "ok"
check "CI run is told" "$(has "$(msg_of)" 'ci pass' && echo 0 || echo 1)"
bash_tool "$r" "gh pr create --fill" "https://github.com/o/r/pull/7"
check "PR create is told with its url" "$(has "$(msg_of)" 'PR created: https://github.com/o/r/pull/7' && echo 0 || echo 1)"
bash_tool "$r" "git commit -m 'git push --force'" "done"
check "a quoted command text is not a push" "$(lacks "$(msg_of)" push && echo 0 || echo 1)" "$(msg_of)"

bash_tool "$r" "bash scripts/check-gates.sh --phase build" "G1 green
G4 red: no packs
gates: red for demo (size normal): 1 green, 1 red, 0 n/a" fail
check "gate red is told with its tail" "$(has "$(msg_of)" 'gates RED: red for demo' && echo 0 || echo 1)" "$(msg_of)"
bash_tool "$r" "bash scripts/check-gates.sh" "G1 green
G4 green
gates: green for demo (size normal): 2 green, 0 red, 0 n/a"
check "gate green is told" "$(has "$(msg_of)" 'gates green: green for demo' && echo 0 || echo 1)" "$(msg_of)"

bash_tool "$r" "bash skills/fork/codex-review/scripts/codex-review.sh code main" "codex code attack on 1a2b3c4 by gpt-6-astra: 2 CONFIRMED (1 HIGH), 3 PLAUSIBLE"
m="$(msg_of)"
check "codex summary line is told" "$(has "$m" 'codex code attack on 1a2b3c4' && echo 0 || echo 1)" "$m"
check "codex CONFIRMED HIGH escalates first" "$([[ "$m" == ESCALATION:\ codex\ CONFIRMED\ HIGH* ]] && echo 0 || echo 1)" "$m"
bash_tool "$r" "bash skills/fork/codex-review/scripts/codex-review.sh code main" "codex code attack on 1a2b3c4 by gpt-6-astra: 0 CONFIRMED, 3 PLAUSIBLE"
check "codex with nothing severe does not escalate" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)" "$(msg_of)"

# escalations
esc() { # esc <name> <command>
  bash_tool "$r" "$2" "x"
  local m; m="$(msg_of)"
  check "escalation: $1" "$([[ "$m" == *"ESCALATION: "* ]] && echo 0 || echo 1)" "$m"
}
esc "FEATURE_LOOP_GATES=off" "FEATURE_LOOP_GATES=off git push origin feature"
esc "A4c: quotes inside the value (of''f)" "FEATURE_LOOP_GATES=of''f git push origin feature"
esc "A4c: a quoted fragment" "FEATURE_LOOP_GATES=\"o\"ff git push origin feature"
esc "A4c: a backslash" "FEATURE_LOOP_GATES=o\\ff git push origin feature"
esc "A4c: export with a quoted value" "export FEATURE_LOOP_GATES='off'; git push origin feature"
esc "A4c: env prefix" "env FEATURE_LOOP_GATES=off git push origin feature"
esc "A4c: inside bash -c" "bash -c 'FEATURE_LOOP_GATES=off git push origin feature'"
esc "A4c: a value known only at run time" "FEATURE_LOOP_GATES=\$X git push origin feature"
bash_tool "$r" "FEATURE_LOOP_GATES=on git push origin feature" "x"
check "A4c: FEATURE_LOOP_GATES=on does not escalate" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)" "$(msg_of)"
bash_tool "$r" "echo \$FEATURE_LOOP_GATES" "x"
check "A4c: reading the variable does not escalate" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)" "$(msg_of)"
esc "push --force" "git push --force origin feature"
esc "push --force-with-lease" "git push --force-with-lease origin feature"
esc "remote branch delete" "git push origin --delete old"
esc "branch delete" "git branch -D old"
esc "touch on live" "touch .scratch/live/run1/report.json"
esc "touch on evals" "touch .scratch/evals/demo/results.json"
esc "redirect into codex json" "echo '{}' > .scratch/review/codex-code-x.json"
esc "sed -i on evals" "sed -i s/a/b/ .scratch/evals/demo/results.json"
bash_tool "$r" "cat .scratch/live/run1/report.json" "{}"
check "reading live evidence does not escalate" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)"
bash_tool "$r" "git branch -a" "main"
check "git branch listing does not escalate" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)"
hook post-tool "$(payload "$r" PostToolUse Write '{"file_path":"'"$r"'/.scratch/live/run2/report.json","content":"{}"}' '{}')"
check "Write into .scratch/live escalates" "$(has "$(msg_of)" 'ESCALATION: hand edit of .scratch/live/run2/report.json' && echo 0 || echo 1)" "$(msg_of)"
hook post-tool "$(payload "$r" PostToolUse Write '{"file_path":"'"$r"'/.scratch/review/codex-code-x.resolutions.md","content":"r"}' '{}')"
check "the resolutions file is the lead's to write" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"
check "escalations are rows in the timeline" "$([ "$(grep -c '| ESCALATION |' "$r/.scratch/timeline.md")" -ge 9 ] && echo 0 || echo 1)"

# reset --hard on a pushed branch
bare="$work/remote.git"; git init -q --bare "$bare"
(cd "$r" && git remote add origin "$bare" && git checkout -q -b pushed && git push -q origin pushed 2>/dev/null)
bash_tool "$r" "git reset --hard HEAD~0" "HEAD is now"
check "reset --hard on a pushed branch escalates" "$(has "$(msg_of)" 'reset --hard on pushed branch pushed' && echo 0 || echo 1)" "$(msg_of)"
(cd "$r" && git checkout -q -b local-only)
bash_tool "$r" "git reset --hard HEAD~0" "HEAD is now"
check "reset --hard on an unpushed branch is quiet" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)" "$(msg_of)"

# plan ## Changes: the first look is the baseline, an edit is loud, other sections are not
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
printf '# Plan\n\n## Acceptance tests\n\n- a\n- b\n\n## Changes\n\n- none yet\n' > "$r/docs/plans/p.md"
hook post-tool "$(payload "$r" PostToolUse Edit '{"file_path":"docs/plans/p.md"}' '{}')"
check "edit outside ## Changes: quiet" "$(lacks "$(msg_of)" ESCALATION && echo 0 || echo 1)" "$(msg_of)"
printf '# Plan\n\n## Acceptance tests\n\n- a\n- b\n\n## Changes\n\nChanged: x because y\n' > "$r/docs/plans/p.md"
hook post-tool "$(payload "$r" PostToolUse Edit '{"file_path":"docs/plans/p.md"}' '{}')"
check "edit of ## Changes escalates" "$(has "$(msg_of)" 'ESCALATION: the plan'"'"'s ## Changes section was edited' && echo 0 || echo 1)" "$(msg_of)"
hook post-tool "$(payload "$r" PostToolUse Read '{"file_path":"docs/plans/p.md"}' '{}')"
check "the same Changes text is told once" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"

# Packs line after a red G4
printf '# Envelope\n**Packs:** ui, api\n' > "$r/.scratch/envelope/demo.md"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
printf '# Envelope\n**Packs:** ui\n' > "$r/.scratch/envelope/demo.md"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "Packs edit before any red G4: quiet" "$(lacks "$(msg_of)" Packs && echo 0 || echo 1)" "$(msg_of)"
bash_tool "$r" "bash scripts/check-gates.sh" "G4 red: packs incomplete
gates: red for demo (size normal): 0 green, 1 red, 0 n/a" fail
printf '# Envelope\n**Packs:** ui, api, llm\n' > "$r/.scratch/envelope/demo.md"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "Packs edit after a red G4 escalates" "$(has "$(msg_of)" 'ESCALATION: the envelope **Packs:** line was edited after a red G4' && echo 0 || echo 1)" "$(msg_of)"

# stage changes from loop-status.md
printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 1 | shape | running | | | | |\n' > "$r/.scratch/loop-status.md"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "stage started is told" "$(has "$(msg_of)" 'stage 1 shape: pending -> running' && echo 0 || echo 1)" "$(msg_of)"
printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 1 | shape | done | | measured: x | | |\n' > "$r/.scratch/loop-status.md"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "stage done is told" "$(has "$(msg_of)" 'stage 1 shape: running -> done' && echo 0 || echo 1)" "$(msg_of)"
hook post-tool "$(payload "$r" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "an unchanged stage is not told again" "$([ -z "$out" ] && echo 0 || echo 1)" "$out"
hook post-tool "$(payload "$r" PostToolUse Skill '{"skill":"tdd"}' '{}')"
check "a Skill call is a timeline row, not a message" "$([ -z "$out" ] && grep -q '| skill | tdd |' "$r/.scratch/timeline.md" && echo 0 || echo 1)" "$out"
check "the loop log still verifies" "$([ "$(mjs 'm.readLog(root).errors.length' "$r")" = 0 ] && echo 0 || echo 1)"

# ---- 3. ExitPlanMode hand-off (no loop yet)
p="$(new_repo plan)"
hook exit-plan "$(payload "$p" PostToolUse ExitPlanMode '{"plan":"x"}' '{}')"
c="$(ctx_of)"
check "hand-off: exit code 0" "$([ "$code" = 0 ] && echo 0 || echo 1)"
for want in "Do NOT implement" "Commit the plan file" "codex-review" "plan mode" "CONFIRMED" "stop 2" "approve plan" "feature-loop"; do
  check "hand-off context says: $want" "$(has "$c" "$want" && echo 0 || echo 1)"
done
check "hand-off tells the owner" "$(has "$(msg_of)" 'handed off to codex plan review' && echo 0 || echo 1)" "$(msg_of)"
check "hand-off is a timeline row" "$(grep -q '| plan hand-off |' "$p/.scratch/timeline.md" && echo 0 || echo 1)"
bash_tool "$p" "git push origin feature" "ok"
check "after the hand-off the timeline is active" "$(has "$(msg_of)" 'git push ok' && echo 0 || echo 1)" "$(msg_of)"
hook post-tool "$(payload "$p" PostToolUse Edit '{"file_path":"docs/plans/p.md"}' '{}')"
printf '# Plan\n\n## Changes\n\nedited\n' > "$p/docs/plans/p.md"
hook post-tool "$(payload "$p" PostToolUse Edit '{"file_path":"docs/plans/p.md"}' '{}')"
check "plan ## Changes edit after the hand-off escalates" "$(has "$(msg_of)" 'ESCALATION' && echo 0 || echo 1)" "$(msg_of)"

# ---- 4. approvals
a="$(new_repo appr)"
prompt() { hook user-prompt "$(node -e 'process.stdout.write(JSON.stringify({session_id:"s1",cwd:process.argv[1],hook_event_name:"UserPromptSubmit",prompt:process.argv[2]}))' "$1" "$2")"; }
prompt "$a" "looks fine, carry on"
check "an ordinary prompt records nothing" "$([ -z "$out" ] && [ "$(mjs 'm.approvals(root).length' "$a")" = 0 ] && echo 0 || echo 1)" "$out"
plan_sha="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$a/docs/plans/p.md")"
head="$(git -C "$a" rev-parse HEAD)"
prompt "$a" "don't approve plan yet, and should I approve pr?"
check "an approval phrase inside a sentence approves nothing" "$([ "$(mjs 'm.approvals(root).length' "$a")" = 0 ] && echo 0 || echo 1)" "$(mjs 'm.approvals(root).length' "$a")"
prompt "$a" "OK, looks right.
  Approve Acceptance tests as written"
at_key="$(node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const { readFileSync } = await import('node:fs'); const { acceptanceKeyOf } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(acceptanceKeyOf(readFileSync(process.argv[2], 'utf8')));" "$here/acceptance-key.mjs" "$a/docs/plans/p.md")"
check "approve acceptance (any case) is signed with the acceptance tests' key, not the plan sha" "$([ ${#at_key} = 64 ] && [ "$(mjs "m.hasApproval(root,'acceptance','$at_key')" "$a")" = true ] && [ "$(mjs "m.hasApproval(root,'acceptance','$plan_sha')" "$a")" = false ] && echo 0 || echo 1)"
prompt "$a" "approve plan"
check "approve plan is signed with the plan sha" "$([ "$(mjs "m.hasApproval(root,'plan','$plan_sha')" "$a")" = true ] && echo 0 || echo 1)"
check "approval is told to the owner" "$(has "$(msg_of)" 'approval recorded: plan' && has "$(ctx_of)" 'owner' && echo 0 || echo 1)" "$out"
check "a plan approval is not an acceptance approval for another sha" "$([ "$(mjs "m.hasApproval(root,'plan','deadbeef')" "$a")" = false ] && echo 0 || echo 1)"
check "plan approval does not approve the pr" "$([ "$(mjs "m.hasApproval(root,'pr','$head')" "$a")" = false ] && echo 0 || echo 1)"
prompt "$a" "approve pr"
check "approve pr is signed with the head" "$([ "$(mjs "m.hasApproval(root,'pr','$head')" "$a")" = true ] && echo 0 || echo 1)"
prompt "$a" "approve plan
approve pr please"
check "one prompt can carry two approvals (one per line)" "$([ "$(mjs 'm.approvals(root).length' "$a")" = 5 ] && echo 0 || echo 1)" "$(mjs 'm.approvals(root).length' "$a")"
printf 'extra\n' >> "$a/docs/plans/p.md"
check "an edited plan no longer matches an old approval" "$([ "$(mjs "m.hasApproval(root,'plan','$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$a/docs/plans/p.md")')" "$a")" = false ] && echo 0 || echo 1)"
check "approvals are rows in the timeline" "$([ "$(grep -c '| approval |' "$a/.scratch/timeline.md")" -ge 4 ] && echo 0 || echo 1)"

# S3: a CRLF plan is approved by its LF sha, the same number codex-review.sh and G10 use
c="$(new_repo crlfplan)"; printf '# Plan\r\n\r\n## Acceptance tests\r\n\r\n- a\r\n' > "$c/docs/plans/p.md"
lf_plan_sha="$(tr -d '\r' < "$c/docs/plans/p.md" | sha256sum | cut -d' ' -f1)"
prompt "$c" "approve plan"
check "approve plan on a CRLF plan signs the sha256 of its LF form" "$([ "$(mjs "m.hasApproval(root,'plan','$lf_plan_sha')" "$c")" = true ] && echo 0 || echo 1)"

# S5: the owner is told the file and the full sha; with several candidate files the prompt must name one
s="$(new_repo s5)"
s_sha="$(tr -d '\r' < "$s/docs/plans/p.md" | sha256sum | cut -d' ' -f1)"; s_head="$(git -C "$s" rev-parse HEAD)"
prompt "$s" "approve plan"
check "S5: the plan approval message names the file and the full sha" "$(has "$(msg_of)" "approval recorded: plan (docs/plans/p.md, sha256 $s_sha)" && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve pr"
check "S5: the pr approval message names the full head" "$(has "$(msg_of)" "approval recorded: pr (head $s_head)" && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve acceptance"
check "S5: the acceptance approval message names the file and the full key" "$(has "$(msg_of)" 'approval recorded: acceptance (docs/plans/p.md, key ' && [[ "$(msg_of)" =~ key\ [0-9a-f]{64}\) ]] && echo 0 || echo 1)" "$(msg_of)"
n_before="$(mjs 'm.approvals(root).length' "$s")"
printf '# Plan Q\n\n## Acceptance tests\n\n- q item\n\n## Changes\n\n- none\n' > "$s/docs/plans/q.md"
prompt "$s" "approve plan"
check "S5: two plans in docs/plans/ and no file named: not recorded, and it says how" "$(has "$(msg_of)" 'approval NOT recorded: plan: 2 plans in docs/plans/' && has "$(msg_of)" 'approve plan docs/plans/' && [ "$(mjs 'm.approvals(root).length' "$s")" = "$n_before" ] && echo 0 || echo 1)" "$(msg_of)"
q_sha="$(sha256sum "$s/docs/plans/q.md" | cut -d' ' -f1)"
prompt "$s" "approve plan docs/plans/q.md"
check "S5: naming the file records it, with that file's sha" "$(has "$(msg_of)" "approval recorded: plan (docs/plans/q.md, sha256 $q_sha)" && [ "$(mjs "m.hasApproval(root,'plan','$q_sha')" "$s")" = true ] && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve plan docs/plans/nope.md"
check "S5: naming a file that is not a plan records nothing" "$(has "$(msg_of)" 'approval NOT recorded: plan: docs/plans/nope.md is not a plan' && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve acceptance"
check "S5: two files holding acceptance tests and none named: not recorded" "$(has "$(msg_of)" 'approval NOT recorded: acceptance: 2 files in docs/plans/' && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve acceptance docs/plans/q.md"
check "S5: naming the acceptance file records it" "$(has "$(msg_of)" 'approval recorded: acceptance (docs/plans/q.md, key ' && echo 0 || echo 1)" "$(msg_of)"
mkdir -p "$s/docs/acceptance"; printf '# Acceptance\n\n## Acceptance tests\n\n- only item\n' > "$s/docs/acceptance/one.md"
prompt "$s" "approve acceptance"
check "S5: one file in docs/acceptance/ is the source, whatever docs/plans/ holds" "$(has "$(msg_of)" 'approval recorded: acceptance (docs/acceptance/one.md, key ' && echo 0 || echo 1)" "$(msg_of)"
printf '# Acceptance two\n\n## Acceptance tests\n\n- second\n' > "$s/docs/acceptance/two.md"
prompt "$s" "approve acceptance"
check "S5: two files in docs/acceptance/ and none named: not recorded" "$(has "$(msg_of)" 'approval NOT recorded: acceptance: 2 files in docs/acceptance/' && echo 0 || echo 1)" "$(msg_of)"
prompt "$s" "approve plan docs/plans/q.md
approve pr"
check "S5: one prompt, a named plan and a pr approval" "$(has "$(msg_of)" 'plan (docs/plans/q.md' && has "$(msg_of)" "pr (head $s_head)" && echo 0 || echo 1)" "$(msg_of)"

# approvals before the loop survive its start
printf '{ "slug": "demo", "size": "normal", "base": "main" }\n' > "$a/.scratch/gates.json"
hook post-tool "$(payload "$a" PostToolUse Bash '{"command":"ls"}' '{"stdout":""}')"
check "approvals given before the loop started still verify after its init" "$([ "$(mjs 'm.readLog(root).errors.length' "$a")" = 0 ] && [ "$(mjs 'm.approvals(root).length' "$a")" = 5 ] && echo 0 || echo 1)"

# forged approvals
f="$(new_repo forged)"
mkdir -p "$f/.scratch"
printf '{"approvals":[{"stop":"plan","plan_sha":"x"}]}\n' > "$f/.scratch/approvals.json"
check "a hand-written approvals file approves nothing" "$([ "$(mjs "m.hasApproval(root,'plan','x')" "$f")" = false ] && echo 0 || echo 1)"
prompt "$f" "approve plan"
sha="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$f/docs/plans/p.md")"
printf '{"kind":"approval","stop":"pr","head":"forged","seq":9,"prev":"x","mac":"00"}\n' >> "$f/.scratch/.loop/log.jsonl"
check "a forged line in the signed log voids every approval (fail closed)" "$([ "$(mjs "m.hasApproval(root,'plan','$sha')" "$f")" = false ] && [ "$(mjs "m.hasApproval(root,'pr','forged')" "$f")" = false ] && echo 0 || echo 1)"
check "the forged line is reported as a log error" "$([ "$(mjs 'm.approvalReport(root).errors.length > 0' "$f")" = true ] && echo 0 || echo 1)"

# ---- 5. wiring
check "hooks.json wires UserPromptSubmit and ExitPlanMode" "$(node -e '
const h=require(process.argv[1]).hooks;
const ok=JSON.stringify(h.UserPromptSubmit).includes("stage-hook.sh\\\" user-prompt")&&h.PostToolUse.some(e=>e.matcher==="ExitPlanMode"&&JSON.stringify(e).includes("exit-plan"));
process.exit(ok?0:1)' "$plugin/hooks/hooks.json" && echo 0 || echo 1)"
check "feature-loop is model-invocable" "$(grep -q '^disable-model-invocation' "$here/../SKILL.md" && echo 1 || echo 0)"
t="$work/cli"; mkdir -p "$t"
node "$here/timeline.mjs" "$t" "codex" "plan review | done" "x" && node "$here/timeline.mjs" "$t" "codex" "second" ""
check "timeline.mjs appends rows, header once, pipes escaped" "$([ "$(grep -c '^| time UTC' "$t/.scratch/timeline.md")" = 1 ] && [ "$(rows "$t")" = 2 ] && grep -qF 'plan review \| done' "$t/.scratch/timeline.md" && echo 0 || echo 1)"

echo
echo "test-visibility: $total checks, $([ "$fail" = 0 ] && echo 'all passed' || echo 'FAILURES')"
exit "$fail"
