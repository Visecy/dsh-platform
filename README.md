# dsh-platform

DeepSeek Harness 多用户平台——插件 monorepo（pnpm workspace）。

**架构**：方案 1（执行世界 seam）。会话/agent loop/Web UI 在控制面宿主；执行（fs/subprocess/PTY）经官方 seam 路由到每工作区一个的 k8s 执行 pod。

**设计文档**：见 ../dsh-research/specs/（2026-08-16-workspace-lifecycle-design.md、2026-08-16-multiuser-platform-design.md）
**实现计划**：见 ../dsh-research/plans/2026-08-16-platform-implementation.md

**DSH 基线**：`0.1.5-rc.1`（npm `latest`）。所有 `@deepseek-ai/dsh-*` 依赖都按该版本机械对齐；
`docker/dsh-web-platform.Dockerfile` 的 `DSH_VERSION` 与之相同。升级到新的 DSH 版本时，除了改版本号，
必须重新验证三处与官方编译产物耦合的地方（见下）。

## 包清单

| 包 | 职责 | 计划 |
|---|---|---|
| sandbox-daemon | 工作区执行 pod 内 daemon（files/commands/pty） | Plan 1 |
| fs-k8s | ctx.fs 提供方（→ daemon） | Plan 1 |
| subprocess-k8s | ctx.subprocess 提供方（→ daemon） | Plan 1 |
| workspace-k8s | 工作区生命周期状态机 + lifecycle owner + 原生工作区 UI | Plan 1-2 |
| session-persistence-rdb | ctx.sessionPersistence 的 SQLite/PostgreSQL 后端 | Plan 2 |
| storage-db | ctx.storage 的 SQLite/PostgreSQL 后端 | Plan 3 |
| platform-domain | 平台状态（工作区/设置/凭据）的 storage-domain 规格 | Plan 3 |
| auth-oidc | registerGate + authentik 登录 | Plan 3 |
| workspace-picker | ctx.directoryPicker 的 k8s PVC 实现 | Plan 3 |
| vendor/dsh-web-auth | dsh-host-webserver fork（registerGate 请求闸门） | Plan 3 |
| user-domain | per-user settings/credentials（**尚未接线**） | Plan 3 |
| rbac / cluster-access | 会话注册表 + 授权；集群准入（**空实现**） | Plan 4-5 |

## 与官方产物耦合的地方（升级 DSH 时必须复核）

两份**带自动守卫的副本** + 两处编译产物补丁（详见 design/2026-09-12-dsh-0.1.5-upgrade.md §9）：

1. `scripts/patch-dsh.mjs` —— 对安装后的 `dsh-client-connection` 做两处精确字符串替换
   （浏览器 `isLoopback` 固定为 true；进程内 launch-token cookie 层旁路，OIDC 闸门作为唯一会话层）。
   每处都有 `old`/`assert`/`keep` 守卫与 `node --check`，失配会让镜像构建失败而不是静默产出坏包。
   **注**：这两处都有官方扩展点可以替代（transport hook / 官方 token 交换），见报告 §9.2–9.3。
2. `scripts/vendor-workspace-browser.mjs` —— 把官方 `dsh-client-ui-workspace` 浏览器 bundle 抠出来
   打 14 处状态补丁，产物是 `packages/workspace-k8s/src/client/vendored-workspace.ts`（生成文件）。
   部署里官方 `ui-workspace` 行是 disabled 的，这个 vendored browser 是 `sidebar.workspaces` 的唯一占用者。
3. `vendor/dsh-web-auth/lib/webserver.js` —— 官方 `dsh-host-webserver` 的 fork（新增 `registerGate`
   请求闸门 + upgrade 闸门）。由 `scripts/check-webserver-fork.mjs` 守卫：官方文件每一行都必须仍在
   fork 里，否则镜像构建失败（升级 DSH 时强制重新同步）。

## 开发与验证

```bash
pnpm install && pnpm build && pnpm test

# 部署信任模型冒烟：把官方 dsh-client-connection 复制出来打补丁，配上 vendor 的
# webserver fork 真起一个 server，断言 Host/Origin 围栏仍生效、cookie 层已旁路、
# 0.1.5 的 __DSH_CONNECTION_RECOVERY__ 注入可达。在装好依赖的 profile 目录里跑：
node <repo>/scripts/smoke-web-trust.mjs --target "$PWD/node_modules"

# 官方扩展点替代方案冒烟：用【未打补丁】的官方产物验证
# __DSH_TRANSPORT__.ownsHost 与 launch-token 交换（authenticatedUrl/authorizeIndex）
node <repo>/scripts/smoke-official-integration.mjs --target "$PWD/node_modules"

# 端到端配置验证：搭一个与镜像同构的临时 DSH home（profile bundles + 平台插件行）
bash scripts/harness-profile.sh /tmp/dsh-harness
DSH_HOME=/tmp/dsh-harness/home dsh --profile web --dump-config > /tmp/web.yml
```

`--dump-config` 会解析 profile 的 bundle/patch 层并把每个 row 的最终配置打印出来；
未知 id / name 不匹配只会 warn，所以要看 stderr 里有没有 warning。

`pnpm build` 中 `packages/sandbox-daemon` 走 `tsc --noEmit`（其它包走 esbuild 打包，不做类型检查）。
