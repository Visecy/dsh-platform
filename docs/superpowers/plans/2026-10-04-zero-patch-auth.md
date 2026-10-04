# Plan 1：零编译产物补丁 + 认证外置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH 0.1.5-rc.1 基线上，用官方扩展点替换掉两处编译产物补丁与 webserver fork，把认证移到同 pod 的 oauth2-proxy sidecar。

**Architecture:** 认证由 sidecar 完成并注入身份头；DSH 绑 loopback 保证头只可能来自 sidecar；一个新的 `identity-bridge` 宿主插件负责①注入 `__DSH_TRANSPORT__`（替代 P1）②在 DSH cookie 缺失时做官方 token handoff（替代 P2）③把身份头暴露为 `ctx.dshAuth`。

**Tech Stack:** cordis 4 插件、TypeScript、esbuild（`scripts/build-pkg.mjs`）、vitest、helm、oauth2-proxy。

## Global Constraints

- 控制面必须无状态且可 `readOnlyRootFilesystem`：任何持久状态只能进 Postgres；本次新增组件不得写盘。
- 不引入对 DSH 版本的硬锁：只用官方公开 API（`ctx.connection.*`、`webserver/index-inject`、`webServer.register`）。
- 不引入 GPL 依赖到 MIT 代码；sidecar 是独立镜像，不 vendoring。
- 现有验证设施必须保持绿：`pnpm -r build`、`pnpm -r test`、`scripts/harness-profile.sh`、`scripts/check-plugin-imports.mjs`。
- 本次不改动：`session-persistence-rdb`、`storage-db`、`platform-domain`、`user-domain`、`workspace-k8s` 的客户端半边与 vendoring（另有计划）。

---

## 顺序说明（为什么先做这个再升 DSH）

先做本计划再升 0.2.0-rc.2，可以避免为一堆即将删除的代码做重锚：vendored browser 的 7 个 anchor、webserver fork 的 1 行重同步、`patch-dsh.mjs` 的 keep-guard 重锚，都会随着本计划的删除动作一起消失。升级计划届时只剩 `fs.watch`、`session-persistence-rdb` 的 v3→v4 迁移与 profile 行校正。

---

### Task 1: `packages/identity-bridge` —— 官方 transport hook 注入

**Files:**
- Create: `packages/identity-bridge/package.json`
- Create: `packages/identity-bridge/src/index.ts`
- Create: `packages/identity-bridge/tests/transport.spec.ts`

**Interfaces:**
- Produces: `export const name = '@visecy/dsh-identity-bridge'`；`export function apply(ctx: Context, config: Config): void`；`Config = { publicOrigin?: string }`
- Consumes: `webserver/index-inject` 事件（由 `webServer` service 提供，见 `dsh-host-webserver` 的 `collectIndexInjections`）

- [ ] **Step 1: 写失败测试**

```ts
// packages/identity-bridge/tests/transport.spec.ts
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

describe('identity-bridge transport injection', () => {
  it('pushes the __DSH_TRANSPORT__ global with ownsHost', async () => {
    const ctx = new Context()
    const rows: any[] = []
    ctx.on('webserver/index-inject', (table: any[]) => { rows.push(...table.splice(0)) })
    // minimal webServer stand-in: the plugin only needs the event seat
    ctx.provide('webServer', {})
    apply(ctx, {})
    ctx.emit('webserver/index-inject', [] as any)
    const row = rows.find((r) => r.name === '__DSH_TRANSPORT__')
    expect(row).toBeDefined()
    expect(row.kind).toBe('global')
    expect(row.value).toEqual({ ownsHost: true })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/identity-bridge && npx vitest run tests/transport.spec.ts`
Expected: FAIL —— `Cannot find module '../src/index.ts'`

- [ ] **Step 3: 最小实现**

```ts
// packages/identity-bridge/src/index.ts
import type { Context } from '@deepseek-ai/cordis'

export const name = '@visecy/dsh-identity-bridge'
export const inject = ['webServer']

export interface Config { publicOrigin?: string }

export function apply(ctx: Context, _config: Config): void {
  ctx.on('webserver/index-inject', (table: unknown[]) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } })
  })
}
```

