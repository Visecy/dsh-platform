# 安全策略

本仓是 DeepSeek Harness 多用户平台的插件 monorepo（控制面镜像 + 工作区 daemon 镜像）。
**当前是预览版（preview），不面向生产**，本项目也从未经过第三方安全审计。

## 报告漏洞

- 使用 GitHub 的**私密漏洞报告**：本仓 [Security](https://github.com/Visecy/dsh-platform) 标签页
  → **Report a vulnerability**。请不要开公开 issue。
- 与部署、chart、集群侧配置有关的问题，报到部署仓
  [Visecy/dsh-platform-deploy](https://github.com/Visecy/dsh-platform-deploy) 的 Security 标签页。
  拿不准时报到问题实际所在的那个仓库即可。
- 请附上：受影响的版本或 tag、复现步骤、影响面，以及你认为的最低修复要求。
- 我们会在仓库的 Security advisory 里同步进展；在修复发布前请勿公开细节。

## 信任模型（先读这段再判断影响面）

身份**只**来自认证代理注入的请求头：`X-Forwarded-User` / `X-Forwarded-Groups`
（`@visecy/dsh-identity-bridge` 默认读这一对，可用 `userHeader` / `groupsHeader` 改名）。
这两个头**没有签名**，进程内没有任何认证组件，因此唯一的屏障是**拓扑**：

1. DSH 进程只绑 loopback（镜像 profile 传 `--host 127.0.0.1`；官方 CLI 自身拒绝 `--host 0.0.0.0`，
   `scripts/check-loopback-bind.mjs` 在 harness 里对此做回归断言）；
2. 没有任何 Service / Ingress / NodePort 指向应用端口，唯一入口是同 pod 的 oauth2-proxy sidecar
   （`kubectl port-forward` 同样算直达，一样会破坏这个前提）；
3. 入口 NetworkPolicy 只放行预期来源（纵深防御，不是第 1、2 条的替代品）。

**违反任一条的后果**：任何能连到应用端口的调用者，自己写 `X-Forwarded-User` 就能冒充任意用户。
这不是需要绕过的 bug，而是当前设计的直接推论——所以这类问题只在"绕过了上述前提"（例如
chart 或文档让你把端口发布出去）时才算漏洞，请连同证据一起报告。

此外：`identity-bridge` 明确拒绝把 `X-Auth-Request-*` 当身份读取——该族在 oauth2-proxy 里是
**响应头**，客户端伪造的不会被清除。官方 `/plugins`（bundle）与 `/plugins/events`（SSE）
路由自身没有信任检查，它们与未认证调用者之间同样只剩"唯一入口是认证代理"这一条。

## 众所周知但不属于漏洞（预览版已知限制）

- **没有多租户授权**：`rbac` / `cluster-access` 是空实现，`ctx.dshAuth` 目前没有消费方。
  **所有通过认证的用户共享同一份控制面状态**（会话、工作区、模型凭据），并且都能列出 /
  休眠 / 删除彼此的工作区。这是已在 README「已知限制」中记录的现状，不是授权绕过漏洞。
- **工作区 daemon 没有认证**：`sandbox-daemon` 监听 `0.0.0.0:4390`，提供文件读写、命令执行
  与 PTY，没有任何凭据校验。平台**不会**默认创建 NetworkPolicy；只有显式设置
  `workspace.networkPolicy.enabled=true`（chart）时才会为每个工作区创建一条。同集群任意能访问
  到工作区 Pod IP 的 Pod 都可以读写工作区文件并执行命令——请部署方在命名空间上补默认拒绝。
- **控制面多副本不受支持**：没有 leader election，多副本会互相回收对方的工作区 Pod。
- **`/plugins`、`/plugins/events` 无进程内信任检查**（见上）。
- 预览版不支持的部署形态：子路径发布（`https://host/dsh`）、离线安装、ReadWriteMany 存储；
  多架构镜像（`linux/amd64` + `linux/arm64`）从下一个 tag 起，更早的 tag 只有 amd64。
  `restricted` Pod Security Standard 已被满足：控制面与工作区 Pod 都设置
  `seccompProfile: RuntimeDefault`。详见 README 的「已知限制」。

## 供应链

- 发布物是 GHCR 上的两个镜像（`ghcr.io/visecy/dsh-web-platform`、
  `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon`）与 npm 上的 `@visecy/dsh-*` 包，
  全部由 `.github/workflows/release.yml` 在 `v*` tag 上构建。
- 镜像用 buildx 构建 `linux/amd64` + `linux/arm64`，并带 **provenance 与 SBOM** 证明。
- npm 发布用 **Trusted Publishing（GitHub Actions OIDC）**，发布流程里没有长期 NPM_TOKEN。
- 镜像内的 `@deepseek-ai/*` 是**未打补丁**的官方 npm 产物（零编译产物补丁、零 webserver
  fork）。DSH 基线是显式 pin 的 `0.2.0-rc.2`（release candidate），其自身的问题请报给上游。
- 只有 `main` 与最新 tag 接受修复；更早的 tag 不再回归验证。

## 不在范围内

- 第三方组件自身的漏洞：`quay.io/oauth2-proxy/oauth2-proxy`、PostgreSQL、Kubernetes 及其 CNI、
  以及 `@deepseek-ai/dsh-*` 官方包（请报给上游）。
- 仅由部署方配置错误导致的暴露（例如自己给应用端口加了 Service、把 `DSH_TRUSTED_HOSTS`
  设成任意值、或没有给工作区 daemon 做隔离）——除非本仓的 chart 或文档诱导了这种配置。
- 预览版明确不支持的场景（多租户隔离、HA、非 Kubernetes 部署）中被当作"缺失功能"报告的问题。

## 支持的版本

只有 `main` 与最新 tag 接受修复。当前 `main` 对应 tag `v0.1.87`（部署 chart 默认 pin 的也是它），
DSH 基线 `0.2.0-rc.2`，由 `scripts/check-dsh-version.mjs` 在 CI 与发布流程中强制一致。
更早的 tag（`v0.1.2` – `v0.1.79`，面向 `0.1.5-rc.1` 及更早）不再回归验证。

部署侧的安全必读项（`trustedProxyIps` 生产必需、工作区 daemon 的隔离做法）见部署仓
`dsh-platform-deploy` 的 `SECURITY.md` 与 `docs/deployment.md`。
