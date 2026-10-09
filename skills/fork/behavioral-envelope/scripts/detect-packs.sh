#!/usr/bin/env bash
# Select concern packs for a change, the same way every run.
#
# Usage (run from the target repo's root):
#   detect-packs.sh --diff [base]      scan lines added since base (default: merge-base with the default branch),
#                                      including uncommitted and untracked files, excluding .scratch/
#   detect-packs.sh --paths FILE...    scan whole files the change will touch (before code exists; a superset)
#   detect-packs.sh --plan FILE        scan a plain-language request, issue or spec (before the design is chosen)
#   detect-packs.sh --stdin            scan a unified diff read from stdin
#   detect-packs.sh --list             print every pack name
#
# Output: one line per selected pack, "<pack><TAB><evidence>", core first.
# The patterns err toward inclusion: an extra pack costs a few N/A answers, a missed pack costs a bug.
set -euo pipefail

TAB=$'\t'
PACKS="core ui-visual ui-behavior api data outbound inbound-events jobs-time integrations-auth llm retrieval identity-access files personal-data infra-config dependencies money"

# Whole-word match without \b, which BSD grep does not support in every version.
w() { printf '(^|[^A-Za-z0-9_])(%s)([^A-Za-z0-9_]|$)' "$1"; }

path_pattern() {
  case "$1" in
    ui-visual) echo '\.(css|scss|sass|less|styl)$|tailwind\.config|(^|/)(themes?|tokens|styles?)(/|\.)|(^|/)(locales?|i18n|translations?)/' ;;
    api) echo '(^|/)(routes?|controllers?|handlers?|api|endpoints?)/|route\.(ts|js)$|views\.py$|openapi|swagger|\.proto$|\.graphql$' ;;
    data) echo '(^|/)(migrations?|db|alembic)/|schema\.prisma$|\.sql$|(^|/)models?\.(py|ts|js|rb)$|drizzle|knexfile' ;;
    inbound-events) echo '(^|/)(webhooks?|consumers?|subscribers?)/' ;;
    jobs-time) echo '(^|/)(jobs?|workers?|cron|tasks|schedul[a-z]*)/|(^|/)tasks\.py$' ;;
    identity-access) echo '(^|/)(auth|permissions?|rbac|acl)/' ;;
    infra-config) echo '(^|/)Dockerfile|docker-compose|\.github/workflows/|\.tf$|(^|/)(terraform|helm|k8s|kubernetes|cdk)/|vercel\.json$|netlify\.toml$|fly\.toml$|render\.yaml$|railway\.(json|toml)$|Procfile$|nginx|(^|/)\.env(\.|$)|serverless\.yml$|wrangler\.toml$' ;;
    dependencies) echo '(^|/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$' ;;
    *) echo '' ;;
  esac
}

