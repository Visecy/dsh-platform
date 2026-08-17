# OIDC auth gate image: runs the registerGate + proxy in front of dsh web.
# Node 24 runs TypeScript directly (type stripping); no runtime deps.
FROM node:24-slim
WORKDIR /app
COPY packages/auth-oidc/package.json ./
COPY packages/auth-oidc/src ./src
# node:24-slim already has uid 1000 (node user)
USER 1000
EXPOSE 3080
ENV GATE_PORT=3080 GATE_UPSTREAM=http://127.0.0.1:3000
ENTRYPOINT ["node", "src/main.ts"]
