#!/usr/bin/env bash
# Provision every Cloudflare resource Open-Inspect needs and deploy all
# Workers. This is the wrangler-native replacement for `terraform apply` —
# it is the entire onboarding story, so it errs on the side of clear
# progress messages over cleverness. No retry loops, no error-recovery
# frameworks: check exit codes, fail fast.
#
# Requires: wrangler (npx wrangler --version), jq, openssl, an authenticated
# `wrangler login` session (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# in the environment).
#
# Usage: ./scripts/setup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WRANGLER="npx wrangler"
SECRETS_FILE="$REPO_ROOT/.secrets"
MIGRATIONS_DIR="$REPO_ROOT/packages/control-plane/migrations"

D1_DATABASE_NAME="open-inspect"
R2_BUCKET_NAME="open-inspect-media"

CONTROL_PLANE_WORKER="open-inspect-control-plane"
SLACK_BOT_WORKER="open-inspect-slack-bot"
GITHUB_BOT_WORKER="open-inspect-github-bot"
WEB_WORKER="open-inspect-web"

echo "=============================================================="
echo " Open-Inspect setup — provisioning Cloudflare resources"
echo "=============================================================="

# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

# Print a step header.
step() {
  echo ""
  echo "--- $1 ---"
}

# -----------------------------------------------------------------------
# 1. D1 database + migrations
# -----------------------------------------------------------------------
step "1/6 D1 database"

if $WRANGLER d1 list --json | jq -e --arg name "$D1_DATABASE_NAME" \
  '.[] | select(.name == $name)' >/dev/null; then
  echo "D1 database '$D1_DATABASE_NAME' already exists, skipping create."
else
  echo "Creating D1 database '$D1_DATABASE_NAME'..."
  $WRANGLER d1 create "$D1_DATABASE_NAME"
  echo ""
  echo "IMPORTANT: copy the database_id printed above into"
  echo "  packages/control-plane/wrangler.jsonc -> d1_databases[0].database_id"
  echo "before continuing (or re-run this script after doing so; the"
  echo "migrations step below only needs the database NAME, not the id)."
fi

echo "Applying migrations from $MIGRATIONS_DIR ..."
bash "$REPO_ROOT/scripts/d1-migrate.sh" "$D1_DATABASE_NAME" "$MIGRATIONS_DIR"

# -----------------------------------------------------------------------
# 2. R2 bucket
# -----------------------------------------------------------------------
step "2/6 R2 bucket"

if $WRANGLER r2 bucket list 2>/dev/null | grep -qx "name:.*${R2_BUCKET_NAME}"; then
  echo "R2 bucket '$R2_BUCKET_NAME' already exists, skipping create."
else
  echo "Creating R2 bucket '$R2_BUCKET_NAME'..."
  $WRANGLER r2 bucket create "$R2_BUCKET_NAME"
fi

# -----------------------------------------------------------------------
# 3. KV namespaces
# -----------------------------------------------------------------------
step "3/6 KV namespaces"

# Creates a KV namespace if a namespace with this exact title doesn't
# already exist. Prints its id so the operator can paste it into the
# relevant wrangler config.
create_kv_if_missing() {
  local binding_name="$1"
  local worker_prefix="$2"
  local title="${worker_prefix}-${binding_name}"

  local existing_id
  existing_id="$($WRANGLER kv namespace list | jq -r --arg title "$title" \
    '.[] | select(.title == $title) | .id' | head -n1)"

  if [ -n "$existing_id" ]; then
    echo "KV namespace '$title' already exists (id: $existing_id), skipping create."
  else
    echo "Creating KV namespace '$title'..."
    $WRANGLER kv namespace create "$title"
    echo "  -> copy the id above into the '$binding_name' binding in the relevant wrangler config."
  fi
}

create_kv_if_missing "REPOS_CACHE" "$CONTROL_PLANE_WORKER"
create_kv_if_missing "SLACK_KV" "$SLACK_BOT_WORKER"
create_kv_if_missing "GITHUB_KV" "$GITHUB_BOT_WORKER"

# -----------------------------------------------------------------------
# 4. Queues (+ dead-letter queues)
# -----------------------------------------------------------------------
step "4/6 Queues"

create_queue_if_missing() {
  local queue_name="$1"

  if $WRANGLER queues list 2>/dev/null | awk -F'│' 'NF>1{gsub(/^[ \t]+|[ \t]+$/,"",$3); print $3}' \
    | grep -qx "$queue_name"; then
    echo "Queue '$queue_name' already exists, skipping create."
  else
    echo "Creating queue '$queue_name'..."
    $WRANGLER queues create "$queue_name"
  fi
}

create_queue_if_missing "open-inspect-image-build-finalization"
create_queue_if_missing "open-inspect-image-build-finalization-dlq"
create_queue_if_missing "open-inspect-slack-completion"
create_queue_if_missing "open-inspect-slack-completion-dlq"

echo "Consumers (batch size, retries, DLQ routing) are declared in each"
echo "worker's wrangler config and are attached automatically on 'wrangler deploy'."

