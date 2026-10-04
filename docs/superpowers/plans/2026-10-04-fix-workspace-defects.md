# Plan 4：修复三个用户可见缺陷 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 让工作区↔会话的归属在控制面重建后仍然存在（不再"更新后变未分组"），让空闲工作区真的休眠、手动休眠可见且有效，并消除 `cwd=/` 这种永久损坏的会话。

**Architecture:** 三处根因，两类改动：
1. **持久化路由错误**——官方 `dsh-workspace` 的注册表本应落 Postgres，实际落在 `$DSH_HOME/storages/workspace.json`（emptyDir，每次换 Pod 全丢），因为我们从未覆盖官方 `storage-domain` 行的 `backend: json`。
2. **重建时机错误**——注册表在 boot 时做一次性 `initialized` 引导，而 `/workspaces/<id>` 锚点要等 60 秒后的 reconciler 才出现，晚了；之后读取按索引过滤、写入按索引**持久化剪除**，所以归属再也回不来。
3. **休眠状态机缺陷**——空闲计时器只在"本进程创建 Pod"时装上（boot 时不认领既有 Pod ⇒ 计时器从未存在）；"空闲"定义为"活跃会话对象为 0"而该计数永不递减；手动休眠在非 `running` 相位静默无事发生且 API 仍回 `{ok:true}`；每次 fs/subprocess 调用的 `ensure` 会在秒级把刚睡下的 Pod 重建。

**Tech Stack:** cordis 4、TypeScript、vitest、PostgreSQL、helm、Chrome CDP（浏览器验证）。

## Global Constraints

- 控制面必须无状态、可 `readOnlyRootFilesystem` 运行；**任何持久状态只能进 Postgres**，`DSH_HOME` 里不许有承载语义的文件。
- **顺序约束**：`storage-domain` 改 postgres 与"启动即 reconcile + 归属重建"必须**同批上线**。只改后端会在锚点缺席时把空的归属集合写进 Postgres，而 `initialized: true` 会让它**永久固化**。
- 不引入编译产物补丁、不 fork DSH。
- 工作区插件与身份解耦的契约不变（不引入任何用户/权限概念）。
- 现有验证设施必须保持绿：`pnpm -r build`、`pnpm -r test`、`scripts/harness-profile.sh`、`scripts/check-plugin-imports.mjs`、`scripts/smoke-zero-patch.mjs`、`scripts/smoke-official-integration.mjs`。

---

## Part A：归属持久化与重建（缺陷 ②，并消除缺陷 ① 的产生条件）

### Task A1：profile 覆盖官方 `storage-domain` 为 postgres

**Files:** `docker/profiles/web.cordis.patch.yml`、`docker/profiles/headless.cordis.patch.yml`

- [ ] **Step 1:** 以**顶层行**（不是 `insert:`）新增：
  ```yaml
  - id: storage-domain
    config:
      backend: postgres
  ```
  两个 profile 都要加。注释写明：官方 `dsh-workspace` 经 `ctx.storageDomain` 持久化，默认 `backend: json` 落在 `DSH_HOME`（emptyDir），改 postgres 才符合"控制面无状态"。
- [ ] **Step 2:** 确认我们的 `storage-db` 注册的 backend 名就是 `postgres`（读 `packages/storage-db/src/index.ts` 的注册处），若名字不同则改配置而不是改后端名。
- [ ] **Step 3:** `bash scripts/harness-profile.sh <tmp>` 通过；`--dump-config` stderr 为空，且 `storage-domain` 行的 config 出现在 dump 中。
- [ ] **Step 4:** 提交。

### Task A2：启动即 reconcile（锚点先于注册表引导）

**Files:** `packages/workspace-k8s/src/index.ts`（+ 测试）

- [ ] **Step 1:** 先写失败测试：用一个假 registry/persistence 装配插件，断言 `apply()` 后**无需等待定时器**就已调用过一次 reconcile。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3:** 在挂载 reconciler 定时器之前同步（或立即异步）跑一次 `reconcile()`；保留 60 秒定时器作为重试。失败不得让插件加载失败（记日志继续）。
- [ ] **Step 4:** 跑测试确认通过。
- [ ] **Step 5:** 提交。

### Task A3：归属重建（detach + attach）

**Files:** `packages/workspace-k8s/src/registry.ts`、`src/reconciler.ts`（+ 测试）

**Interfaces（来自诊断报告，逐字）:**
- 官方能力：`resolveByPath(path)`（`dsh-workspace/lib/index.js:476-481`）、实体的 `attachSession(id)` / `detachSession(id)`。
- `attachSession` 对 `record.sessionIds.includes(id)` 会**短路**（`:111-112`），只有非包含分支才刷新索引（`:122`）；因此**必须先 detach**。
- 排序：**oldest-first 调用 attach**，因为它是 prepend，最终得到 newest-first。

- [ ] **Step 1:** 先写失败测试：给定会话列表（含一个 cwd 匹配某记录路径、一个不匹配、一个已包含），断言只对匹配者执行 `detach → attach`，顺序为 oldest-first，且重复执行幂等。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3:** `registry.ts` 暴露 `resolveByPath` 与 attach/detach（注意现有 `list()` 会擦除实体，别让新能力走同一条路径）；`reconciler.ts` 增加 rebind 段：读 `ctx.sessionPersistence.list()`，按 `header.cwd` 命中记录 `path` 的会话执行 detach→attach。
- [ ] **Step 4:** 跑测试确认通过；跑 `pnpm -r test` 确认没破坏既有 67 个测试。
- [ ] **Step 5:** 提交。

