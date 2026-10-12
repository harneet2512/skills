#!/usr/bin/env bash
# Tests for slack-post.sh against a local fake webhook (no network, no Slack).
# Run: skills/fork/wp-loop/scripts/test-slack-post.sh
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
pass=0; fail=0
ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s: %s\n' "$1" "$2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "$2"; fi; }

# Fake webhook: answers 200 "ok" on /good, 404 "no_service" elsewhere, and saves each body it gets.
node -e '
  const http = require("http"), fs = require("fs");
  const s = http.createServer((q, r) => { let b = ""; q.on("data", (d) => (b += d)); q.on("end", () => {
    fs.writeFileSync(process.argv[1], b); const good = q.url === "/good";
    r.writeHead(good ? 200 : 404); r.end(good ? "ok" : "no_service"); }); });
  s.listen(0, "127.0.0.1", () => fs.writeFileSync(process.argv[2], String(s.address().port)));
' "$work/body.json" "$work/port" &
srv=$!
trap 'kill $srv 2>/dev/null; rm -rf "$work"' EXIT
for _ in $(seq 1 50); do [ -s "$work/port" ] && break; sleep 0.1; done
port="$(cat "$work/port")"

printf '**#51 PR is open:** https://example.test/pull/1\r\nQuotes "x" and a backslash \\ survive.\n' > "$work/d1.md"
out="$(SLACK_WEBHOOK_URL="http://127.0.0.1:$port/good" bash "$here/slack-post.sh" "$work/d1.md" 2>&1)"; rc=$?
check "sent: exit 0" '[ "$rc" = 0 ]'
printf '**#51 PR is open:** https://example.test/pull/1\nQuotes "x" and a backslash \\ survive.' > "$work/expect.txt"
check "sent: Slack got the text as JSON, CRLF normalised" 'node -e "const fs=require(\"fs\");process.exit(JSON.parse(fs.readFileSync(process.argv[1],\"utf8\")).text===fs.readFileSync(process.argv[2],\"utf8\")?0:1)" "$work/body.json" "$work/expect.txt"'
check "sent: a .sent record with the sha256" 'grep -qE "sha256 [0-9a-f]{64}" "$work/d1.md.sent"'
check "sent: the webhook URL is never printed" '! printf "%s" "$out" | grep -q "127.0.0.1"'
out="$(SLACK_WEBHOOK_URL="http://127.0.0.1:$port/good" bash "$here/slack-post.sh" "$work/d1.md" 2>&1)"; rc=$?
check "the same draft is not sent twice" '[ "$rc" = 2 ] && printf "%s" "$out" | grep -q "already sent"'
printf 'second\n' > "$work/d2.md"
out="$(env -u SLACK_WEBHOOK_URL bash "$here/slack-post.sh" "$work/d2.md" 2>&1)"; rc=$?
check "no webhook: exit 2, says to post by hand, nothing recorded" '[ "$rc" = 2 ] && printf "%s" "$out" | grep -q "by hand" && [ ! -e "$work/d2.md.sent" ]'
out="$(SLACK_WEBHOOK_URL="http://127.0.0.1:$port/bad" bash "$here/slack-post.sh" "$work/d2.md" 2>&1)"; rc=$?
check "Slack refuses: exit 3, nothing recorded, URL not printed" '[ "$rc" = 3 ] && [ ! -e "$work/d2.md.sent" ] && ! printf "%s" "$out" | grep -q "127.0.0.1"'
out="$(SLACK_WEBHOOK_URL="http://127.0.0.1:$port/good" bash "$here/slack-post.sh" "$work/missing.md" 2>&1)"; rc=$?
check "missing draft: exit 2" '[ "$rc" = 2 ]'

echo
echo "test-slack-post: $pass passed, $fail failed"
[ "$fail" = 0 ]
