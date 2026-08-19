# dsh-web-platform: self-contained control-plane image.
#
# Based on the official dsh web image, with:
#   1. privileged-method unlock patch (settings/credentials RPCs are pinned to
#      loopback by the official client-connection; our OIDC gate authenticates
#      every /api request, so reusing trustedHosts is safe — research §6.3c)
#   2. @visecy platform plugins pre-installed into the web + headless profiles
#   3. dsh-web-auth (registerGate webserver fork) pre-installed
#
# The baked-in Harness home lives at /opt/dsh-home; the deployment copies it
# into the runtime DSH_HOME (writable volume) on start.
#
# Build-time context: repo root.
#
# Version pinning: PLUGIN_VERSION is passed by the release workflow from the
# git tag (e.g. v0.1.5 -> 0.1.5), so the installed plugins always match the
# npm versions published by the SAME tag — no "latest" drift between the npm
# registry and the image. When unset (manual builds), pnpm resolves latest.
FROM runzhliu/deepseek-harness:0.1.0-rc.6

# npm version of the @visecy plugins to install (from the release tag).
ARG PLUGIN_VERSION

USER root

# 1. privileged-method unlock: patch the official client-connection in place
#    (image build rootfs is writable — no runtime sed needed)
RUN sed -i 's/isTrustedApiRequest(request, \[\])/isTrustedApiRequest(request, trustedHosts)/' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js \
  && grep -c 'isTrustedApiRequest(request, trustedHosts)' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

# 2. install platform plugins + gated webserver fork into the profiles
#    (web profile: auth gate + providers; headless profile: providers only)
ENV HOME=/home/node DSH_HOME=/opt/dsh-home \
    COREPACK_HOME=/tmp/corepack PNPM_HOME=/tmp/pnpm XDG_DATA_HOME=/tmp/xdg

RUN mkdir -p /opt/dsh-home && chown -R node:node /opt/dsh-home

USER node
# pin plugins to PLUGIN_VERSION when set (release builds); dsh-web-auth is a
# third-party pin; @kubernetes/client-node tracks its own semver
RUN dsh --profile web --dump-config > /dev/null 2>&1 || true \
  && dsh --profile headless --dump-config > /dev/null 2>&1 || true \
  && corepack pnpm --dir /opt/dsh-home/profiles/web --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-auth-oidc@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-fs-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-subprocess-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-workspace-k8s@${PLUGIN_VERSION:-latest} \
       dsh-web-auth@0.1.0 \
       @kubernetes/client-node \
  && corepack pnpm --dir /opt/dsh-home/profiles/headless --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-fs-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-subprocess-k8s@${PLUGIN_VERSION:-latest} \
       @visecy/dsh-workspace-k8s@${PLUGIN_VERSION:-latest} \
       @kubernetes/client-node

# 3. profile patches (web: gated webserver + OIDC + providers; headless: providers)
COPY docker/profiles/web.cordis.patch.yml /opt/dsh-home/profiles/web/cordis.patch.yml
COPY docker/profiles/headless.cordis.patch.yml /opt/dsh-home/profiles/headless/cordis.patch.yml

USER 1000
EXPOSE 3080
ENV DSH_TELEMETRY_DISABLED=1