`package.json` 复制 `packages/fs-k8s/package.json` 的结构（`@visecy/dsh-identity-bridge`、`private: false`、`build: node ../../scripts/build-pkg.mjs identity-bridge src/index.ts`、`test: vitest run`、devDeps `@deepseek-ai/dsh-client-connection`/`typescript`/`vitest`、peerDep `@deepseek-ai/cordis`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/identity-bridge && npx vitest run`
Expected: PASS（1 passed）

- [ ] **Step 5: 提交**

```bash
git add packages/identity-bridge
git commit -m "feat(identity-bridge): replace the isLoopback patch with the official transport hook"
```

---

### Task 2: `identity-bridge` —— DSH launch-token handoff

**Files:**
- Modify: `packages/identity-bridge/src/index.ts`
- Create: `packages/identity-bridge/tests/handoff.spec.ts`

**Interfaces:**
- Consumes: `ctx.connection.authenticatedUrl(baseUrl: string): string`、`ctx.connection.authorizeIndex(req, res): boolean`（`HostConnectionService`，服务名 `connection`）
- Produces: 精确路由 `GET /` 的所有权；无有效 cookie 时 `302 Location: <authenticatedUrl>`，有则 `authorizeIndex` 返回 true 后交给已注册的 index 渲染

**关键约束**：官方 `WebServer.register` 精确路由优先于 fallback（`match()` 先查 exact 表）。我们注册精确 `/`，因此必须自己产出 index —— 用官方 `dsh-host-frontend-static` 导出的 `serveStatic(pathname, res, distRoot, distIndex, authorizeIndex, renderIndex)`，其中 `renderIndex` 用 `ctx.webServer.renderIndex(html)`。

- [ ] **Step 1: 写失败测试**（断言无 cookie 时 302，且 Location 含 `?token=`）

```ts
it('redirects a cookieless index request through the official token exchange', async () => {
  // 用 real WebServer(fork 已废弃则用官方包) + credentials stub + connection，
  // 参考 scripts/smoke-official-integration.mjs 的装配方式
  const res = await get('/', { host: 'harness.example.test' })
  expect(res.status).toBe(302)
  expect(res.headers.location).toMatch(/\?token=/)
})
```

- [ ] **Step 2: 跑测试确认失败**（当前 `/` 由 frontend-static 处理 → 401，不是 302）

Run: `cd packages/identity-bridge && npx vitest run tests/handoff.spec.ts`
Expected: FAIL —— `expected 401 to be 302`

- [ ] **Step 3: 实现 handoff 路由**

要点：`ctx.inject(['webServer','connection','webStartup'], …)`；注册 `{ kind:'exact', path:'/' }`；用 `config.publicOrigin ?? requestOrigin(req)` 构造 base；cookie 判定复用 `ctx.connection.authorizeIndex(req,res)` 的返回值（true = 已有有效 cookie 或刚完成交换），false 时若响应尚未写入则 302 到 `authenticatedUrl(base)`。写成独立函数 `handleIndex(ctx, req, res)` 便于测试。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/identity-bridge && npx vitest run`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/identity-bridge
git commit -m "feat(identity-bridge): serve the index through the official token handoff"
```

---

### Task 3: sidecar 与 loopback 绑定（helm + profile）

**Files:**
- Modify: `dsh-platform-deploy/charts/dsh-control-plane/templates/deployment.yaml`（加 sidecar、service targetPort）
- Modify: `dsh-platform-deploy/charts/dsh-control-plane/templates/service.yaml`
- Modify: `dsh-platform-deploy/charts/dsh-control-plane/values.yaml`（oauth2Proxy 段）
- Modify: `dsh-platform-deploy/charts/dsh-control-plane/templates/networkpolicy.yaml`（只允许 sidecar 访问 DSH 端口）
- Modify: `docker/profiles/web.cordis.patch.yml`（DSH 绑 `127.0.0.1`；插入 identity-bridge 行）

**Interfaces:**
- Consumes: Task 1/2 的 `@visecy/dsh-identity-bridge`
- Produces: 集群内唯一入口是 sidecar 的 4180 端口；DSH 仅监听 127.0.0.1:3080

- [ ] **Step 1: 写验证脚本/断言**：`kubectl get deploy -o yaml` 级别的手工核对清单写入 `docs/`（本任务无可自动化断言，改为把核对项写进 chart 注释）
- [ ] **Step 2: 改 values + deployment**：sidecar 镜像、`--provider=oidc --oidc-issuer-url --email-domain=* --upstream=http://127.0.0.1:3080 --set-xauthrequest --reverse-proxy=true --cookie-secret=$(SESSION_SECRET) --flush-interval=1s`；`readOnlyRootFilesystem: true` 保持不变
- [ ] **Step 3: Service targetPort 指向 sidecar；NetworkPolicy 限制 3080 只允许本 pod**
- [ ] **Step 4: profile 改 `webserver` 行 host 为 `127.0.0.1`，插入 identity-bridge 行**
- [ ] **Step 5: 验证**：`helm template` 渲染通过；`bash scripts/harness-profile.sh /tmp/h1` 绿
- [ ] **Step 6: 提交**