content_pattern() {
  case "$1" in
    ui-visual) echo "#[0-9a-fA-F]{3,8}([^0-9A-Za-z]|$)|rgba?\(|hsla?\(|className=|class=\"|(^|[^a-z-])color:|background(-color)?:|--[a-z0-9-]+:|dark:|@media|font-(size|weight|family)|(margin|padding)(-[a-z]+)?:|z-index|$(w 'theme|tokens?')" ;;
    ui-behavior) echo 'onSubmit|onClick|onChange|<form|useState|useEffect|useMutation|useQuery|fetch\(|axios|v-model|addEventListener|localStorage|sessionStorage|navigator\.|WebSocket|EventSource|dangerouslySetInnerHTML|innerHTML|v-html' ;;
    api) echo 'app\.(get|post|put|patch|delete)\(|router\.(get|post|put|patch|delete|route)|@(app|router|api)\.(get|post|put|patch|delete|route)|@(Get|Post|Put|Patch|Delete|Request)Mapping|@Controller|export (async )?function (GET|POST|PUT|PATCH|DELETE)|express\(|fastapi|flask|HttpResponse|res\.status\(|NextResponse|APIRouter|ResponseWriter|HandleFunc|http\.Handle|gin\.Context|echo\.Context' ;;
    data) echo "CREATE TABLE|ALTER TABLE|DROP (TABLE|COLUMN|INDEX)|CREATE (UNIQUE )?INDEX|INSERT INTO|UPDATE [a-z_\"]+ SET|DELETE FROM|\.(insert|update|upsert|delete|save|create|bulkCreate|bulk_(create|update)|createMany|updateMany)!?\(|objects\.(create|filter|get)|transaction|prisma\.|knex|sequelize|typeorm|sqlalchemy|session\.(add|commit)|db\.(query|exec|execute)|addColumn|createTable|op\.(add_column|create_table|drop_column)|$(w 'drizzle|mongoose|redis')" ;;
    outbound) echo "sendgrid|from .resend.|new Resend\\(|resend\\.emails|postmark|nodemailer|smtp|mailgun|sesv2|ses\\.send|SendRawEmail|SendEmail|send_?mail|send_?email|sendMessage|twilio|gmail\.users\.messages\.send|chat\.postMessage|chat_postMessage|$(w 'fcm|apns')|push_?notification|List-Unsubscribe|outbound_?webhook" ;;
    inbound-events) echo 'webhook|x-hub-signature|stripe-signature|svix|signing_?secret|construct_?event|constructEvent|on_?message|onMessage|on_?event|consumer|ReadMessage|\.consume\(|\.subscribe\(|sqs|pubsub|kafka|rabbitmq|amqp|event_?type|eventType' ;;
    jobs-time) echo "cron|schedule|setInterval|setTimeout|$(w 'queue|worker|bull|bullmq|celery|sidekiq|temporal|inngest|apscheduler|utc|DST')|shared_task|\.delay\(|\.apply_async\(|trigger\.dev|sleep\(|time_?zone|tzinfo|datetime|new Date\(|Date\.now|moment\(|dayjs|luxon|date-fns|toLocale|Intl\.DateTimeFormat|daylight" ;;
    integrations-auth) echo "oauth|refresh_?token|access_?token|client_?secret|api_?key|apiKey|Authorization|Bearer |googleapis|google-auth|salesforce|hubspot|slack_sdk|@slack/|octokit|zapier|graph\.microsoft|requests\.(get|post|put|patch|delete)\(|httpx|fetch\(['\"\`]https?://|axios\.(get|post|put|patch|delete)\(['\"\`]https?://|process\.env\.[A-Z_]*(KEY|TOKEN|SECRET)|os\.environ\[.[A-Z_]*(KEY|TOKEN|SECRET)" ;;
    llm) echo "openai|anthropic|$(w 'claude|gemini|mistral|cohere|groq|bedrock|llm')|chat\.completions|messages\.create|generateText|streamText|generateObject|langchain|llamaindex|@ai-sdk|system_?prompt|(user|prompt)_?template|embedding|tool_?calls?|function_?call" ;;
    retrieval) echo "$(w 'embed|embeddings?|vectors?|rerank|bm25|cosine|chunks?|chunking|crawl|scrape|scraper|pdf')|pgvector|pinecone|weaviate|qdrant|chroma|milvus|faiss|elasticsearch|opensearch|meilisearch|typesense|algolia|similarity|firecrawl|playwright|puppeteer|cheerio|beautifulsoup" ;;
    identity-access) echo "$(w 'roles|user_?role|role_?id|permissions?|tenant|tenants|policy|policies|session|sessions|login|logout|signup|jwt|cookie|RLS|password|passwords|mfa|totp|csrf')|authorize|isAdmin|is_admin|tenant_?id|org_?id|organization_?id|workspace_?id|team_?id|owner_?id|row level security|current_?user|currentUser|getServerSession|sign_?in|bcrypt|argon2" ;;
    files) echo "upload|multer|multipart|formidable|FileReader|putObject|getObject|PutObjectCommand|$(w 's3|blob|mime')|presign|signed_?url|storage\.(from|bucket)|cloudinary|sharp\(|imagemagick|Content-Disposition" ;;
    personal-data) echo "e-?mails?|$(w 'phone|address|dob|ssn|passport|pii|gdpr|ccpa')|first_?name|last_?name|full_?name|firstName|lastName|date_?of_?birth|card_?number|anonymi[sz]e|redact|retention|delete_?user|deleteUser|export_?data" ;;
    infra-config) echo 'process\.env|os\.environ|getenv|Cache-Control|revalidate|cloudflare|certbot|letsencrypt|feature_?flag|featureFlag|launchdarkly|unleash|growthbook|posthog\.isFeatureEnabled' ;;
    dependencies) echo '' ;;
    money) echo "$(w 'price|prices|pricing|amount|amounts|currency|cents|subtotal|invoice|invoices|payment|payments|charge|charges|refund|refunds|payout|payouts|billing|ledger|balance|decimal|quantity|orders|trade|trades|pnl|fx')|bignumber|toFixed\(|Math\.round|order_?id|orderId|place_?order|create_?order|exchange_?rate|stripe\." ;;
    *) echo '' ;;
  esac
}

