# Getting Started with Open-Inspect

This guide walks you through deploying your own instance of Open-Inspect using `wrangler`.

> Looking for local development setup (without full infra deployment)? Start with
> [SETUP_GUIDE.md](./SETUP_GUIDE.md).

> **Important**: This system is designed for **single-tenant deployment only**. All users share the
> same GitHub App credentials and can access any repository the App is installed on. See the
> [Security Model](../README.md#security-model-single-tenant-only) for details.

---

## Overview

Open-Inspect deploys entirely to Cloudflare — control plane, web app, bot Workers, and the sandbox
execution backend (Cloudflare Containers via the Sandbox SDK) all run as Cloudflare Workers/
Containers in one account. There is no separate sandbox provider to choose and no separate web
hosting provider to choose.

| What                                          | How it's created                                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1 database, R2 bucket, KV namespaces, queues | `./scripts/setup.sh` (idempotent — creates if missing, skips if present)                                           |
| Control plane, slack-bot, github-bot Workers  | `wrangler deploy`, run by `scripts/setup.sh`                                                                       |
| Web app (Next.js via OpenNext)                | `npx opennextjs-cloudflare deploy`, run by `scripts/setup.sh`                                                      |
| Sandbox execution image                       | `packages/control-plane/Dockerfile`, built as part of control-plane's `wrangler deploy` via the `containers` block |
| Secrets                                       | `wrangler secret put`, run by `scripts/setup.sh` (auto-generated internal secrets + prompted operator credentials) |

**Your job**: Create accounts, gather credentials, fill in the non-secret placeholders in each
package's `wrangler.jsonc`/`wrangler.toml`, and run `./scripts/setup.sh`. **`scripts/setup.sh`'s
job**: Provision Cloudflare resources, push secrets, and deploy every Worker.

---

## Prerequisites

### Required Accounts

Create accounts on these services before continuing:

| Service                                          | Purpose                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| [Cloudflare](https://dash.cloudflare.com)        | Everything — Workers, Containers, D1, R2, KV, queues |
| [GitHub](https://github.com/settings/developers) | OAuth + repository access                            |
| [Anthropic](https://console.anthropic.com)       | Claude API                                           |
| [Slack](https://api.slack.com/apps) _(optional)_ | Slack bot integration                                |
| GitHub App Webhooks _(optional)_                 | GitHub bot (PR reviews)                              |

### Required Tools

```bash
# Node.js (22+)
brew install node@22

# jq and openssl (used by scripts/setup.sh)
brew install jq openssl

# Wrangler CLI (or use `npx wrangler` throughout — scripts/setup.sh uses npx)
npm install -g wrangler
```

---

## Step 1: Fork the Repository

Fork [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) to your GitHub
account or organization.

```bash
# Clone your fork
git clone https://github.com/YOUR-USERNAME/background-agents.git
cd background-agents
npm install

# Build the shared package (required before building any other package)
npm run build -w @open-inspect/shared
```

---

## Step 2: Authenticate Cloudflare

`scripts/setup.sh` needs an authenticated `wrangler` session. Either works:

```bash
npx wrangler login
```

or, for non-interactive/CI use:

```bash
export CLOUDFLARE_API_TOKEN="your-cloudflare-api-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
```

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. **Note your Account ID** (visible in the dashboard URL or account overview)
3. **Note your Workers subdomain**: Go to Workers & Pages → Overview, look in the **bottom-right**
   of the panel for `*.YOUR-SUBDOMAIN.workers.dev`
4. **Create API Token** at [API Tokens](https://dash.cloudflare.com/profile/api-tokens):
   - Use template: "Edit Cloudflare Workers"
   - Verify it has these permissions:
     - Account | Workers KV Storage | Edit (should be included with template)
     - Account | Workers R2 Storage | Edit (should be included with template)
     - Account | D1 | Edit
     - Account | Queues | Edit (required for durable image-build finalization and Slack completion
       delivery)
   - Set "Account Resources" to include your account
   - Click "Continue to summary" and "Update token"
5. **Enable R2**: Must add payment info, but first 10 GB/month is free

Verify with:

```bash
npx wrangler whoami
```

---

## Step 3: Create GitHub App

Every deployment needs **one GitHub App** for repository access. The same App can also provide
GitHub OAuth sign-in, but its client pair is optional when Google is the only sign-in provider.

1. Go to [GitHub Apps](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in the basics:
   - **Name**: `Open-Inspect-YourName` (must be globally unique)
   - **Homepage URL**: Your web app URL —
     `https://open-inspect-web-{deployment_name}.{your-subdomain}.workers.dev` (or your custom
     domain if you configure one — see
     [Optional: custom domain](#optional-serve-the-web-app-on-a-custom-domain))
   - **Webhook**: Uncheck "Active" (not needed unless the GitHub bot is enabled — see Step 8)
4. If enabling GitHub sign-in, configure **Identifying and authorizing users** (OAuth):
   - **Callback URL**: `{your-web-app-url}/api/auth/callback/github`

   > **Important**: The callback URL must match your deployed web app URL exactly. The
   > `{deployment_name}` prefix in the URL comes from each Worker's `name` field in its
   > `wrangler.jsonc`/`wrangler.toml` (default `open-inspect-*`).

   > **Keep "User-to-server token expiration" active** (GitHub App → **Optional Features**; it is
   > the default for newly created Apps, but activate it if yours predates that default). Expiring
   > user tokens are what make GitHub return a **refresh token** at sign-in, and Open-Inspect stores
   > that per-user credential so sessions clone, commit, and push **as the signed-in user**. With
   > expiration deactivated — or on an **OAuth App**, which never issues a refresh token — no
   > per-user credential is captured and sessions fall back to the shared GitHub App **bot**
   > identity for repository access.

5. Set **Repository permissions**:
   - Contents: **Read & Write**
   - Issues: **Read & Write** _(required if enabling GitHub bot)_
   - Pull requests: **Read & Write**
   - Metadata: **Read-only**
6. If using `ALLOWED_GITHUB_ORGS`, set **Organization permissions**:
   - Members: **Read-only**
   - For existing GitHub Apps, republish the permission change and request/approve installation
     updates before testing org membership sign-in.
7. If GitHub sign-in uses `ALLOWED_EMAILS` or `ALLOWED_EMAIL_DOMAINS`, set **Account permissions**:
   - Email addresses: **Read-only** _(without it the app cannot read verified emails and those
     allowlists deny every GitHub sign-in)_
   - For existing GitHub Apps, republish the permission change and request/approve installation
     updates, otherwise the added permission does not apply to current installs.
8. Click **"Create GitHub App"**
9. Note the **App ID** (top of page). If enabling GitHub sign-in, also note the **Client ID**.
10. If enabling GitHub sign-in, under **"Client secrets"**, click **"Generate a new client secret"**
    and note the **Client Secret**.
11. Scroll down to **"Private keys"** and click **"Generate a private key"** (downloads a .pem file)
12. **Convert the key to PKCS#8 format** (required for Cloudflare Workers):
    ```bash
    openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
      -in ~/Downloads/your-app-name.*.private-key.pem \
      -out private-key-pkcs8.pem
    ```
13. **Install the app** on your account/organization:
    - Click "Install App" in the sidebar
    - Select the repositories you want Open-Inspect to access
14. Note the **Installation ID** from the URL after installing:
    ```
    https://github.com/settings/installations/INSTALLATION_ID
    ```

You should now always have:

- **App ID** (e.g., `123456`)
- **Private Key** (PKCS#8 format, starts with `-----BEGIN PRIVATE KEY-----`)
- **Installation ID** (e.g., `12345678`)

For GitHub sign-in, you should also have:

- **Client ID** (e.g., `Iv1.abc123...`)
- **Client Secret** (e.g., `abc123...`)

### Enable Google Login (Optional)

Google login lets non-developer users (PMs, support agents) sign in without a GitHub account. They
get the same flat access as everyone else; git operations still use the shared GitHub App, and their
PRs fall back to the App bot (no personal GitHub attribution unless the same verified email is also
a linked GitHub identity).

1. In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create an
   **OAuth client ID** of type **Web application**.
2. Add the authorized redirect URI `{your-web-app-url}/api/auth/callback/google`. It must match the
   deployed URL exactly.
3. On the OAuth consent screen, request only the `openid`, `email`, and `profile` scopes — these are
   non-sensitive, so Google requires no app-verification review.
4. Note the **Client ID** and **Client Secret**. The client ID goes in
   `packages/control-plane/wrangler.jsonc` `vars.GOOGLE_CLIENT_ID` (Step 6); the secret is pushed by
   `scripts/setup.sh` (Step 7). Also set at least one allowed user in `ALLOWED_EMAILS` (exact
   addresses) or `ALLOWED_EMAIL_DOMAINS`. Leave `GITHUB_CLIENT_ID` empty for Google-only sign-in, or
   keep it configured to offer both providers.

> **Security note**: Google sign-in is admitted only for **verified** emails that match an
> allowlist. Because addresses on shared domains like `gmail.com` are generic, prefer
> `ALLOWED_EMAILS` (exact match) over `ALLOWED_EMAIL_DOMAINS` for those users.

### Choose Sign-In Providers

A complete credential pair is the enablement policy for each provider — a partial pair (client ID
set, secret blank, or vice versa) is treated as disabled by the control plane.

| Configuration     | GitHub client pair | Google client pair | Compatible admission                                  |
| ----------------- | ------------------ | ------------------ | ----------------------------------------------------- |
| GitHub-only       | Set                | Empty              | GitHub username/org, verified email/domain, or unsafe |
| Google-only       | Empty              | Set                | Verified email/domain, or explicit unsafe allow-all   |
| GitHub and Google | Set                | Set                | Verified email/domain, or explicit unsafe allow-all   |

The GitHub App ID, PKCS#8 private key, and installation ID remain required in all three
configurations because they authorize repository operations; they do not enable GitHub sign-in. The
`/login` page reads the enabled provider set from the control plane on every request.

> **Note**: Review `ALLOWED_USERS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_EMAILS`, and
> `ALLOWED_GITHUB_ORGS` in `packages/control-plane/wrangler.jsonc` carefully — these control who can
> sign in. Leaving all of them empty is rejected unless you explicitly set
> `UNSAFE_ALLOW_ALL_USERS = "true"`. **Allowlists use OR semantics**: matching any configured
> username, email domain, exact email, or active GitHub org membership grants access. Use
> `ALLOWED_EMAILS` for individual users on shared domains (e.g. a specific `person@gmail.com`) where
> `ALLOWED_EMAIL_DOMAINS` would admit too many. `ALLOWED_GITHUB_ORGS` checks membership at sign-in
> only with the signing-in user's OAuth token; existing sessions last until session expiry. The
> `read:org` OAuth scope is requested only when org access is configured, and GitHub Apps using org
> access need Organization permissions: Members read-only.

---

## Step 4: Create Slack App (Optional)

Skip this step if you don't need Slack integration.

### Create the App

1. Go to [Slack API Apps](https://api.slack.com/apps)
2. Click **"Create New App"** → **"From scratch"**
3. Name it (e.g., `Open-Inspect`) and select your workspace

### Configure OAuth & Permissions

1. Go to **OAuth & Permissions** in the sidebar
2. Add **Bot Token Scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `channels:read`
   - `groups:history`
   - `groups:read`
   - `im:history`
   - `im:read`
   - `files:read` (lets the bot read images attached to messages and forward them to sessions)
   - `files:write`
   - `reactions:write`
3. Click **"Install to Workspace"**
4. Note the **Bot Token** (`xoxb-...`)

> **Important**: If you update bot token scopes later, you must **reinstall the app** to your
> workspace for the new permissions to take effect.

### Get Signing Secret

1. Go to **Basic Information**
2. Note the **Signing Secret**

### Event Subscriptions (Configure After Deployment)

Event Subscriptions require the Slack bot Worker to be deployed first for URL verification. You'll
configure this in **Step 7** after running `scripts/setup.sh`.

---

## Step 5: Anthropic API Key

1. Go to [Anthropic Console](https://console.anthropic.com)
2. Create an API key
3. Note the **API Key** (starts with `sk-ant-`)

`ANTHROPIC_API_KEY` is used by slack-bot (for classification/summarization) and is pushed as a
secret by `scripts/setup.sh`.

> **Want to use your OpenAI ChatGPT subscription?** See [Using OpenAI Models](OPENAI_MODELS.md) for
> setup instructions (can be configured after deployment).
>
> **Want to use your xAI SuperGrok subscription?** See
> [Using Grok with a SuperGrok Subscription](GROK_MODELS.md). Grok is opt-in and can also be
> configured after deployment.

---

## Step 6: Fill In Non-Secret Config

`scripts/setup.sh` creates Cloudflare resources and pushes secrets, but it does not template the
plain (non-secret) values in each package's wrangler config — edit these by hand before deploying
(or fork and commit your own values).

### `packages/control-plane/wrangler.jsonc`

Edit the `vars` block:

```jsonc
"vars": {
  "WEB_APP_URL": "https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev",
  "ALLOWED_USERS": "your-github-username",       // comma-separated, or empty
  "ALLOWED_EMAIL_DOMAINS": "",                    // comma-separated, or empty
  "ALLOWED_EMAILS": "",                           // exact addresses, or empty
  "ALLOWED_GITHUB_ORGS": "",                      // comma-separated orgs, or empty
  "UNSAFE_ALLOW_ALL_USERS": "false",
  "WORKER_URL": "https://open-inspect-control-plane-{deployment_name}.YOUR-SUBDOMAIN.workers.dev",
  "DEPLOYMENT_NAME": "{deployment_name}",
  "APP_NAME": "Open-Inspect",
  "SANDBOX_INACTIVITY_TIMEOUT_MS": "1800000",
  "SANDBOX_PREVIEW_DOMAIN": "",                   // see comment in wrangler.jsonc
  "GITHUB_CLIENT_ID": "Iv1.abc123...",            // blank disables GitHub sign-in
  "GOOGLE_CLIENT_ID": "",                         // blank disables Google sign-in
},
```

Also update the `name` field (and each other Worker's `name`) if you want a deployment name other
than the `open-inspect-*` default — the Worker name is what shows up in every `*.workers.dev` URL
referenced throughout this guide.

### Per-bot wrangler configs

- `packages/slack-bot/wrangler.toml`: `vars.WEB_APP_URL`, `vars.CONTROL_PLANE_URL`,
  `vars.DEPLOYMENT_NAME`, `vars.APP_NAME`. Set `vars.SLACK_TRIGGERS_ENABLED = "true"` only once
  you've reviewed the channel-message trigger behavior.
- `packages/github-bot/wrangler.toml`: `vars.DEPLOYMENT_NAME`, `vars.APP_NAME`,
  `vars.GITHUB_BOT_USERNAME` (see Step 8 for how to find this).
- `packages/web/wrangler.toml`: `vars.CONTROL_PLANE_URL`, `vars.NEXT_PUBLIC_WS_URL` (also exported
  as an env var before the build — see the file's own header comment), and optionally
  `NEXT_PUBLIC_APP_NAME` / `NEXT_PUBLIC_APP_SHORT_NAME` / `NEXT_PUBLIC_APP_ICON_URL` for
  whitelabeling.

`scripts/setup.sh` prints the D1 database id and each KV namespace id it creates — paste those into
the matching `database_id`/`id` fields the first time you run it (it tells you exactly which file
and field).

---

## Step 7: Run `./scripts/setup.sh`

With wrangler authenticated (Step 2) and the values from Step 6 filled in, run:

```bash
./scripts/setup.sh
```

You'll be prompted for operator-supplied secrets (leave any blank to skip and set later by hand):
`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_CLIENT_SECRET`,
`GITHUB_WEBHOOK_SECRET`, `GOOGLE_CLIENT_SECRET`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
`ANTHROPIC_API_KEY`. Export any of these as environment variables beforehand to skip their prompt
(also how CI does it — see [Step 10](#step-10-set-up-cicd-optional)).

The script then, in order:

1. Creates the D1 database if missing and applies migrations from
   `packages/control-plane/migrations/`
2. Creates the R2 bucket if missing
3. Creates KV namespaces if missing
4. Creates queues (+ dead-letter queues) if missing
5. Generates (or reuses cached) internal secrets in a gitignored `.secrets` file, and pushes both
   those and the operator-supplied secrets to the right Worker via `wrangler secret put`
6. Builds and deploys control-plane, slack-bot, and github-bot (`npm run build` then
   `wrangler deploy`), then builds and deploys web via
   `npm run build:cloudflare -w @open-inspect/web && npx opennextjs-cloudflare deploy`

It's idempotent — safe to re-run after fixing a missing config value.

---

## Step 7b: Complete Slack Setup (If Using Slack)

Now that the Slack bot worker is deployed, configure the App Home and Event Subscriptions.

### Enable App Home

The App Home provides a settings interface where users can configure their preferred model.

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **App Home**
2. Under **Show Tabs**, toggle **"Home Tab"** to On

### Configure Event Subscriptions

1. Go to [Slack Apps](https://api.slack.com/apps) -> Your Slack App → **Event Subscriptions**
2. Toggle **"Enable Events"** to On
3. Enter **Request URL**:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/events
   ```
4. Wait for the green **"Verified"** checkmark
5. Under **Subscribe to bot events**, add:
   - `app_home_opened` (required for App Home settings)
   - `app_mention`
   - `message.channels` (optional - if you want the bot to see all channel messages)
   - `message.im` (enables direct message support)
6. Click **Save Changes**

### Configure Interactivity

1. Go to **Interactivity & Shortcuts**
2. Toggle **"Interactivity"** to On
3. Enter **Request URL**:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/interactions
   ```
4. Under **Select Menus**, enter **Options Load URL** using the same endpoint:
   ```
   https://open-inspect-slack-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/interactions
   ```
   This is required for searchable Slack repository pickers that use external data sources.
5. Click **Save Changes**

### Invite the Bot to Channels

In Slack, for each channel where you want the bot to respond:

- Type `/invite @YourBotName`, or
- Click the channel name → Integrations → Add apps

The bot only responds to @mentions in channels it has been invited to.

---

## Step 8: Complete GitHub Bot Setup (If Using GitHub Bot)

Now that the GitHub bot worker is deployed, configure the GitHub App for webhook delivery.

### Configure Webhook on GitHub App

1. Go to your [GitHub App settings](https://github.com/settings/apps)
2. Select your Open-Inspect app
3. Under **Webhook**:
   - Check **"Active"**
   - **Webhook URL**:
     ```
     https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github
     ```
   - **Webhook secret**: Enter the `GITHUB_WEBHOOK_SECRET` value from Step 7
4. Under **Subscribe to events**, check:
   - **Pull requests**
   - **Issue comments**
   - **Pull request review comments**
5. Click **Save changes**

### Find Your Bot Username

Your GitHub App's bot username is its slug with `[bot]` appended. You can find it by:

1. Having the bot perform any action (e.g., a PR review)
2. Checking the actor's login in the webhook payload

Or construct it from your App's slug: if your app is named `My-Inspect-App`, the bot username is
`my-inspect-app[bot]`. Set this as `GITHUB_BOT_USERNAME` in `packages/github-bot/wrangler.toml` and
redeploy
(`npm run build -w @open-inspect/github-bot && (cd packages/github-bot && wrangler deploy)`).

### Usage

- **Code Review**: Open a non-draft PR in a repository where auto-review is enabled — it performs an
  automated review
- **Comment Actions**: @mention the bot in a PR comment with instructions (e.g.,
  `@my-app[bot] explain why this test is failing`)

For day-to-day workflows, see [GitHub Integration](./integrations/GITHUB.md).

---

## Step 9: Verify Deployment

```bash
# 1. Control Plane health check (replace {deployment_name} and YOUR-SUBDOMAIN)
curl https://open-inspect-control-plane-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/health

# 2. Web app (should return 200)
curl -I "https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev"
```

There is no separate sandbox-backend health check — sandbox execution runs inside the control plane
Worker's own Durable Objects/Containers, so the control-plane health check above covers it.

### Test the Full Flow

1. Visit your web app URL
2. Sign in with each configured provider
3. Create a new session with a repository
4. Send a prompt and verify the sandbox starts

---

## Step 10: Set Up CI/CD (Optional)

`.github/workflows/ci.yml` already includes a `deploy` job that runs `scripts/setup.sh` on every
push to `main`, gated on lint/typecheck/tests passing. It reads credentials from named GitHub
Actions secrets and caches `.secrets` (the auto-generated internal secrets file) across runs with
`actions/cache` so re-deploys don't rotate them.

Go to your fork's Settings → Secrets and variables → Actions, and add:

| Secret Name                     | Value                                                         |
| ------------------------------- | ------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`          | Your Cloudflare API token                                     |
| `CLOUDFLARE_ACCOUNT_ID`         | Your Cloudflare account ID                                    |
| `OI_GITHUB_APP_ID`              | GitHub App ID                                                 |
| `OI_GITHUB_APP_PRIVATE_KEY`     | GitHub App private key (PKCS#8 format)                        |
| `OI_GITHUB_APP_INSTALLATION_ID` | GitHub App installation ID                                    |
| `OI_GITHUB_CLIENT_SECRET`       | GitHub OAuth client secret (blank if GitHub sign-in disabled) |
| `OI_GITHUB_WEBHOOK_SECRET`      | GitHub webhook secret (blank if GitHub bot disabled)          |
| `OI_GOOGLE_CLIENT_SECRET`       | Google OAuth client secret (blank if Google sign-in disabled) |
| `OI_SLACK_BOT_TOKEN`            | Slack bot token (blank if Slack disabled)                     |
| `OI_SLACK_SIGNING_SECRET`       | Slack signing secret (blank if Slack disabled)                |
| `OI_ANTHROPIC_API_KEY`          | Anthropic API key                                             |

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "..."
gh secret set OI_GITHUB_APP_PRIVATE_KEY < private-key-pkcs8.pem
# ... repeat for the rest
```

Once configured, pushes to `main` automatically re-run `scripts/setup.sh` after CI passes.

---

## Updating Your Deployment

To update after pulling changes from upstream:

```bash
# Pull latest changes
git pull upstream main

# Rebuild shared package if it changed
npm run build -w @open-inspect/shared

# Re-run setup (idempotent — only changes what's needed)
./scripts/setup.sh
```

---

## Troubleshooting

### GitHub App authentication fails

1. Verify the private key is in PKCS#8 format (starts with `-----BEGIN PRIVATE KEY-----`)
2. Check the Installation ID matches your installation
3. Ensure the app has required permissions on the repository
4. Verify the callback URL matches your deployed web app URL exactly

### GitHub OAuth "redirect_uri is not associated with this application"

The callback URL in your GitHub App settings doesn't match your deployed URL. Update the callback
URL to match your web app URL:

```
https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/api/auth/callback/github
```

or your custom domain equivalent if you configured one.

### `wrangler deploy` fails referencing a missing D1/KV id

`scripts/setup.sh` prints the id when it creates a new D1 database or KV namespace — paste it into
the field it names in the relevant `wrangler.jsonc`/`wrangler.toml`, then re-run the script.

### Worker deployment fails / "no such file or directory" for dist/index.js

Build the shared package and the Worker before deploying:

```bash
npm run build -w @open-inspect/shared
npm run build -w @open-inspect/control-plane -w @open-inspect/slack-bot -w @open-inspect/github-bot

# Verify bundles exist
ls packages/control-plane/dist/index.js
ls packages/slack-bot/dist/index.js
ls packages/github-bot/dist/index.js
```

### Slack bot not responding

1. Verify Event Subscriptions URL is verified (green checkmark)
2. Ensure the bot is invited to the channel (`/invite @BotName`)
3. Check that you're @mentioning the bot in your message
4. If you updated bot token scopes, reinstall the app to your workspace

### Slack bot ignores thread context

If the bot doesn't see the original message when tagged in a thread reply:

1. Verify the bot has `channels:history` scope (for public channels) and `groups:history` (for
   private channels). These are required by the `conversations.replies` API to fetch thread
   messages.
2. Verify the bot has `channels:read` and `groups:read` scopes. These are required by
   `conversations.info` to fetch channel name and description for context, and by
   `conversations.list` to populate the automation channel picker. If the picker shows no channels,
   check these scopes and that the bot is invited to the target channel.
3. If you added missing scopes, **reinstall the app** to your workspace for the new permissions to
   take effect.

### Slack image attachment does not reach the agent

1. Verify the bot has the `files:read` scope and reinstall the app after adding it. The
   `files:write` scope is for generated media posted back to Slack, not images sent to the agent.
2. Use PNG, JPEG, WebP, or GIF images no larger than 10 MiB. Open-Inspect forwards at most six
   images per message.
3. In a channel, `@mention` the bot with the image. DMs do not require a mention. Watched-channel
   automations do not forward file attachments.
4. For channel mentions and replies, verify `channels:history` for public channels or
   `groups:history` for private channels. Slack may omit files from the mention event, so the bot
   uses conversation history to retrieve them.
5. Check the Slack thread for a warning about images that were too large or could not be downloaded
   or uploaded. Other images and any text are still sent when possible.

### Slack completion does not attach generated media

1. Verify the bot has the `files:write` scope and reinstall the app after adding it.
2. Confirm the agent registered the image or video as a session artifact; repository files are not
   uploaded automatically.
3. Check that the file is PNG, JPEG, WebP, or MP4 and no larger than 10 MiB. A completion attaches
   at most five files and 25 MiB total; other media remains available through **View Session**.
4. Check Slack workspace policies for disabled uploads, prohibited file types, or exhausted storage.

### GitHub bot not responding to webhooks

1. Verify the webhook URL matches
   `https://open-inspect-github-bot-{deployment_name}.YOUR-SUBDOMAIN.workers.dev/webhooks/github`
2. Check the webhook secret matches the `GITHUB_WEBHOOK_SECRET` pushed by `scripts/setup.sh`
3. Confirm the github-bot Worker is deployed (it deploys unconditionally — there's no enable/disable
   flag anymore, only whether you've wired up the webhook)
4. Check that `GITHUB_BOT_USERNAME` in `packages/github-bot/wrangler.toml` matches your App's bot
   login (e.g., `my-app[bot]`)
5. For PR reviews, ensure auto-review is enabled for the repository and the PR is not a draft
6. For comment actions, ensure the bot is @mentioned in a **PR** comment (not an issue)

### "Model not found" errors

The required LLM API key is likely missing as a global secret. In the web app:

1. Go to **Settings > Secrets**
2. Select **All Repositories (Global)** from the scope dropdown
3. Add the key for your chosen provider (e.g., `ANTHROPIC_API_KEY` for Claude models or
   `DEEPSEEK_API_KEY` for DeepSeek models, or `ZHIPU_API_KEY` for Z.AI Coding Plan models)
4. Click **Save**

See [Secrets Management](SECRETS.md) for more on global and repository secrets.

---

## Security Notes

- **Never commit** `.secrets` (the file `scripts/setup.sh` caches auto-generated internal secrets
  in) to source control — it's already gitignored
- Use GitHub Secrets for CI/CD, not hardcoded values
- Rotate operator-supplied secrets periodically by re-exporting new values and re-running
  `scripts/setup.sh` (it re-pushes any non-blank value you supply)
- Review the [Security Model](../README.md#security-model-single-tenant-only) - this system is
  designed for single-tenant deployment

---

## Optional: serve the web app on a custom domain

By default the web app is served from
`https://open-inspect-web-{deployment_name}.YOUR-SUBDOMAIN.workers.dev`. To use your own hostname,
attach a custom domain to the `open-inspect-web` Worker via the Cloudflare dashboard (Workers &
Pages → your worker → Settings → Domains & Routes) or the Cloudflare API, then:

1. Set `workers_dev = false` in `packages/web/wrangler.toml` so the app has a single canonical
   origin.
2. Update `WEB_APP_URL` in `packages/control-plane/wrangler.jsonc` and the bot wrangler configs to
   the new hostname.
3. Update the GitHub App callback URL (and the Google redirect URI, if Google login is enabled) to
   the new hostname, or sign-in will fail with a redirect URI mismatch.

There is no declarative wrangler config field for attaching a custom domain — `scripts/setup.sh`
does not do this automatically.

---

## Customizing the App Name and Icon (Optional)

Open-Inspect can be whitelabeled by overriding the brand name and logo. Both values are optional and
default to the built-in `Open-Inspect` brand.

Set these in the relevant wrangler configs:

```
# packages/control-plane/wrangler.jsonc, packages/slack-bot/wrangler.toml,
# packages/github-bot/wrangler.toml:
APP_NAME = "Acme Bot"

# packages/web/wrangler.toml (and exported before `npm run build:cloudflare`, per the
# file's header comment, since Next.js inlines NEXT_PUBLIC_* at build time):
NEXT_PUBLIC_APP_NAME = "Acme Bot"
NEXT_PUBLIC_APP_SHORT_NAME = "Acme"
NEXT_PUBLIC_APP_ICON_URL = "/branding/acme-logo.svg"   # or "https://cdn.example.com/logo.svg"
```

`APP_NAME` shows up in the Slack App Home settings page, completion comments, the PR body footer,
and outbound HTTP User-Agent headers. The `NEXT_PUBLIC_*` values control the web tab title, sign-in
page, landing hero, and sidebar header.

After changing the `NEXT_PUBLIC_*` values, rebuild and redeploy the web app
(`npm run build:cloudflare -w @open-inspect/web && (cd packages/web && npx opennextjs-cloudflare deploy)`)
— they're inlined into the client bundle at build time. The bot/control-plane Workers read
`APP_NAME` at request time, so a plain `wrangler deploy` picks it up immediately.

---

## Architecture Reference

For details on the infrastructure components, see:

- [README.md](../README.md) - System architecture overview
- [packages/control-plane/wrangler.jsonc](../packages/control-plane/wrangler.jsonc),
  [packages/web/wrangler.toml](../packages/web/wrangler.toml), and each bot's `wrangler.toml` - the
  authoritative deployment config for each Worker
- [scripts/setup.sh](../scripts/setup.sh) - the full provisioning-and-deploy flow
- [AVAILABLE_MODELS.md](AVAILABLE_MODELS.md) - Supported model list and reasoning efforts
- [OPENAI_MODELS.md](OPENAI_MODELS.md) - Configuring OpenAI Codex models
- [GROK_MODELS.md](GROK_MODELS.md) - Configuring Grok with a SuperGrok subscription
