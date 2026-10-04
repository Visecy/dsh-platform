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
  "file:$REPO/packages/fs-k8s" \
  "file:$REPO/packages/subprocess-k8s" \
  "file:$REPO/packages/workspace-k8s" \
  "file:$REPO/packages/workspace-picker" \
  "file:$REPO/packages/identity-bridge" \
  "file:$REPO/packages/session-persistence-rdb" \
  "file:$REPO/packages/storage-db" \
  "file:$REPO/packages/platform-domain" \
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

# Mirror the image: a custom profile defaults to `patchReload: "live"`, which
# makes the CLI demand the Cordis HMR service at boot. The image sets it to
# "startup" because the patch layer is baked there, so the harness must match or
# it would not be testing the shipped composition.
node -e "
  const fs = require('node:fs');
  for (const p of ['$PROFILE', '$HEADLESS']) {
    const f = p + '/package.json';
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    m.dsh.profile.patchReload = 'startup';
    fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
  }
"

# 4. fail loudly when a plugin cannot actually be imported from the profile:
#    `--dump-config` composes configuration without importing plugin bodies, so
#    a missing RUNTIME peer only shows up here (or at boot, in production).
node "$REPO/scripts/check-plugin-imports.mjs" "$PROFILE"
node "$REPO/scripts/check-plugin-imports.mjs" "$HEADLESS"

# 4b. the loopback half of the deployment precondition is not our own
#     configuration: the official CLI must refuse a non-loopback bind. With the
#     in-process gate gone, that refusal is what keeps the identity headers
#     trustworthy (README 部署硬前提 #2), so assert it against the real CLI.
node "$REPO/scripts/check-loopback-bind.mjs" "$DSH_HOME"

# 5. dev-only: the deployment does NOT install the official host packages into
#    the profile (the CLI ships them as bundle layers and resolves the profile's
#    `webserver` / `connection` rows from there), but scripts/smoke-zero-patch.mjs
#    and scripts/smoke-official-integration.mjs boot that composition directly
#    and need a local, UNPATCHED copy to import. Harmless here because the
#    harness is never booted as a deployment.
pnpm --dir "$PROFILE" --store-dir "$STORE" add -w \
  "@deepseek-ai/dsh-client-connection@${DSH_VERSION}" \
  "@deepseek-ai/dsh-host-webserver@${DSH_VERSION}" \
  "@deepseek-ai/dsh-host-frontend-static@${DSH_VERSION}" \
  > "$HARNESS/smoke-add.log" 2>&1

echo "harness ready: $HARNESS"
