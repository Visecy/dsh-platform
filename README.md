# dsh-platform

DeepSeek Harness 多用户平台——插件 monorepo（pnpm workspace）。

**架构**：方案 1（执行世界 seam）。会话/agent loop/Web UI 在控制面宿主；执行（fs/subprocess/PTY）经官方 seam 路由到每工作区一个的 k8s 执行 pod。

**设计文档**：见 ../dsh-research/specs/（2026-08-16-workspace-lifecycle-design.md、2026-08-16-multiuser-platform-design.md）
**实现计划**：见 ../dsh-research/plans/2026-08-16-platform-implementation.md

**DSH 基线**：`0.1.5-rc.1`（npm `latest`）。所有 `@deepseek-ai/dsh-*` 依赖都按该版本机械对齐；
`docker/dsh-web-platform.Dockerfile` 的 `DSH_VERSION` 与之相同。升级到新的 DSH 版本时，
必须重新验证依赖官方扩展点的地方（见下）。

**认证**：同 pod 的 oauth2-proxy sidecar 是唯一入口（chart 传 `--host 127.0.0.1`），
进程内不再有任何认证组件。`@visecy/dsh-identity-bridge` 只做三件事：注入
`__DSH_TRANSPORT__`、用官方 `authenticatedUrl()`/`authorizeIndex()` 完成 launch-token
handoff、从 sidecar 的 `X-Forwarded-User`/`X-Forwarded-Groups` 提供 `ctx.dshAuth`。

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
| identity-bridge | 官方扩展点上的身份 seam（transport hook + token handoff + ctx.dshAuth） | Plan 5 |
| workspace-picker | ctx.directoryPicker 的 k8s PVC 实现 | Plan 3 |
| auth-oidc | **deprecated**：OIDC client + session codec 库（不再注册插件，认证已移到 sidecar） | — |
| user-domain | per-user settings/credentials（**尚未接线**） | Plan 3 |
| rbac / cluster-access | 会话注册表 + 授权；集群准入（**空实现**） | Plan 4-5 |

## 与官方产物耦合的地方（升级 DSH 时必须复核）

平台现在**没有任何编译产物补丁，也没有 webserver fork**：镜像里的 `@deepseek-ai/*`
与 npm 发布的一致，认证路径全部由 `identity-bridge` 走官方扩展点。剩下的耦合点：

1. `scripts/vendor-workspace-browser.mjs` —— 把官方 `dsh-client-ui-workspace` 浏览器 bundle 抠出来
   打 14 处状态补丁，产物是 `packages/workspace-k8s/src/client/vendored-workspace.ts`（生成文件）。
   部署里官方 `ui-workspace` 行是 disabled 的，这个 vendored browser 是 `sidebar.workspaces` 的唯一占用者。
2. `identity-bridge` 依赖的官方契约（升级时跑 `pnpm -r test` + `scripts/smoke-zero-patch.mjs` 即可发现变化）：
   `webserver/index-inject` 的 `{ kind: 'global', name, value }` 行、
   `ctx.connection.authenticatedUrl()` / `authorizeIndex()` 与 `ConnectionIndexResponse`、
   `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic(pathname,res,distRoot,distIndex,authorizeIndex,renderIndex)`、
   以及浏览器端读取的 `globalThis.__DSH_TRANSPORT__.ownsHost`。

## 开发与验证

```bash
pnpm install && pnpm build && pnpm test

# 零补丁冒烟（本仓库的核心证明）：在【未打补丁】的官方产物上装配
# 官方 webserver + 官方 connection + identity-bridge，断言
# transport 注入 / 302 handoff / 303 换 cookie / 200 渲染 / /api 401 策略 /
# x-forwarded-* 身份头。任何编译产物补丁都会让它失败。
node <repo>/scripts/smoke-zero-patch.mjs --target "$PWD/node_modules"

# 官方扩展点证据：这两个补丁为什么可以被官方扩展点替代（同样只加载未打补丁的产物）
node <repo>/scripts/smoke-official-integration.mjs --target "$PWD/node_modules"

# 端到端配置验证：搭一个与镜像同构的临时 DSH home（profile bundles + 平台插件行）
# 需要 0.1.5-rc.1 的 dsh CLI（镜像里装的就是它）
bash scripts/harness-profile.sh /tmp/dsh-harness
DSH_HOME=/tmp/dsh-harness/home dsh --profile web --dump-config > /tmp/web.yml
```

`--dump-config` 会解析 profile 的 bundle/patch 层并把每个 row 的最终配置打印出来；
未知 id / name 不匹配只会 warn，所以要看 stderr 里有没有 warning。

`pnpm build` 中 `packages/sandbox-daemon` 走 `tsc --noEmit`（其它包走 esbuild 打包，不做类型检查）。
