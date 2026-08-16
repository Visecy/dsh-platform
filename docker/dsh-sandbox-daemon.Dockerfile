# sandbox daemon image: runs inside the workspace execution pod.
# Node 24 runs TypeScript directly (type stripping), so no build step is needed.
# node-pty needs a toolchain at install time (builder stage only).
FROM node:24-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY packages/sandbox-daemon/package.json ./
COPY packages/sandbox-daemon/src ./src
RUN npm install --omit=dev

FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini procps util-linux && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY packages/sandbox-daemon/package.json ./
COPY packages/sandbox-daemon/src ./src
RUN useradd -u 1000 -m sandbox && mkdir -p /workspace && chown -R sandbox /workspace /app
USER 1000
EXPOSE 4390
ENV DAEMON_ROOT=/workspace DAEMON_PORT=4390
ENTRYPOINT ["tini", "--", "node", "src/main.ts"]