# -----------------------------------------------------------------------
# 5. Secrets
# -----------------------------------------------------------------------
step "5/6 Secrets"

# --- 5a. Auto-generated secrets (idempotent via $SECRETS_FILE) ---------
#
# Terraform used `random_password` resources for these; wrangler has no
# equivalent, so we generate them once with openssl and cache the values
# locally so re-running this script doesn't rotate them out from under a
# running deployment. $SECRETS_FILE is untracked (see .gitignore) — treat
# it like any other credentials file (do not commit it, do not share it
# outside this deployment).
touch "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE"

get_or_generate_secret() {
  local name="$1"
  local existing
  existing="$(grep "^${name}=" "$SECRETS_FILE" 2>/dev/null | cut -d= -f2- || true)"
  if [ -n "$existing" ]; then
    echo "$existing"
    return
  fi
  local value
  value="$(openssl rand -hex 32)"
  echo "${name}=${value}" >>"$SECRETS_FILE"
  echo "$value"
}

echo "Generating (or reusing cached) auto-generated secrets in $SECRETS_FILE ..."
BROWSER_AUTH_SECRET="$(get_or_generate_secret BROWSER_AUTH_SECRET)"
TOKEN_ENCRYPTION_KEY="$(get_or_generate_secret TOKEN_ENCRYPTION_KEY)"
REPO_SECRETS_ENCRYPTION_KEY="$(get_or_generate_secret REPO_SECRETS_ENCRYPTION_KEY)"
IMAGE_CALLBACK_TOKEN_PEPPER="$(get_or_generate_secret IMAGE_CALLBACK_TOKEN_PEPPER)"
SERVICE_AUTH_SECRET_WEB="$(get_or_generate_secret SERVICE_AUTH_SECRET_WEB)"
SERVICE_AUTH_SECRET_SLACK_BOT="$(get_or_generate_secret SERVICE_AUTH_SECRET_SLACK_BOT)"
SERVICE_AUTH_SECRET_GITHUB_BOT="$(get_or_generate_secret SERVICE_AUTH_SECRET_GITHUB_BOT)"
# HMAC key for deriving per-sandbox code-server passwords (cloudflare-provider.ts).
# Not tied to any external service, so it's generated the same way as the
# other internal secrets rather than prompted for.
CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET="$(get_or_generate_secret CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET)"

# --- 5b. Operator-supplied secrets (real credentials — never fabricated) ---
#
# Read from environment variables if already set (useful for CI); otherwise
# prompt interactively. Nothing here is invented — an empty prompt leaves
# the secret unset and the corresponding `wrangler secret put` is skipped
# with a warning.
prompt_secret() {
  local var_name="$1"
  local prompt_text="$2"
  local current="${!var_name:-}"
  if [ -n "$current" ]; then
    return
  fi
  # Non-interactive stdin (CI, or run with </dev/null) — there's no one to
  # prompt. `read` would either hang or, on closed/EOF stdin, return a
  # non-zero exit that `set -e` treats as fatal and kills the whole script.
  # Leave the value unset (put_secret skips it with a warning) instead.
  if [ ! -t 0 ]; then
    echo "  (stdin not interactive — leaving $var_name unset; set it as an env var to provide a value)"
    return
  fi
  local value=""
  read -r -s -p "$prompt_text: " value || true
  echo ""
  export "$var_name=$value"
}

echo ""
echo "The following require real operator-supplied values. Set them as"
echo "environment variables before running this script to skip the prompts,"
echo "or enter them now (leave blank to skip and set later by hand):"
echo ""

prompt_secret GITHUB_APP_ID "GITHUB_APP_ID"
prompt_secret GITHUB_APP_PRIVATE_KEY "GITHUB_APP_PRIVATE_KEY (PKCS#8 PEM, single line with \\n)"
prompt_secret GITHUB_APP_INSTALLATION_ID "GITHUB_APP_INSTALLATION_ID"
prompt_secret GITHUB_CLIENT_SECRET "GITHUB_CLIENT_SECRET (blank if GitHub OAuth login is disabled)"
prompt_secret GITHUB_WEBHOOK_SECRET "GITHUB_WEBHOOK_SECRET"
prompt_secret GOOGLE_CLIENT_SECRET "GOOGLE_CLIENT_SECRET (blank if Google login is disabled)"
prompt_secret SLACK_BOT_TOKEN "SLACK_BOT_TOKEN (blank if Slack is disabled)"
prompt_secret SLACK_SIGNING_SECRET "SLACK_SIGNING_SECRET (blank if Slack is disabled)"
prompt_secret ANTHROPIC_API_KEY "ANTHROPIC_API_KEY (used by slack-bot)"