# Plain-language triggers, used only in --plan mode, so a request such as "send follow-ups nightly" selects packs
# before any code or file exists.
plan_pattern() {
  case "$1" in
    ui-visual) echo "$(w 'colou?rs?|themes?|dark mode|styles?|styling|layout|fonts?|icons?|logo|brand|design tokens?|css|spacing|responsive|translations?|locali[sz]ation|i18n|accessibility|contrast')" ;;
    ui-behavior) echo "$(w 'forms?|buttons?|pages?|screens?|modal|editor|inputs?|dashboard|ui|frontend|front-end|clicks?|drag|real-time|realtime|live updates?|autosave|drafts?|inbox|composer|widget')" ;;
    api) echo "$(w 'api|apis|endpoints?|routes?|rest|graphql|rpc|sdk|public interface')" ;;
    data) echo "$(w 'database|db|tables?|columns?|schema|migrations?|migrate|stores?|persist|records?|backfill|indexes|rename|postgres|mysql|sql')" ;;
    outbound) echo "$(w 'e-?mails?|sms|text messages?|push notifications?|notify|notifications?|send|sends|sending|sequences?|follow-?ups?|outreach|newsletters?|campaigns?|invites?|reset links?|magic links?')" ;;
    inbound-events) echo "$(w 'webhooks?|events?|callbacks?|listen|subscribe|subscriptions? events|queues?|streams?|ingest|incoming|replies|bounces?')" ;;
    jobs-time) echo "$(w 'schedules?|scheduled|scheduling|cron|nightly|daily|weekly|hourly|background|jobs?|workers?|retry|retries|time ?zones?|deadlines?|reminders?|snooze|delays?|recurring|pipelines?|batch|expir(e|es|y|ation)|every (second|minute|hour|day|week|month)|per (minute|hour|day)')" ;;
    integrations-auth) echo "$(w 'integrations?|integrate|oauth|connect|connected|hubspot|salesforce|gmail|outlook|slack|stripe|google|api keys?|tokens?|third-party|third party|providers?|crm|exchange|broker')" ;;
    llm) echo "$(w 'ai|agents?|llm|models?|gpt|claude|gemini|prompts?|generate|generated|generates|drafts?|summari[sz]e|classif(y|ies|ier)|copilot|assistant|chatbot|rag')" ;;
    retrieval) echo "$(w 'search|rag|knowledge base|embeddings?|vectors?|retriev(e|al)|scrape|crawl|pdfs?|documents?|docs|semantic|citations?')" ;;
    identity-access) echo "$(w 'users?|accounts?|teams?|workspaces?|tenants?|organi[sz]ations?|orgs?|roles?|permissions?|admins?|login|log in|sign in|sign-in|signup|sign up|passwords?|sso|mfa|share|sharing|access|customers?')" ;;
    files) echo "$(w 'uploads?|files?|attachments?|images?|photos?|documents?|pdfs?|csv|exports?|imports?|downloads?|avatars?')" ;;
    personal-data) echo "$(w 'e-?mails?|phones?|names?|contacts?|address(es)?|personal|pii|gdpr|delete (my )?account|profiles?|leads?|prospects?|customers?|users?')" ;;
    infra-config) echo "$(w 'deploys?|deployed|deploying|deployments?|zero.downtime|secrets?|api keys?|infrastructure|environments?|config|configuration|feature flags?|rollout|cdn|cache|caching|domains?|dns|ssl|docker|kubernetes|ci|staging|scale|scaling')" ;;
    dependencies) echo "$(w 'library|libraries|packages?|dependency|dependencies|upgrade|bump|npm|pip|sdk version')" ;;
    money) echo "$(w 'price|prices|pricing|billing|payments?|pay|charges?|invoices?|refunds?|subscriptions?|seats?|plans?|checkout|orders?|trades?|trading|quant|portfolio|currency|revenue|credits?|balances?|payouts?|fills?|positions?')" ;;
    *) echo '' ;;
  esac
}

