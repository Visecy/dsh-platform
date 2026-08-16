# sandbox daemon image: runs inside the workspace execution pod.
# Node 24 runs TypeScript directly (type stripping), so no build step is needed.
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini procps util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/sandbox-daemon/package.json ./
COPY packages/sandbox-daemon/src ./src
RUN mkdir -p node_modules && cp -r /app/node_modules /tmp/none 2>/dev/null || true
# install runtime deps (node-pty) inside the image
RUN npm install --omit=dev
RUN useradd -u 1000 -m sandbox && mkdir -p /workspace && chown -R sandbox /workspace /app
USER 1000
EXPOSE 4390
ENV DAEMON_ROOT=/workspace DAEMON_PORT=4390
ENTRYPOINT ["tini", "--", "node", "src/main.ts"]
