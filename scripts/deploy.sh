#!/usr/bin/env bash
# Routine deploy: apply any new D1 migrations, then build and deploy all
# four Workers. Unlike setup.sh, this does NOT touch R2/KV/queue provisioning
# or secrets — those change rarely and are handled by setup.sh (run it once
# at onboarding time, or again if you add a new binding/secret).
#
# Requires: wrangler (npx wrangler --version), an authenticated
# `wrangler login` session (or CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
# in the environment).
#
# Usage: ./scripts/deploy.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WRANGLER="npx wrangler"
MIGRATIONS_DIR="$REPO_ROOT/packages/control-plane/migrations"
D1_DATABASE_NAME="open-inspect"

step() {
  echo ""
  echo "--- $1 ---"
}

step "1/2 D1 migrations"
bash "$REPO_ROOT/scripts/d1-migrate.sh" "$D1_DATABASE_NAME" "$MIGRATIONS_DIR"

step "2/2 Deploy Workers"

echo "Building and deploying control-plane..."
npm run build -w @open-inspect/control-plane
(cd packages/control-plane && $WRANGLER deploy)

echo "Building and deploying slack-bot..."
npm run build -w @open-inspect/slack-bot
(cd packages/slack-bot && $WRANGLER deploy)

echo "Building and deploying github-bot..."
npm run build -w @open-inspect/github-bot
(cd packages/github-bot && $WRANGLER deploy)

echo "Building and deploying web..."
echo "  (NEXT_PUBLIC_* vars are inlined at build time — see comment in"
echo "  packages/web/wrangler.toml. Export them before this script if you"
echo "  need non-default values; falling back to wrangler.toml's [vars] here.)"
npm run build -w @open-inspect/shared
npm run build:cloudflare -w @open-inspect/web
(cd packages/web && npx opennextjs-cloudflare deploy)

echo ""
echo "=============================================================="
echo " Deploy complete."
echo "=============================================================="
