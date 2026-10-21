# dsh-platform

DeepSeek Harness 多用户平台——插件 monorepo（pnpm workspace）。

**状态：预览版（preview）**。当前 `main` 对应 tag `v0.1.95`（DSH 基线 `0.2.1-rc.2`，由该 tag 构建多架构镜像）；发布物是控制面镜像
`ghcr.io/visecy/dsh-web-platform`（插件内置）与 npm 上的 `@visecy/dsh-*` 插件包。
预览版**不面向生产**：不支持多副本、多租户隔离、非 Kubernetes 部署等，先读
[已知限制](#已知限制预览版明确不支持)。

**架构**：方案 1（执行世界 seam）。会话 / agent loop / Web UI 在控制面宿主；执行
（fs / subprocess / PTY）经官方 seam 路由到「每工作区一个」的 k8s 执行 pod。
一页纸的组件与数据流见 [`docs/architecture.md`](docs/architecture.md)；完整设计见
[`design/`](design/)。

**部署**：控制面 chart、工作区运行时参考、IdP 配置样例与本地集群脚本在配套仓库
[`dsh-platform-deploy`](https://github.com/Visecy/dsh-platform-deploy)，运维步骤见该仓库的
`docs/deployment.md`。本仓 README 只讲插件与开发。

## 兼容性矩阵

平台按 tag 发布：镜像与插件版本都由 tag 决定，DSH 版本是**显式 pin**（不是 semver 范围）。

| 平台版本 | 目标 DSH | 说明 |
|---|---|---|
| `v0.1.89` – `v0.1.95`（当前 `main` 即 `v0.1.95`） | `0.2.1-rc.2`（npm `latest`） | 四处真值必须一致：`pnpm-lock.yaml`、各 `packages/*/package.json` 的 `@deepseek-ai/dsh-*` 依赖、`docker/dsh-web-platform.Dockerfile` 的 `DSH_VERSION`、`.github/workflows/release.yml` 的 build-args |
| `v0.1.80` – `v0.1.88` | `0.2.0-rc.2` | 历史版本，不再回归验证 |
| `v0.1.2` – `v0.1.79` | `0.1.5-rc.1` 及更早 | 历史版本，不再回归验证 |

**升级 DSH 版本时**：先改上表四处真值，再跑 `pnpm -r test` + 两个 smoke（见
[开发与验证](#开发与验证)），并逐条复核下面「与官方产物耦合的地方」。

**认证**：同 pod 的 oauth2-proxy sidecar 是唯一入口（chart 传 `--host 127.0.0.1`），
进程内没有任何认证组件。`@visecy/dsh-identity-bridge` 只做三件事：注入
`__DSH_TRANSPORT__`、用官方 `authenticatedUrl()` / `authorizeIndex()` 完成 launch-token
handoff、从 sidecar 的 `X-Forwarded-User` / `X-Forwarded-Groups` 提供 `ctx.dshAuth`。

对外 URL 只有一个真值：部署给 `dsh web` 传 0.2.1 的 `--public-url`（部署 chart 从
`oauth2Proxy.publicOrigin` 推导）。CLI 的 `--public-url` 经 `ctx.webStartup.publicUrl` 写入
profile 的 `web-runtime.publicUrl`；identity-bridge 未显式配置 `publicOrigin` 时以
`ctx.webApp.getAdvertisedUrl()`（即该 advertised root）作为 handoff 根——忽略与监听地址相同的
loopback fallback（回落到请求的 `X-Forwarded-Proto`/`Host`），并且如果该 authority 不在
connection 的 `trustedHosts` 里就告警并回落，launch token 不会发给不受信任的 authority。
`DSH_PUBLIC_ORIGIN` 只保留为显式覆盖，不再是必需项。

### 部署硬前提（违反即等于没有认证）

身份**完全**来自请求头，所以下面三条是认证成立的前提，不是建议：

1. **不得发布应用端口**：没有 Service / Ingress / NodePort 指向 DSH 进程本身
   （`kubectl port-forward` 同样算直达）；
2. **只能经认证代理到达**：进程必须绑在 loopback——chart 传 `--host 127.0.0.1`，同 pod 的
   oauth2-proxy sidecar 是唯一调用方；官方 CLI 自己就拒绝 `--host 0.0.0.0`
   （`scripts/check-loopback-bind.mjs` 在 harness 里对这条做回归断言）；
3. **NetworkPolicy 兜底**：入口策略只放行预期来源。它是纵深防御，不是第 2 条的替代品——
   策略依赖 CNI 支持、peer 是 label selector（`replicaCount > 1` 时会放行兄弟副本）、
   而且根本不参与评估 loopback 流量。

**违反任一条的后果**：任何能连到这个端口的调用者，只要自己写 `X-Forwarded-User` /
`X-Forwarded-Groups` 就能冒充任意用户——上游身份头没有签名，唯一屏障是拓扑。

子路径是**代理约定**，不是本进程的能力：部署可以把控制面挂到 `https://host/<prefix>/`，
但反向代理必须（a）在把请求交给本进程前剥掉前缀（官方 token exchange 只认 `/`），
（b）把 `/` 与裸 `/<prefix>` 301 到带尾斜杠的 `<root>/`（前端资源是 `./` 相对引用），
（c）把 `oauth2Proxy.publicOrigin` 设为带前缀的 root（chart 会派生出 `--public-url`、
`--redirect-url` 与 sidecar 的 `--cookie-path`）。`/<prefix>` 是唯一挂载点；同一 host
上的两个 DSH 实例仍会互相覆盖会话 cookie，不在支持范围。详见部署仓 §4.4。
另外，进程内闸门随 OIDC gate 一起删除后，官方 `/plugins`（bundle）与 `/plugins/events`（SSE）
路由**自身没有任何信任检查**（0.1.5-rc.1 实测；0.2.1-rc.2 复核：`trustedHosts` 只出现在
`dsh-client-connection` / `dsh-web-app` / `dsh-tool-cordis`，而这两条路由的宿主
`dsh-client-hmr` / `dsh-client-modules` 中 0 处引用），它们与未认证调用者之间同样只剩
「唯一入口是认证代理」这一条。

工作区执行 pod 的 daemon（files / commands / pty）**没有认证**。平台可以按工作区创建一条
NetworkPolicy 把它围到控制面（`workspace.networkPolicy.enabled=true`，**默认关闭**：只有支持
NetworkPolicy 的 CNI 会执行，selector 写错会让所有工作区不可达）。默认关闭时，必须由部署方在
命名空间上提供默认拒绝 / 显式放行，否则同集群任意 Pod 都能读写工作区文件并执行命令。
见 `docs/architecture.md` 与部署仓的 deployment 文档。

### 已知限制（预览版明确不支持）

| 场景 | 现状 |
|---|---|
| 非 Kubernetes 部署（单机 Docker / docker-compose） | ❌ 不支持：执行世界完全路由到工作区 Pod，profile 禁用了官方本地 fs / subprocess 行 |
| 控制面多副本（HA / 水平扩容） | ❌ 不支持：无 leader election；生命周期状态与闲置回收在进程内，跨副本会互相回收对方的 Pod |
| 多租户隔离与授权 | ❌ 未实现：`rbac` / `cluster-access` 是空实现，`ctx.dshAuth` 目前没有消费方。**所有通过认证的用户共享同一份控制面状态**（会话、工作区、模型凭据），且都能列出 / 休眠 / 删除彼此的工作区 |
| ARM64 / 多架构镜像 | ⚠️ release workflow 已构建 `linux/amd64` + `linux/arm64`；**`v0.1.88` 起为双架构；`v0.1.87` 及更早只有 amd64**，请用包含该改动之后打出的 tag |
| air-gapped / 离线安装 | ❌ 未提供镜像搬运与离线清单 |
| `pod-security.kubernetes.io/enforce=restricted` 命名空间 | ✅ 控制面与工作区 Pod 都已 runAsNonRoot、丢弃全部 capability、设置 `seccompProfile: RuntimeDefault`（控制面容器另有 `readOnlyRootFilesystem`）；工作区 daemon 需要可写的 `/tmp`，这不属于 restricted 的检查项 |
| 子路径发布（`https://host/dsh`） | ✅ 支持（条件）：需要**前缀剥离型**反向代理 + 把 `/` 与裸 `/<prefix>` 301 到 `<root>/`；v1 只支持单段前缀，且同 host 只能放一个 DSH 实例（DSH cookie 是 authority 作用域 + `Path=/`）。操作步骤见部署仓 `docs/deployment.md` §4.4 |
| 工作区共享存储（ReadWriteMany） | ❌ PVC 固定 `ReadWriteOnce` |
| 数据库 | ⚠️ PostgreSQL 必需：镜像 profile 写死 `type: postgres`；代码层存在 SQLite 后端，但镜像不提供该路径 |
| 控制面 ↔ 工作区网络 | ⚠️ 控制面必须能直连工作区 Pod IP 的 daemon 端口（4390）；默认拒绝 egress 的策略、Istio STRICT mTLS 或集群外控制面都会切断全部 fs / 命令 / PTY |

## 包清单

| 包 | 职责 | 状态 |
|---|---|---|
| sandbox-daemon | 工作区执行 pod 内 daemon（files / commands / pty） | 可用；镜像 `ghcr.io/visecy/dsh-platform/dsh-sandbox-daemon` |
| fs-k8s | `ctx.fs` 提供方（→ daemon） | 可用；发布到 npm |
| subprocess-k8s | `ctx.subprocess` 提供方（→ daemon） | 可用；发布到 npm |
| workspace-k8s | 工作区生命周期状态机 + lifecycle owner + 官方槽位状态面板 | 可用；发布到 npm |
| workspace-picker | `ctx.directoryPicker` 的 k8s PVC 实现 | 可用；发布到 npm |
| identity-bridge | 官方扩展点上的身份 seam（transport hook + token handoff + `ctx.dshAuth`） | 可用；**尚未发布到 npm**（镜像从本仓检出安装），首次发布需要手工 bootstrap |
| session-persistence-rdb | `ctx.sessionPersistence` 的 SQLite / PostgreSQL 后端 | 可用；镜像内置（私有包） |
| storage-db | `ctx.storage` 的 SQLite / PostgreSQL 后端 | 可用；镜像内置（私有包） |
| platform-domain | 平台状态（工作区 / 设置 / 凭据）的 storage-domain 规格 | 可用；镜像内置（私有包） |
| logging-stdout | Cordis 日志的 stdout sink | 可用；镜像内置（私有包） |
| auth-oidc | **deprecated**：OIDC client + session codec 库（不再注册插件，认证已移到 sidecar） | 仅历史兼容，计划停止发布 |
| rbac / cluster-access / daemon-protocol / user-domain | 授权、集群准入、协议、用户域的占位 | **空实现**，预览版未接线 |

## 与官方产物耦合的地方（升级 DSH 时必须复核）

**两条路径都已零编译产物补丁、零 webserver fork**：镜像里的 `@deepseek-ai/*` 与 npm 发布的一致。
认证路径由 `identity-bridge` 走官方扩展点；工作区 UI 也已反转回官方槽位：官方 `ui-workspace`
行重新启用并 own 侧栏工作区 / 会话、hero 与 `sidebar.workspaces` 契约，平台只**新增**
`workspace-k8s` 的状态面板（`main` keyed 面板 + `sidebar.panellist` 入口 + 可选
`shell.overlay` 药丸，见 `packages/workspace-k8s/src/client/panel.tsx`）。此前「把官方浏览器
bundle 抠出来打补丁」的 vendoring 链路已整体删除，因此**升级 DSH 不再需要重新对锚点**。

升级时仍需复核（跑 `pnpm -r test` + 两个 smoke 即可发现变化）：

1. `identity-bridge`：`webserver/index-inject` 的 `{ kind: 'global', name, value }` 行、
   `ctx.connection.authenticatedUrl()` / `authorizeIndex()` 与 `ConnectionIndexResponse`、
   `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic(pathname,res,distRoot,distIndex,authorizeIndex,renderIndex)`、
   以及浏览器端读取的 `globalThis.__DSH_TRANSPORT__.ownsHost`。
2. 状态面板占用的客户端槽位：`main`（keyed）、`sidebar.panellist`（list，id 与 `main` 的 key 同名）、
   `shell.overlay`（list）。这三者自 0.1.5-rc.1 起就在 `dsh-client-ui-layout` /
   `dsh-client-ui-sidebar` 的类型契约里；若上游改签名，面板注册会走 `slots.inject` 的等待路径
   （槽位未声明就不注册），不会像 vendoring 那样静默改坏官方 bundle。
3. `docker/profiles/*.cordis.patch.yml` 里被 disable / 重述的官方行 id 与 config key：
   每个 patch 都必须在目标 DSH 版本的 `dsh --profile web --dump-default-config` 里仍然存在，
   否则 `patch: entry "…" not found` 只 warn 不报错。

## 开发与验证

```bash
pnpm install && pnpm build && pnpm test

# 端到端配置验证：搭一个与镜像同构的临时 DSH home（profile bundles + 平台插件行）。
# 需要与本仓 DSH_VERSION 一致的 dsh CLI（当前 0.2.1-rc.2；镜像里装的就是它）。
bash scripts/harness-profile.sh /tmp/dsh-harness
DSH_HOME=/tmp/dsh-harness/home dsh --profile web --dump-config > /tmp/web.yml

# 零补丁冒烟：只装配【未打补丁】的官方 webserver + 官方 connection +
# identity-bridge，断言 transport 注入 / 302 handoff / 303 换 cookie / 200 渲染 /
# /api 401 策略 / x-forwarded-* 身份头。认证路径上任何编译产物补丁都会让它失败。
#
# --target 必须指向一个 **profile** 的 node_modules（含未打补丁的官方包与
# identity-bridge），也就是上面 harness 脚本产出的那个目录；仓库根的 node_modules
# 只有构建工具（esbuild / typescript），跑不了这两个脚本。
node scripts/smoke-zero-patch.mjs --target /tmp/dsh-harness/home/profiles/web/node_modules

# 官方扩展点证据：这两个补丁为什么可以被官方扩展点替代（同样只加载未打补丁的产物）
node scripts/smoke-official-integration.mjs --target /tmp/dsh-harness/home/profiles/web/node_modules
```

`--dump-config` 会解析 profile 的 bundle/patch 层并把每个 row 的最终配置打印出来；
未知 id / name 不匹配只会 warn，所以要看 stderr 里有没有 warning。

`pnpm build` 中 `packages/sandbox-daemon` 走 `tsc --noEmit`；其它包走 esbuild 打包，不做类型检查，
**已发布的 npm 包因此暂不提供 TypeScript 类型声明**（`package.json` 里不再声明 `types`，
以免指向不存在的 `dist/index.d.ts`）。补齐声明前需要先让这些包通过 `tsc`。

`pnpm -r test` 里 PostgreSQL 与 golden-fixture 用例默认跳过（需要 `TEST_PG_URL` /
`DSH_CAPTURE_FIXTURE=1`），所以本地全绿不等于 Postgres 后端被覆盖。
