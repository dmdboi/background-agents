# Sandbox execution image for Open-Inspect (Cloudflare Containers / Sandbox SDK).
#
# MUST extend the official cloudflare/sandbox base image: it provides the
# `/container-server/sandbox` control-plane binary (ENTRYPOINT) that
# @cloudflare/sandbox's exec()/createBackup()/restoreBackup()/exposePort()
# talk to over the network, plus the EXPOSE 3000 that wrangler requires to be
# present at build/dev time. A plain python:3.12-slim base (an earlier,
# incorrect version of this file) has no control server at all — the SDK
# would have nothing to connect to. Do not remove/override ENTRYPOINT below.
#
# The base image is Ubuntu 22.04 (not Debian) and ships Node 20 as a raw
# binary at /usr/local/bin/node (not via apt/dpkg) and NO python3 at all.
# Both are handled explicitly below rather than assumed present.
#
# Layer order otherwise mirrors packages/modal-infra/src/images/base.py line
# for line: rarely-changing system packages first, frequently-changing app
# bundling (sandbox_runtime) last, so cache invalidation behaves the same way
# it did under Modal. Do not reorder without checking base.py.
#
# Build context: repo root (needs packages/sandbox-runtime/).
#   docker build -t oi-sandbox -f packages/control-plane/Dockerfile .
#
# Referenced from packages/control-plane/wrangler.jsonc under
# `containers[].image`.

FROM docker.io/cloudflare/sandbox:0.7.0

# OpenCode version to install. Keep in sync with
# packages/modal-infra/src/images/base.py OPENCODE_VERSION.
ARG OPENCODE_VERSION=1.18.11
# code-server version to install (pinned for reproducible images)
ARG CODE_SERVER_VERSION=4.109.5
# agent-browser version to install (pinned for reproducible images)
ARG AGENT_BROWSER_VERSION=0.21.2
# ttyd version to install (pinned for reproducible images)
ARG TTYD_VERSION=1.7.7
ARG TTYD_SHA256=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
# Python version pinned to match sandbox-runtime's pyproject.toml
# `requires-python`. Installed via uv's standalone builds since the base
# image ships no system Python at all.
ARG PYTHON_VERSION=3.12

# --- System packages ---
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
    ca-certificates \
    gnupg \
    openssh-client \
    jq \
    unzip \
    ffmpeg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

# --- Install Python via uv (base image has no system Python) ---
#
# uv's installer is a static binary — it needs no pre-existing Python — so it
# can bootstrap a real interpreter from nothing. `uv python install` then
# fetches a standalone CPython build backing a real venv at /opt/venv.
#
# /opt/venv/bin is put directly on PATH (not symlinked into /usr/local/bin)
# because CPython's venv package resolution depends on sys.executable's
# resolved path finding pyvenv.cfg next to it — an extra symlink hop through
# /usr/local/bin resolves straight past that check to the raw interpreter
# binary and silently loses the venv's site-packages (import pydantic etc.
# would fail despite `python3 --version` still working, since program
# execution via PATH doesn't care about this but package resolution does).
ENV PATH="/opt/venv/bin:${PATH}"
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv python install ${PYTHON_VERSION} \
    && uv venv --python ${PYTHON_VERSION} --seed /opt/venv \
    && python3 --version \
    && pip --version

# --- Install GitHub CLI (for agent-direct GitHub interaction via gh API) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
    > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# --- Install Node.js 22 LTS ---
#
# The base image ships Node 20 as a raw binary tarball extracted straight to
# /usr/local/bin/node (not via apt/dpkg), and /usr/local/bin is early in
# PATH — so the apt-installed Node 22 below would otherwise be silently
# shadowed by the old binary. Remove it explicitly first.
RUN rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && node --version \
    && npm --version

# --- Install pnpm and Bun ---
RUN npm install -g pnpm@latest \
    && pnpm --version \
    && curl -fsSL https://bun.sh/install | bash \
    && echo "export BUN_INSTALL=\"\$HOME/.bun\"" >> /etc/profile.d/bun.sh \
    && echo "export PATH=\"\$BUN_INSTALL/bin:\$PATH\"" >> /etc/profile.d/bun.sh

