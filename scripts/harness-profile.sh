#!/usr/bin/env bash
# Build a throwaway DSH home whose web profile mirrors the platform image:
# the profile bundles + the platform's inserted plugin rows, installed from the
# local workspace with the same pnpm layout the Dockerfile uses.
#
# Usage: bash scripts/harness-profile.sh <harness-dir> [dsh-version]
set -euo pipefail

HARNESS="${1:?usage: harness-profile.sh <harness-dir> [dsh-version]}"
DSH_VERSION="${2:-0.1.5-rc.1}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
STORE="${DSH_STORE_DIR:-/home/ovizro/Code/.pnpm-store}"

rm -rf "$HARNESS"
mkdir -p "$HARNESS/home"
export DSH_HOME="$HARNESS/home"

# 1. let dsh create the profile skeletons
dsh --profile web --dump-default-config > "$HARNESS/web-default.yml" 2> "$HARNESS/web-init.err"
dsh --profile headless --dump-default-config > "$HARNESS/headless-default.yml" 2> "$HARNESS/headless-init.err"

PROFILE="$DSH_HOME/profiles/web"
HEADLESS="$DSH_HOME/profiles/headless"

# 2. install the runtime packages exactly like docker/dsh-web-platform.Dockerfile
DSH_RUNTIME_DEPS=(
  "@deepseek-ai/dsh-storage@${DSH_VERSION}"
  "@deepseek-ai/dsh-storage-domain@${DSH_VERSION}"
  "@deepseek-ai/dsh-session-persistence@${DSH_VERSION}"
  "@deepseek-ai/dsh-session@${DSH_VERSION}"
  "@deepseek-ai/dsh-llm@${DSH_VERSION}"
  "@deepseek-ai/dsh-scope@${DSH_VERSION}"
  "@deepseek-ai/dsh-http-proxy@${DSH_VERSION}"
  "@deepseek-ai/dsh-session-format-catalog@${DSH_VERSION}"
  "@kubernetes/client-node"
)

pnpm --dir "$PROFILE" --store-dir "$STORE" add -w \
  "${DSH_RUNTIME_DEPS[@]}" \
  "file:$REPO/packages/auth-oidc" \
  "file:$REPO/packages/fs-k8s" \
  "file:$REPO/packages/subprocess-k8s" \
  "file:$REPO/packages/workspace-k8s" \
  "file:$REPO/packages/workspace-picker" \
  "file:$REPO/packages/session-persistence-rdb" \
  "file:$REPO/packages/storage-db" \
  "file:$REPO/packages/platform-domain" \
  "file:$REPO/vendor/dsh-web-auth" \
  > "$HARNESS/web-add.log" 2>&1

pnpm --dir "$HEADLESS" --store-dir "$STORE" add -w \
  "${DSH_RUNTIME_DEPS[@]}" \
  "file:$REPO/packages/fs-k8s" \
  "file:$REPO/packages/subprocess-k8s" \
  "file:$REPO/packages/workspace-k8s" \
  "file:$REPO/packages/session-persistence-rdb" \
  "file:$REPO/packages/storage-db" \
  "file:$REPO/packages/platform-domain" \
  > "$HARNESS/headless-add.log" 2>&1

# 3. the platform's client bundle + profile patch layer
node "$REPO/scripts/enable-workspace-ui.mjs" "$PROFILE"
cp "$REPO/docker/profiles/web.cordis.patch.yml" "$PROFILE/cordis.patch.yml"
cp "$REPO/docker/profiles/headless.cordis.patch.yml" "$HEADLESS/cordis.patch.yml"

# 4. fail loudly when a plugin cannot actually be imported from the profile:
#    `--dump-config` composes configuration without importing plugin bodies, so
#    a missing RUNTIME peer only shows up here (or at boot, in production).
node "$REPO/scripts/check-plugin-imports.mjs" "$PROFILE"
node "$REPO/scripts/check-plugin-imports.mjs" "$HEADLESS"

# 4b. the vendored webserver fork must still be the official file plus the
#     request-gate extension; a DSH bump that edits the webserver fails here.
DSH_BIN="$(readlink -f "$(command -v dsh)")"      # …/dsh/lib/bin.js
DSH_PKG="$(dirname "$(dirname "$DSH_BIN")")"      # …/@deepseek-ai/dsh
node "$REPO/scripts/check-webserver-fork.mjs" "$DSH_PKG/node_modules/@deepseek-ai"

# 5. dev-only: the deployment does NOT install dsh-client-connection into the
#    profile (the CLI ships it as a bundle layer and patch-dsh.mjs patches that
#    copy), but scripts/smoke-web-trust.mjs needs a local copy to patch and
#    import. Harmless here because the harness is never booted as a deployment.
pnpm --dir "$PROFILE" --store-dir "$STORE" add -w \
  "@deepseek-ai/dsh-client-connection@${DSH_VERSION}" \
  > "$HARNESS/smoke-add.log" 2>&1

echo "harness ready: $HARNESS"