# --- 5c. Push secrets to each worker -----------------------------------
#
# `wrangler secret put` reads the value from stdin. Skips (with a warning)
# any secret whose value is empty rather than pushing a blank value.
put_secret() {
  local worker="$1"
  local name="$2"
  local value="$3"
  if [ -z "$value" ]; then
    echo "  SKIP ${worker}: ${name} (no value provided)"
    return
  fi
  echo "  ${worker}: ${name}"
  printf '%s' "$value" | $WRANGLER secret put "$name" --name "$worker" >/dev/null
}

echo ""
echo "Pushing secrets to control-plane ($CONTROL_PLANE_WORKER)..."
put_secret "$CONTROL_PLANE_WORKER" BROWSER_AUTH_SECRET "$BROWSER_AUTH_SECRET"
put_secret "$CONTROL_PLANE_WORKER" TOKEN_ENCRYPTION_KEY "$TOKEN_ENCRYPTION_KEY"
put_secret "$CONTROL_PLANE_WORKER" REPO_SECRETS_ENCRYPTION_KEY "$REPO_SECRETS_ENCRYPTION_KEY"
put_secret "$CONTROL_PLANE_WORKER" IMAGE_CALLBACK_TOKEN_PEPPER "$IMAGE_CALLBACK_TOKEN_PEPPER"
put_secret "$CONTROL_PLANE_WORKER" SERVICE_AUTH_SECRET_WEB "$SERVICE_AUTH_SECRET_WEB"
put_secret "$CONTROL_PLANE_WORKER" SERVICE_AUTH_SECRET_SLACK_BOT "$SERVICE_AUTH_SECRET_SLACK_BOT"
put_secret "$CONTROL_PLANE_WORKER" SERVICE_AUTH_SECRET_GITHUB_BOT "$SERVICE_AUTH_SECRET_GITHUB_BOT"
put_secret "$CONTROL_PLANE_WORKER" CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET "$CLOUDFLARE_SANDBOX_CODE_SERVER_PASSWORD_SECRET"
put_secret "$CONTROL_PLANE_WORKER" GITHUB_APP_ID "${GITHUB_APP_ID:-}"
put_secret "$CONTROL_PLANE_WORKER" GITHUB_APP_PRIVATE_KEY "${GITHUB_APP_PRIVATE_KEY:-}"
put_secret "$CONTROL_PLANE_WORKER" GITHUB_APP_INSTALLATION_ID "${GITHUB_APP_INSTALLATION_ID:-}"
put_secret "$CONTROL_PLANE_WORKER" GITHUB_CLIENT_SECRET "${GITHUB_CLIENT_SECRET:-}"
put_secret "$CONTROL_PLANE_WORKER" GOOGLE_CLIENT_SECRET "${GOOGLE_CLIENT_SECRET:-}"
put_secret "$CONTROL_PLANE_WORKER" SLACK_BOT_TOKEN "${SLACK_BOT_TOKEN:-}"

echo ""
echo "Pushing secrets to web ($WEB_WORKER)..."
put_secret "$WEB_WORKER" SERVICE_AUTH_SECRET "$SERVICE_AUTH_SECRET_WEB"

echo ""
echo "Pushing secrets to slack-bot ($SLACK_BOT_WORKER)..."
put_secret "$SLACK_BOT_WORKER" SERVICE_AUTH_SECRET "$SERVICE_AUTH_SECRET_SLACK_BOT"
put_secret "$SLACK_BOT_WORKER" SLACK_BOT_TOKEN "${SLACK_BOT_TOKEN:-}"
put_secret "$SLACK_BOT_WORKER" SLACK_SIGNING_SECRET "${SLACK_SIGNING_SECRET:-}"
put_secret "$SLACK_BOT_WORKER" ANTHROPIC_API_KEY "${ANTHROPIC_API_KEY:-}"

echo ""
echo "Pushing secrets to github-bot ($GITHUB_BOT_WORKER)..."
put_secret "$GITHUB_BOT_WORKER" SERVICE_AUTH_SECRET "$SERVICE_AUTH_SECRET_GITHUB_BOT"
put_secret "$GITHUB_BOT_WORKER" GITHUB_APP_ID "${GITHUB_APP_ID:-}"
put_secret "$GITHUB_BOT_WORKER" GITHUB_APP_PRIVATE_KEY "${GITHUB_APP_PRIVATE_KEY:-}"
put_secret "$GITHUB_BOT_WORKER" GITHUB_APP_INSTALLATION_ID "${GITHUB_APP_INSTALLATION_ID:-}"
put_secret "$GITHUB_BOT_WORKER" GITHUB_WEBHOOK_SECRET "${GITHUB_WEBHOOK_SECRET:-}"

# -----------------------------------------------------------------------
# 6. Deploy Workers — delegated to deploy.sh (the migrations-and-deploy-only
#    script used for every routine deploy after this first-time setup).
# -----------------------------------------------------------------------
step "6/6 Deploy Workers"

bash "$REPO_ROOT/scripts/deploy.sh"

echo ""
echo "=============================================================="
echo " Done. Verify each Worker in the Cloudflare dashboard, then"
echo " confirm end-to-end auth (GitHub OAuth, Slack) manually."
echo "=============================================================="