# --- Install Python tools ---
RUN pip install --no-cache-dir \
    uv \
    httpx \
    websockets \
    "pydantic>=2.0" \
    "PyJWT[crypto]"

# --- Install OpenCode CLI and plugin for custom tools ---
RUN npm install -g opencode-ai@${OPENCODE_VERSION} \
    && (opencode --version || echo 'OpenCode installed') \
    && npm install -g @opencode-ai/plugin@${OPENCODE_VERSION} zod

# Pre-build OpenCode plugin deps into a staging directory.
#
# At boot, _install_tools() copies these into .opencode/ so that OpenCode's
# Npm.install() finds package-lock.json in sync and skips the slow arborist
# reify() call (2-22s) that would otherwise block the first prompt and exceed
# the bridge's HTTP timeout.
#
# Also bake the same tree into OpenCode's GLOBAL config dir. OpenCode installs
# @opencode-ai/plugin into every config directory it discovers -- including
# the global one (HOME=/root, so ~/.config/opencode), which it creates empty
# on startup -- so without this the runtime _seed_global_opencode_deps() pays
# a multi-second node_modules copy on every boot. Baking it makes that seed a
# no-op (it skips when node_modules already exists). See #767 / #790.
RUN mkdir -p /app/opencode-deps \
    && printf '{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"%s"}}' "${OPENCODE_VERSION}" \
    > /app/opencode-deps/package.json \
    && cd /app/opencode-deps && npm install --ignore-scripts --no-audit --no-fund \
    && mkdir -p /root/.config/opencode \
    && cp -a /app/opencode-deps/. /root/.config/opencode/

# --- Install code-server for browser-based VS Code editing (direct .deb from GitHub releases) ---
RUN curl -fsSL -o /tmp/code-server.deb \
    https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb \
    && dpkg -i /tmp/code-server.deb \
    && rm /tmp/code-server.deb \
    && code-server --version

# --- Install ttyd web terminal (direct binary from GitHub releases) ---
RUN curl -fsSL -o /usr/local/bin/ttyd \
    https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64 \
    && echo "${TTYD_SHA256}  /usr/local/bin/ttyd" | sha256sum -c - \
    && chmod +x /usr/local/bin/ttyd \
    && ttyd --version

# --- Install agent-browser CLI and download Chromium ---
RUN npm install -g agent-browser@${AGENT_BROWSER_VERSION} \
    && agent-browser install \
    && agent-browser --version

# --- Create working directories ---
RUN mkdir -p /workspace \
    && mkdir -p /app/plugins \
    && mkdir -p /tmp/opencode

# --- Install the git credential helper shim ---
#
# Each `git` invocation in the sandbox runs this shim, which delegates to the
# sandbox-runtime helper module. The helper talks to the control plane to
# mint fresh per-request credentials, so git operations no longer rely on a
# 1h-TTL token captured at sandbox creation time. Configured at the system
# level so it applies before entrypoint.py has a chance to run (e.g. when
# restoring a snapshot whose first action is a `git fetch`).
RUN printf '%s\n' \
    '#!/bin/sh' \
    'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' \
    > /usr/local/bin/oi-git-credentials \
    && chmod 0755 /usr/local/bin/oi-git-credentials \
    && git config --system credential.helper /usr/local/bin/oi-git-credentials \
    && git config --system credential.useHttpPath true

# --- Environment variables ---
ENV HOME=/root \
    NODE_ENV=development \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH="/opt/venv/bin:/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules

# --- Add sandbox runtime code to the image (provider-agnostic bridge, entrypoint, tools, plugins) ---
#
# This replaces Modal's add_local_dir(). We COPY the package source and
# install it (with its declared dependencies from pyproject.toml) rather than
# just copying files, so the package is importable and its dependency pins
# are honored the same way `uv`/`pip` would resolve them elsewhere.
COPY packages/sandbox-runtime/pyproject.toml /app/sandbox_runtime_src/pyproject.toml
COPY packages/sandbox-runtime/src /app/sandbox_runtime_src/src
RUN pip install --no-cache-dir /app/sandbox_runtime_src \
    && cp -a /app/sandbox_runtime_src/src/sandbox_runtime /app/sandbox_runtime

WORKDIR /workspace
