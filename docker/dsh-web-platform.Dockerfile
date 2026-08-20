# dsh-web-platform: self-contained control-plane image.
#
# Built from the OFFICIAL npm package (@deepseek-ai/dsh), not a third-party
# image. Follows the reference community Dockerfile's install pattern
# (npm global + --allow-scripts for node-pty/koffi prebuilds) but keeps only
# the headless web runtime — no Chromium/desktop.
#
# Layers:
#   1. privileged-method unlock patch (settings/credentials RPCs are pinned to
#      loopback by the official client-connection; our OIDC gate authenticates
#      every /api request, so reusing trustedHosts is safe — research §6.3c)
#   2. @visecy platform plugins pre-installed into the web + headless profiles
#   3. dsh-web-auth (registerGate webserver fork) pre-installed
#
# The baked-in Harness home lives at /opt/dsh-home; the deployment copies it
# into the runtime DSH_HOME (writable volume) on start.
#
# Version pinning: PLUGIN_VERSION is passed by the release workflow from the
# git tag (e.g. v0.1.5 -> 0.1.5), so the installed plugins always match the
# npm versions published by the SAME tag. When unset, pnpm resolves latest.

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS installer

ARG DSH_VERSION=0.1.0-rc.8
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

ARG DSH_VERSION=0.1.0-rc.8
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

RUN sed -i 's/PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, \[\])/PRIVILEGED_METHODS.has(method) && !isTrustedApiRequest(request, trustedHosts)/' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js \
  && grep -c 'isTrustedApiRequest(request, trustedHosts)' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js \
  && sed -i 's#isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname)#isLoopback: true // platform: remote browser treated as trusted (OIDC-gated)#' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js \
  && grep -c 'isLoopback: true' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/client.js

ENV HOME=/home/node DSH_HOME=/opt/dsh-home \
    COREPACK_HOME=/tmp/corepack PNPM_HOME=/tmp/pnpm XDG_DATA_HOME=/tmp/xdg

RUN mkdir -p /opt/dsh-home /home/node && chown -R node:node /opt/dsh-home /home/node

USER node
RUN dsh --profile web --dump-config > /dev/null 2>&1 || true \
  && dsh --profile headless --dump-config > /dev/null 2>&1 || true \
  && pnpm --dir /opt/dsh-home/profiles/web --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-auth-oidc@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-fs-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-subprocess-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-workspace-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-workspace-picker@${PLUGIN_VERSION:-latest} \
       dsh-web-auth@0.1.0 \
       @kubernetes/client-node \
  && pnpm --dir /opt/dsh-home/profiles/headless --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-fs-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-subprocess-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-workspace-k8s@${PLUGIN_VERSION:-latest} \
       @kubernetes/client-node

COPY docker/profiles/web.cordis.patch.yml /opt/dsh-home/profiles/web/cordis.patch.yml
COPY docker/profiles/headless.cordis.patch.yml /opt/dsh-home/profiles/headless/cordis.patch.yml

USER 1000
EXPOSE 3080
ENV DSH_TELEMETRY_DISABLED=1