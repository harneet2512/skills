#!/usr/bin/env bash
# v2 of run-mutants.sh. Differences from v1:
#   - base app is current/ (a snapshot of the improved repo app), not clean/;
#   - patches come from patches/ (four rebased by hand onto the improved app);
#   - every run also runs the app's unit tests (bug-11 is a unit-test catch);
#   - REPEAT_01=n runs bug-01 n times to measure flakiness.
# Writes .scratch/mutant-results.json and .scratch/mutant-results.md next to this script.
#
#   REPEAT_01=5 ./run-mutants-v2.sh          # control + every patch
#   ./run-mutants-v2.sh 08 11                # control + only these
set -uo pipefail

B="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${HARNESS:-$B/../../live-verify/harness/runner.mjs}"
BASE="${BASE:-$B/../../live-verify/bench/inbox-assist}"
export RUNS="${RUNS:-$B/.scratch/runs}"
REPEAT_01="${REPEAT_01:-1}"
mkdir -p "$RUNS"

ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  for p in "$B"/patches/bug-*.patch; do n="$(basename "$p" .patch)"; ids+=("${n#bug-}"); done
fi

run_one() { # <label> <app-dir> <run-dir>
  local label="$1" app="$2" dir="$3"
  mkdir -p "$dir"
  (cd "$dir" && node --no-warnings "$HARNESS" --app "$app" --instances 2 --llm stub > "$dir/console.txt" 2>&1)
  local live=$?
  (cd "$app" && node --no-warnings --test test/*.test.mjs > "$dir/unit.txt" 2>&1)
  local unit=$?
  echo "$label live=$live unit=$unit $(tail -n 1 "$dir/console.txt")"
}

prepare() { # <run-dir> [patch]
  rm -rf "$1" && mkdir -p "$1"
  cp -a "$BASE" "$1/app"
  rm -rf "$1/app/.scratch"
  [ -z "${2:-}" ] && return 0
  patch -p1 -s -d "$1/app" < "$2"
}

prepare "$RUNS/control"
run_one control "$RUNS/control/app" "$RUNS/control"

labels=()
for id in "${ids[@]}"; do
  reps=1
  [ "$id" = "01" ] && reps="$REPEAT_01"
  for r in $(seq 1 "$reps"); do
    label="bug-$id"
    [ "$reps" -gt 1 ] && label="bug-$id#$r"
    dir="$RUNS/${label/\#/-r}"
    if ! prepare "$dir" "$B/patches/bug-$id.patch"; then
      echo "$label: patch did not apply" | tee "$dir/console.txt"
      continue
    fi
    run_one "$label" "$dir/app" "$dir"
    labels+=("$label")
  done
done

node --no-warnings - "$B" "${labels[@]}" <<'EOF'
const fs = require('fs');
const path = require('path');
const [B, ...labels] = process.argv.slice(2);
const v1 = JSON.parse(fs.readFileSync(path.join(B, 'mutant-results-v1.json'), 'utf8'));
const v1Caught = Object.fromEntries(v1.mutants.map((m) => [m.id, m]));
function load(dir) {
  const live = path.join(dir, '.scratch', 'live');
  if (!fs.existsSync(live)) return null;
  const runs = fs.readdirSync(live).sort();
  const file = path.join(live, runs[runs.length - 1], 'report.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}
function unitFailures(dir) {
  const f = path.join(dir, 'unit.txt');
  if (!fs.existsSync(f)) return null;
  return [...fs.readFileSync(f, 'utf8').matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]);
}
function summarize(label, dir) {
  const r = load(dir);
  const unit = unitFailures(dir) ?? [];
  if (!r) return { id: label, ran: false, failing: [], unit, note: 'no report' };
  const failing = r.scenarios.filter((s) => s.result !== 'pass').map((s) => ({
    file: s.file, failedAssertions: (s.assertions ?? []).filter((a) => a.pass === false).map((a) => a.name).slice(0, 5),
  }));
  return { id: label, ran: true, liveCaught: failing.length > 0, unitCaught: unit.length > 0, totals: r.totals, durationMs: r.durationMs, failing, unit };
}
const dirOf = (label) => path.join(process.env.RUNS || path.join(B, '.scratch', 'runs'), label.replace('#', '-r'));
const control = summarize('control', dirOf('control'));
const mutants = labels.map((l) => summarize(l, dirOf(l)));
fs.writeFileSync(path.join(B, '.scratch/mutant-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), control, mutants }, null, 2) + '\n');
const short = (f) => f.replace(/\.mjs$/, '');
const v1col = (id) => { const m = v1Caught[id.split('#')[0]]; return m ? (m.caught ? `yes (${m.failing.map((f) => short(f.file)).join(', ')})` : 'no') : 'n/a'; };
const rows = [
  '| Bug | v1 caught | v2 scenarios | v2 unit tests | v2 failing scenarios |',
  '| --- | --- | --- | --- | --- |',
  `| control | all green | ${control.liveCaught ? 'FAILED' : 'all green'} | ${control.unitCaught ? 'FAILED' : 'all green'} | ${control.failing.map((f) => short(f.file)).join(', ') || '(none)'} |`,
  ...mutants.map((m) => `| ${m.id} | ${v1col(m.id)} | ${m.ran ? (m.liveCaught ? 'yes' : 'no') : 'n/a'} | ${m.unitCaught ? 'yes' : 'no'} | ${m.failing.map((f) => short(f.file)).join(', ') || '(none)'} |`),
];
const firsts = mutants.filter((m) => !m.id.includes('#') || m.id.endsWith('#1'));
const live = firsts.filter((m) => m.liveCaught).length;
const any = firsts.filter((m) => m.liveCaught || m.unitCaught).length;
const reps = mutants.filter((m) => m.id.startsWith('bug-01#'));
const repLine = reps.length > 1 ? `\nbug-01 over ${reps.length} runs: caught by scenarios in ${reps.filter((m) => m.liveCaught).length}/${reps.length}.\n` : '';
fs.writeFileSync(path.join(B, '.scratch/mutant-results.md'), `# Mutant results v2\n\nHarness: live-verify runner, 2 instances, stub LLM, plus the app unit tests, on the repo's inbox-assist app. Patches: patches/ (bug-05, 07, 11, 13 rebased by hand onto the improved app).\n\n${rows.join('\n')}\n\nCaught by scenarios: ${live} of ${firsts.length}. Caught by scenarios or unit tests: ${any} of ${firsts.length}. v1: 11 of 13 by scenarios.\n${repLine}`);
console.log(rows.join('\n'));
console.log(`scenarios ${live}/${firsts.length}, scenarios or unit ${any}/${firsts.length}`);
EOF