---

### Task 4: 删除 fork、补丁与进程内闸门

**Files:**
- Delete: `vendor/dsh-web-auth/`、`scripts/patch-dsh.mjs`、`scripts/check-webserver-fork.mjs`、`scripts/smoke-web-trust.mjs`（由新的冒烟替代）
- Modify: `packages/auth-oidc/`：删除 `src/webserver.ts`、`src/session.ts`、gate 相关代码；保留或整体删除见下
- Modify: `docker/dsh-web-platform.Dockerfile`（去掉 patch-dsh / fork 安装、加 identity-bridge）
- Modify: `docker/profiles/web.cordis.patch.yml`（去掉 `webserver` disable 与 `webserver-gated` insert；恢复官方 webserver 行）

**Interfaces:**
- 本任务后 `scripts/check-plugin-imports.mjs` 的 web 列表不再包含 `@visecy/dsh-web-auth` 与 `@visecy/dsh-auth-oidc`

- [ ] **Step 1: 确认替代链路已生效**：在 Task 2 的冒烟通过前不得删除（前置依赖）
- [ ] **Step 2: 删除文件与 Dockerfile 步骤**
- [ ] **Step 3: profile 恢复官方 `webserver` 行，去掉 `webserver-gated` insert**
- [ ] **Step 4: 新增冒烟 `scripts/smoke-zero-patch.mjs`**：未打补丁的官方产物 + 官方 webserver + identity-bridge，断言 ①`__DSH_TRANSPORT__` 已注入 ②无 cookie 的 `/` → 302 且带 token ③带 token 后 `/api` 不再 401 ④身份头能被 `ctx.dshAuth` 读到
- [ ] **Step 5: 全量验证**：`pnpm -r build && pnpm -r test && bash scripts/harness-profile.sh /tmp/h2 && node scripts/smoke-zero-patch.mjs`
- [ ] **Step 6: 提交**

---

## Self-Review

- **Spec 覆盖**：§4.1（零补丁）→ Task 1/2/4；§4.2（handoff）→ Task 2；§2（sidecar/loopback）→ Task 3；§3（删 fork/patch/auth-oidc）→ Task 4。§4.3/4.4（工作区 UI 与契约）与 §5（DSH 0.2.x 升级）不在本计划，属于后续计划。
- **占位符扫描**：Task 3 Step 1 明确说明该任务无自动化断言并给出替代（chart 注释 + helm template 渲染），非占位符。
- **类型一致性**：`authenticatedUrl(baseUrl: string): string`、`authorizeIndex(req,res): boolean`、`serveStatic(pathname,res,distRoot,distIndex,authorizeIndex,renderIndex)` 均按官方 d.ts 原文书写。
- **已知缺口**：`auth-oidc` 是整体删除还是只删 gate 部分，取决于后续"用户相关问题"的讨论——本计划按"删除 gate/OIDC/session、保留包壳"处理，若后续决定自建授权层可复用包壳。