### Task A4：线上验证 Part A

- [ ] **Step 1:** 打 tag 走 CI 构建镜像，部署到测试集群。
- [ ] **Step 2:** 部署后立刻检查：容器内 `$DSH_HOME/storages/workspace.json` **不再增长/不再被读取**，且 `dsh_storage_units` **出现 `workspace` 行**、`dsh_storage_records` **行数 > 0**。
- [ ] **Step 3:** 再换一次 Pod（`kubectl rollout restart`），断言侧栏的会话归属**仍然存在**（用 `.dshcmp/workspace-probe.mjs` 取清单 + 浏览器读侧栏文本比对）。
- [ ] **Step 4:** 记录结果。

---

## Part B：休眠（缺陷 ③）

### Task B1：认领既有 Pod，装上空闲计时器

**Files:** `packages/workspace-k8s/src/lifecycle-manager.ts`、`src/index.ts`、`src/state-machine.ts`（+ 测试）

- [ ] **Step 1:** 先写失败测试：给定一个"Pod 已存在但管理器无状态"的工作区，调用认领后断言其相位为 `running`、`provisioned: true`，并且随后空闲到期限时会发出 sleep。**注意**：不要预设 `idleSince`——装会计时器的分支要求它在 `state-machine.ts:234` 时为 `undefined`。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3:** 实现 `observePod(workspaceId)`：无状态则种子化并投递 `pod-ready`；在 boot 与每 60 秒 pass 里对**每个已存在的 Pod** 调用（只对 Pod，不对 PVC）。`idleTimeoutMs`/`graceMs` 做 `Number.isFinite` 校验，避免 NaN 让定时器立即触发。
- [ ] **Step 4:** 让"经 `resolveEndpoint` 唤醒"的 Pod 也被跟踪（未跟踪则 observe，`sleep` 相位则 attach），但**不要**在每次 fs 操作里 attach（`attach` 会清 `idleSince`，等于把空闲计时器永久推迟）。
- [ ] **Step 5:** 跑测试确认通过。
- [ ] **Step 6:** 提交。

### Task B2：手动休眠可见且有效

**Files:** `src/state-machine.ts`、`src/lifecycle-manager.ts`、`src/management.ts`、`src/wire.ts`、`src/api.ts`、`src/k8s-client.ts`（+ 测试）

- [ ] **Step 1:** 先写失败测试：①在 `provision`/`waking` 相位收到 `sleep-requested` 时放弃唤醒并转入 sleep，而不是返回 `{kind:'none'}`；②`sleep()` 返回一个可区分的结局（disposed / noop），并能在 API 响应里体现；③在途 `ensure` 在 dispose 后不得再发出 `pod-ready`；④`deletePod` 对非 404 错误重抛。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3:** 实现四处：所有存活相位处理 `sleep-requested`；`sleep()` 返回 `Promise<SleepOutcome>` 并沿 wire/management/api 上报；`dispose` 让在途 ensure 失效（`waitReady` 之后若相位已非 provision/waking，则删 Pod 且不发 `pod-ready`）；`deletePod` 只容忍 404，其余记日志并重抛。
- [ ] **Step 4:** 给 `onBeforeSleep` 的 fetch 加超时（`AbortSignal.timeout`），避免睡眠挂死。
- [ ] **Step 5:** 跑测试确认通过；`pnpm -r test` 全绿。
- [ ] **Step 6:** 提交。

### Task B3：线上验证 Part B

- [ ] **Step 1:** 打 tag、CI、部署（同 A4 流程）。
- [ ] **Step 2:** 部署后对 5 个老 Pod 断言：`/workspaces/api/list` 出现 `timeline` 条目且最终 `sleepCount ≥ 1`、Pod 被回收（`hasPod: false` 或 Pod 消失）。
- [ ] **Step 3:** 手动休眠一次：断言 API 返回明确结局、Pod 真的消失、且**不被下一次操作立刻重建**（观察 ≥2 分钟）。
- [ ] **Step 4:** 唤醒一次：断言 Pod 重建、`wakeCount` 增加，且重建后**仍会被空闲回收**（这是 RC1 的回归防线）。
- [ ] **Step 5:** 记录结果。

---

## Part C：`cwd=/` 的坏会话

- [ ] **Step C1:** 先确认产生条件是否已被 Part A 消除（工作区清单不再有窗口期）。若仍能产生，单独定位并堵住入口。
- [ ] **Step C2:** 那 3 个既有坏会话**不擅自删除或改写**（属于用户数据）：向用户说明并给出两个选项——删除，或改 `t_sessions.f_cwd` 重新绑定到指定工作区。

---

## Self-Review

- **覆盖**：诊断报告的 RC1/RC2（持久化与重建）→ Task A1–A3；RC1–RC4（休眠）→ Task B1–B2；缺陷 ① → Task C。
- **顺序约束**：A1 与 A2+A3 **必须同批**（见 Global Constraints），已在 A4 的验证里体现为"换 Pod 后归属仍在"。
- **不在本计划**：per-user 身份/授权（用户已明确推迟）；DSH 0.2 升级（Plan 3）；工作区 UI 解耦（Plan 2）。
- **已知不可在本机验证项**：镜像仍需 CI 构建；kind 冒烟仍无法本地端到端跑。