# Corpus lines: "FILE<TAB>path" and "LINE<TAB>path:lineno<TAB>content".
# Lines that are only a comment are skipped: a comment saying "balance the columns" is not money code.
COMMENT_ONLY='^[[:space:]]*(//|#[[:space:]!]|#$|--[[:space:]]|/[*]|[*][[:space:]/]|[*]$|<!--)'

corpus_from_diff() {
  awk -v T="$TAB" -v C="$COMMENT_ONLY" '
    /^\+\+\+ \/dev\/null/ { file=""; next }
    /^\+\+\+ / { file=substr($0, 5); sub(/\t.*$/, "", file); sub(/^b\//, "", file); print "FILE" T file; next }
    /^--- / { next }
    /^@@/ { s=$0; sub(/^@@ -[0-9,]+ \+/, "", s); sub(/[ ,].*$/, "", s); ln=s+0; next }
    /^\+/ { line=substr($0, 2); if (file != "" && line !~ C) { print "LINE" T file ":" ln T line }; ln++; next }
    /^ / { ln++; next }
  '
}

corpus_from_plan() {
  printf 'FILE%splan\n' "$TAB"
  awk -v T="$TAB" '{ print "LINE" T "plan:" NR T $0 }' "$1"
}

corpus_from_paths() {
  for p in "$@"; do
    printf 'FILE%s%s\n' "$TAB" "$p"
    if [ -f "$p" ] && grep -Iq . "$p" 2>/dev/null; then
      awk -v T="$TAB" -v f="$p" -v C="$COMMENT_ONLY" '$0 !~ C { print "LINE" T f ":" NR T $0 }' "$p"
    fi
  done
}

default_base() {
  local head ref
  head=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  for ref in $head origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$ref" >/dev/null; then
      git merge-base HEAD "$ref"
      return 0
    fi
  done
  return 1
}

# The envelope itself lives in .scratch/; scanning it would select packs from its own words.
corpus_from_git() {
  local base="$1"
  git diff --unified=0 --no-color "$base" -- . ':(exclude).scratch' | corpus_from_diff
  git ls-files --others --exclude-standard -- . ':(exclude).scratch' | while IFS= read -r f; do corpus_from_paths "$f"; done
}

# Packs that come with another: a change that moves money stores it, a received event arrives at an endpoint.
# Applied after detection so the result does not depend on how the request was worded.
implied_by() {
  case "$1" in
    money) echo "data api personal-data" ;;
    inbound-events) echo "api data" ;;
    outbound) echo "data" ;;
    identity-access) echo "api data" ;;
    jobs-time) echo "data" ;;
    integrations-auth) echo "data" ;;
    retrieval) echo "data" ;;
    files) echo "data" ;;
    llm) echo "data" ;;
    *) echo "" ;;
  esac
}

