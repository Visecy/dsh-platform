# dsh-web-platform: self-contained control-plane image.
#
# Built from the OFFICIAL npm package (@deepseek-ai/dsh), not a third-party
# image. Follows the reference community Dockerfile's install pattern
# (npm global + --allow-scripts for node-pty/koffi prebuilds) but keeps only
# the headless web runtime — no Chromium/desktop.
#
# Layers:
#   1. ZERO compiled-artifact patches: every @deepseek-ai package ships exactly
#      as npm published it (no compiled-artifact patch script, no webserver
#      fork). The
#      remote-browser transport hook and the launch-token cookie handoff come
#      from @visecy/dsh-identity-bridge, built only on official extension
#      points (webserver/index-inject + authenticatedUrl/authorizeIndex)
#   2. @visecy platform plugins pre-installed into the web + headless profiles
#   3. the oauth2-proxy sidecar (deploy chart) is the deployment's entry point;
#      this image only ever serves that proxy
#
# The baked-in Harness home lives at /opt/dsh-home; the deployment copies it
# into the runtime DSH_HOME (writable volume) on start.
#
# Version pinning: PLUGIN_VERSION is passed by the release workflow from the
# git tag (e.g. v0.1.5 -> 0.1.5), so the installed plugins always match the
# npm versions published by the SAME tag. When unset, pnpm resolves latest.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS installer

ARG DSH_VERSION=0.2.0-rc.2
ARG PNPM_VERSION=10.15.1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global --omit=dev --no-audit --no-fund \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
    && test "$(dsh --version)" = "${DSH_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && npm cache clean --force

FROM ${NODE_IMAGE}

ARG DSH_VERSION=0.2.0-rc.2
ARG PNPM_VERSION=10.15.1
ARG PLUGIN_VERSION

RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
      ca-certificates \
      git \
      procps \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/lib/node_modules/@deepseek-ai

COPY --from=installer /usr/local/lib/node_modules/@deepseek-ai/dsh /usr/local/lib/node_modules/@deepseek-ai/dsh
COPY --from=installer /usr/local/lib/node_modules/pnpm /usr/local/lib/node_modules/pnpm
RUN ln -s ../lib/node_modules/@deepseek-ai/dsh/lib/bin.js /usr/local/bin/dsh \
    && ln -s ../lib/node_modules/pnpm/bin/pnpm.cjs /usr/local/bin/pnpm

USER root

# Official artifacts are used exactly as published; only the platform's own
# profile tooling is copied in. The workspace status UI needs no injection step:
# @visecy/dsh-workspace-k8s is installed as a file: dependency below and its own
# package.json declares the client bundle, so the profile loads it directly.
COPY scripts/check-plugin-imports.mjs /usr/local/lib/node_modules/check-plugin-imports.mjs

ENV HOME=/home/node DSH_HOME=/opt/dsh-home \
    COREPACK_HOME=/tmp/corepack PNPM_HOME=/tmp/pnpm XDG_DATA_HOME=/tmp/xdg

RUN mkdir -p /opt/dsh-home /home/node && chown -R node:node /opt/dsh-home /home/node \
  && mkdir -p /opt/dsh-home/plugins

# Every platform plugin is installed FROM THIS CHECKOUT, never from the npm
# registry. Two reasons: the image is then a pure function of the commit (no
# registry round-trip, no publish-before-build ordering), and a brand-new
# package can ship before it has ever been published -- the first publish of a
# new package cannot use npm Trusted Publishing, which would otherwise make the
# image build depend on a bootstrap that does not exist yet. Publishing to npm
# still happens in release.yml, for third-party installs.
COPY packages/logging-stdout /opt/dsh-home/plugins/logging-stdout
COPY packages/fs-k8s /opt/dsh-home/plugins/fs-k8s
COPY packages/subprocess-k8s /opt/dsh-home/plugins/subprocess-k8s
COPY packages/workspace-k8s /opt/dsh-home/plugins/workspace-k8s
COPY packages/workspace-picker /opt/dsh-home/plugins/workspace-picker
COPY packages/identity-bridge /opt/dsh-home/plugins/identity-bridge
COPY packages/session-persistence-rdb /opt/dsh-home/plugins/session-persistence-rdb
COPY packages/storage-db /opt/dsh-home/plugins/storage-db
COPY packages/platform-domain /opt/dsh-home/plugins/platform-domain

# Everything COPYed above is owned by root. The runtime user (1000) must be able
# to READ this tree, because the deployment's entrypoint copies it into the
# writable DSH_HOME -- an unreadable file there crashes the container at start.
RUN chown -R node:node /opt/dsh-home/plugins

