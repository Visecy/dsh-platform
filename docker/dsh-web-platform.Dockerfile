# dsh-web-platform: self-contained control-plane image.
#
# Based on the official dsh web image, with:
#   1. privileged-method unlock patch (settings/credentials RPCs are pinned to
#      loopback by the official client-connection; our OIDC gate authenticates
#      every /api request, so reusing trustedHosts is safe — research §6.3c)
#   2. @visecy platform plugins pre-installed into the web + headless profiles
#   3. dsh-web-auth (registerGate webserver fork) pre-installed
#
# Build-time context: repo root. The plugin packages are consumed from the
# npm registry (@visecy scope, published by the release workflow), so this
# image builds reproducibly without a monorepo copy.
FROM runzhliu/deepseek-harness:0.1.0-rc.6

USER root

# 1. privileged-method unlock: patch the official client-connection in place
#    (image build rootfs is writable — no runtime sed needed)
RUN sed -i 's/isTrustedApiRequest(request, [])/isTrustedApiRequest(request, trustedHosts)/' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js \
  && grep -c 'isTrustedApiRequest(request, trustedHosts)' \
      /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js

# 2. install platform plugins + gated webserver fork into the profiles
#    (web profile: auth gate + providers; headless profile: providers only)
ENV HOME=/home/node DSH_HOME=/home/node/.dsh \
    COREPACK_HOME=/tmp/corepack PNPM_HOME=/tmp/pnpm XDG_DATA_HOME=/tmp/xdg

RUN mkdir -p /home/node/.dsh && chown -R node:node /home/node/.dsh

USER node
RUN dsh --profile web --dump-config > /dev/null 2>&1 || true \
  && dsh --profile headless --dump-config > /dev/null 2>&1 || true \
  && corepack pnpm --dir /home/node/.dsh/profiles/web --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-auth-oidc@0.1.0 \
       @visecy/dsh-fs-k8s@0.1.0 \
       @visecy/dsh-subprocess-k8s@0.1.0 \
       @visecy/dsh-workspace-k8s@0.1.0 \
       dsh-web-auth@0.1.0 \
       @kubernetes/client-node \
  && corepack pnpm --dir /home/node/.dsh/profiles/headless --store-dir /tmp/pnpm-store add -w \
       @visecy/dsh-fs-k8s@0.1.0 \
       @visecy/dsh-subprocess-k8s@0.1.0 \
       @visecy/dsh-workspace-k8s@0.1.0 \
       @kubernetes/client-node

# 3. profile patches (web: gated webserver + OIDC + providers; headless: providers)
COPY docker/profiles/web.cordis.patch.yml /home/node/.dsh/profiles/web/cordis.patch.yml
COPY docker/profiles/headless.cordis.patch.yml /home/node/.dsh/profiles/headless/cordis.patch.yml

USER 1000
EXPOSE 3080
ENV DSH_TELEMETRY_DISABLED=1