add_implied() {
  local selected="$1" line pack extra out="$1"
  while IFS= read -r line; do
    pack=${line%%"$TAB"*}
    for extra in $(implied_by "$pack"); do
      if ! printf '%s\n' "$out" | cut -f1 | grep -qx "$extra"; then
        out=$(printf '%s\n%s%simplied by %s' "$out" "$extra" "$TAB" "$pack")
      fi
    done
  done <<< "$selected"
  # Print in the canonical pack order.
  for pack in $PACKS; do printf '%s\n' "$out" | awk -F "$TAB" -v p="$pack" '$1 == p { print; exit }'; done
}

select_packs() {
  local corpus="$1" pack pp cp hit loc text
  printf 'core%salways\n' "$TAB"
  for pack in $PACKS; do
    [ "$pack" = core ] && continue
    hit=""
    pp=$(path_pattern "$pack")
    if [ -n "$pp" ]; then
      hit=$(printf '%s\n' "$corpus" | grep -E "^FILE${TAB}" | cut -f2 | grep -E -i -m1 -e "$pp" || true)
      [ -n "$hit" ] && hit="path $hit"
    fi
    cp=$(content_pattern "$pack")
    if [ -z "$hit" ] && [ -n "$cp" ]; then
      hit=$(printf '%s\n' "$corpus" | grep -E "^LINE${TAB}" | cut -f2- | grep -E -i -m1 -e "${TAB}.*(${cp})" || true)
      if [ -n "$hit" ]; then
        loc=${hit%%"$TAB"*}
        text=${hit#*"$TAB"}
        text=$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' | cut -c1-100)
        hit="$loc $text"
      fi
    fi
    if [ -z "$hit" ] && [ "$PLAN_MODE" = 1 ]; then
      cp=$(plan_pattern "$pack")
      if [ -n "$cp" ]; then
        hit=$(printf '%s\n' "$corpus" | grep -E "^LINE${TAB}" | cut -f2- | grep -E -i -m1 -e "${TAB}.*(${cp})" || true)
        if [ -n "$hit" ]; then
          loc=${hit%%"$TAB"*}
          text=${hit#*"$TAB"}
          text=$(printf '%s' "$text" | sed -e 's/^[[:space:]]*//' | cut -c1-100)
          hit="$loc $text"
        fi
      fi
    fi
    if [ -n "$hit" ]; then printf '%s%s%s\n' "$pack" "$TAB" "$hit"; fi
  done
  return 0
}

PLAN_MODE=0
mode="${1:-}"
case "$mode" in
  --plan)
    shift
    [ "$#" -eq 1 ] && [ -f "$1" ] || { echo "detect-packs: --plan needs one readable file" >&2; exit 2; }
    PLAN_MODE=1
    corpus=$(corpus_from_plan "$1") ;;
  --list) for p in $PACKS; do echo "$p"; done; exit 0 ;;
  --stdin) corpus=$(corpus_from_diff) ;;
  --paths)
    shift
    [ "$#" -gt 0 ] || { echo "detect-packs: --paths needs at least one file" >&2; exit 2; }
    corpus=$(corpus_from_paths "$@") ;;
  --diff)
    shift
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "detect-packs: --diff must run inside the target git repo" >&2; exit 2; }
    if [ "$#" -gt 0 ]; then base="$1"; else base=$(default_base) || { echo "detect-packs: no default branch found; pass a base: --diff <base>" >&2; exit 2; }; fi
    git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || { echo "detect-packs: base '$base' is not a commit" >&2; exit 2; }
    corpus=$(corpus_from_git "$base") ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

add_implied "$(select_packs "$corpus")"