USER node
# The profile installs with `autoInstallPeers: false` (dsh's own profile
# template), so every DSH package that a platform plugin imports AT RUNTIME
# must be listed here — declaring it as a peerDependency is not enough, and
# `--dump-config` does NOT catch a missing one (it composes config without
# importing plugin bodies). The list below is the empirically verified
# transitive runtime closure of the platform plugins: dsh-session/dsh-llm/
# dsh-scope/dsh-http-proxy are peers of the official dsh-fs, dsh-subprocess and
# dsh-session-persistence packages, and dsh-session-format-catalog is the
# legacy-log (v3 -> v4) migration catalog used by session-persistence-rdb.
# dsh-logging-stdout imports only cordis, schemastery and node builtins — the
# first two are already at the profile root — so it adds nothing to the list.
# `scripts/harness-profile.sh` re-runs this closure check after installing.
RUN dsh --profile web --dump-config > /dev/null 2>&1 || true \
  && dsh --profile headless --dump-config > /dev/null 2>&1 || true \
  && pnpm --dir /opt/dsh-home/profiles/web --store-dir /tmp/pnpm-store add -w \
       file:/opt/dsh-home/plugins/logging-stdout \
       file:/opt/dsh-home/plugins/fs-k8s \
       file:/opt/dsh-home/plugins/subprocess-k8s \
       file:/opt/dsh-home/plugins/workspace-k8s \
       file:/opt/dsh-home/plugins/workspace-picker \
       file:/opt/dsh-home/plugins/identity-bridge \
       file:/opt/dsh-home/plugins/session-persistence-rdb \
       file:/opt/dsh-home/plugins/storage-db \
       file:/opt/dsh-home/plugins/platform-domain \
       @deepseek-ai/dsh-storage@${DSH_VERSION} \
       @deepseek-ai/dsh-storage-domain@${DSH_VERSION} \
       @deepseek-ai/dsh-session-persistence@${DSH_VERSION} \
       @deepseek-ai/dsh-session@${DSH_VERSION} \
       @deepseek-ai/dsh-llm@${DSH_VERSION} \
       @deepseek-ai/dsh-scope@${DSH_VERSION} \
       @deepseek-ai/dsh-http-proxy@${DSH_VERSION} \
       @deepseek-ai/dsh-session-format-catalog@${DSH_VERSION} \
       @kubernetes/client-node \
  && pnpm --dir /opt/dsh-home/profiles/headless --store-dir /tmp/pnpm-store add -w \
       file:/opt/dsh-home/plugins/logging-stdout \
       file:/opt/dsh-home/plugins/fs-k8s \
       file:/opt/dsh-home/plugins/subprocess-k8s \
       file:/opt/dsh-home/plugins/workspace-k8s \
       file:/opt/dsh-home/plugins/session-persistence-rdb \
       file:/opt/dsh-home/plugins/storage-db \
       file:/opt/dsh-home/plugins/platform-domain \
       @deepseek-ai/dsh-storage@${DSH_VERSION} \
       @deepseek-ai/dsh-storage-domain@${DSH_VERSION} \
       @deepseek-ai/dsh-session-persistence@${DSH_VERSION} \
       @deepseek-ai/dsh-session@${DSH_VERSION} \
       @deepseek-ai/dsh-llm@${DSH_VERSION} \
       @deepseek-ai/dsh-scope@${DSH_VERSION} \
       @deepseek-ai/dsh-http-proxy@${DSH_VERSION} \
       @deepseek-ai/dsh-session-format-catalog@${DSH_VERSION} \
       @kubernetes/client-node \
  && node /usr/local/lib/node_modules/check-plugin-imports.mjs /opt/dsh-home/profiles/web \
  && node /usr/local/lib/node_modules/check-plugin-imports.mjs /opt/dsh-home/profiles/headless

# A custom profile defaults to `patchReload: "live"`, which makes the CLI create
# the Cordis HMR service at boot and watch the user patch layer. In this image
# the patch layer is BAKED -- there is nothing to watch -- and the profile does
# not install the HMR plugins, so the CLI's attempt to create them leaves the
# service absent and the boot fails (observed on v0.1.75: "user patch-layer
# watching requires the Cordis HMR service"). "startup" is what the built-in
# profiles use: apply the patch layer once, at startup.
RUN node -e "\
  const fs = require('node:fs');\
  for (const p of ['web', 'headless']) {\
    const f = '/opt/dsh-home/profiles/' + p + '/package.json';\
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));\
    m.dsh.profile.patchReload = 'startup';\
    fs.writeFileSync(f, JSON.stringify(m, null, 2) + '\\n');\
    console.log('patchReload=startup for', p);\
  }"
COPY docker/profiles/web.cordis.patch.yml /opt/dsh-home/profiles/web/cordis.patch.yml
COPY docker/profiles/headless.cordis.patch.yml /opt/dsh-home/profiles/headless/cordis.patch.yml

USER 1000
EXPOSE 3080
ENV DSH_TELEMETRY_DISABLED=1