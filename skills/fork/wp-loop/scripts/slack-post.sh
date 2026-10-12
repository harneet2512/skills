#!/usr/bin/env bash
# Send one approved status update to Slack through an incoming webhook (wp-loop rule 7, fork.9.9). Run it only after the
# owner's `post it` for this exact draft. No Claude, no connector: a plain HTTPS POST of the draft's text.
#
#   slack-post.sh <draft.md>
#
# Needs SLACK_WEBHOOK_URL in the environment (a Slack app's incoming webhook for the reviewer's channel). The URL is a
# secret: it is never printed, logged or written to a file. On success it writes <draft.md>.sent (UTC time and the
# sha256 of the text sent) so the record shows what went out; a draft that already has a .sent file is not sent twice.
# Exit codes: 0 sent; 2 usage, missing draft or missing webhook; 3 Slack refused it.
set -uo pipefail

draft="${1:-}"
[ -n "$draft" ] && [ -f "$draft" ] || { echo "slack-post: usage: slack-post.sh <draft.md> (the file must exist)" >&2; exit 2; }
[ -n "${SLACK_WEBHOOK_URL:-}" ] || { echo "slack-post: SLACK_WEBHOOK_URL is not set; give the owner the text to post by hand" >&2; exit 2; }
[ -e "$draft.sent" ] && { echo "slack-post: $draft was already sent ($(head -n 1 "$draft.sent")); edit it into a new draft to send again" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "slack-post: node is required" >&2; exit 2; }

# Node builds the JSON and makes the request, so the text needs no shell escaping and the URL never reaches argv.
result="$(node -e '
  const fs = require("fs"), crypto = require("crypto");
  const text = fs.readFileSync(process.argv[1], "utf8").replace(/\r\n/g, "\n").trim();
  const sha = crypto.createHash("sha256").update(text).digest("hex");
  fetch(process.env.SLACK_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })
    .then(async (r) => { const body = (await r.text()).trim(); process.stdout.write(`${r.status} ${sha} ${body.slice(0, 120)}`); })
    .catch((e) => { process.stdout.write(`000 ${sha} ${e.message}`); });
' "$draft")"
status="${result%% *}"; rest="${result#* }"; sha="${rest%% *}"; body="${rest#* }"
if [ "$status" = 200 ]; then
  printf '%s sha256 %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" > "$draft.sent"
  echo "slack-post: sent $draft (sha256 ${sha:0:12})"
  exit 0
fi
echo "slack-post: Slack refused the post (HTTP $status: $body); nothing was recorded as sent" >&2
exit 3
