# Plan 2：工作区 UI 解耦（删除 vendoring，改用官方槽位）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 删掉"给官方 `dsh-client-ui-workspace` bundle 打 14 处补丁"的整套 vendoring，把工作区状态展示重新落到**官方槽位**上，让工作区插件只保留执行、生命周期与状态 API。

**Architecture:** 现状是我们**替换**了官方的工作区 UI（因此 profile 里 `ui-workspace` 被 disable），代价是每次官方 UI 变动都要重新对齐 anchor。改法是**反过来**：恢复官方 `ui-workspace` 行（它提供侧栏工作区/会话、hero、`sidebar.workspaces` 契约），我们只**新增**一个面板与入口展示 k8s 侧状态（pod 相位、指标、唤醒/休眠/清理），数据来自我们自己的 `/workspaces/api/*`。

**Tech Stack:** cordis 4 客户端槽位（`main` keyed / `sidebar.panellist` / `shell.overlay`）、React、esbuild（`scripts/build-pkg.mjs`）、vitest、helm、Chrome CDP。

## Global Constraints

- **这是 Plan 3（升 0.2.0-rc.2）的前置**：0.2.x 上那 14 个 anchor 有 7 个失效，不解耦就升级会让工作区 UI 直接坏掉。
- **状态展示不能丢**（用户明确要求）：工作区列表、pod 相位、指标、唤醒/休眠/清理必须仍然可见。官方**没有工作区行的槽位**（`ProjectRowItem` 无 `renderSlot`，bundle 只导出 `apply`/`inject`），所以状态展示落在 `main` 面板 + `sidebar.panellist` 入口，**不做行内徽标**。
- 工作区插件与身份解耦的契约不变：不引入任何用户/权限概念；面板只读状态 + 触发生命周期动作。
- 不改 DSH 版本（升级是 Plan 3）；不引入新运行时依赖；不 fork 官方包。
- 现有验证设施保持绿：`pnpm -r build`、`pnpm -r test`、`harness-profile.sh`、`check-plugin-imports.mjs`、两个 smoke。

---

### Task 1：恢复官方 `ui-workspace` 行

**Files:** `docker/profiles/web.cordis.patch.yml`

- [ ] **Step 1:** 删除 `- id: ui-workspace / disabled: true` 及其注释（该 disable 的原始理由是"vendored 浏览器与官方都注册 `workspace` locale 命名空间会崩"，随着 vendoring 删除，这个理由消失）。
- [ ] **Step 2:** `bash scripts/harness-profile.sh <tmp>` 通过；`--dump-config` **stderr 为空**且 dump 里 `ui-workspace` 行**未被 disable**。
- [ ] **Step 3:** 提交。

### Task 2：状态面板（`main` + `sidebar.panellist`）

**Files:** 新增 `packages/workspace-k8s/src/client/panel.tsx`（或等价），改造 `src/client/index.tsx`（去掉对 vendored bundle 的依赖）

**Interfaces:**
- Consumes: `/workspaces/api/list`（返回 `{workspaceId, path, title, phase, hasPod, hasPvc, activeSessions, wakeCount, sleepCount, metrics, timeline}`）、`/workspaces/api/{ensure,sleep,delete,status}`
- Produces: 一个注册进 `main`（keyed）的面板 + 一个 `sidebar.panellist` 入口项

- [ ] **Step 1:** 先写失败测试：用假 API 断言面板在 `phase=running/sleep` 下分别渲染出对应文案，且"休眠/唤醒"动作会调用正确的 API 方法。
- [ ] **Step 2:** 跑测试确认失败。
- [ ] **Step 3:** 实现面板：工作区列表（名称/相位/CPU/内存/最近时间线）、每行动作（唤醒、休眠、清理）、失败时显示 API 返回的 `error.message`（**不要静默**）。
- [ ] **Step 4:** 注册槽位：`main` keyed 面板 + `sidebar.panellist` 入口；`shell.overlay` 状态药丸可选（仅在冷启动/休眠中时显示）。
- [ ] **Step 5:** 跑测试确认通过；提交。

### Task 3：删除 vendoring 链路

**Files:** 删除 `scripts/vendor-workspace-browser.mjs`、`scripts/enable-workspace-ui.mjs`、`packages/workspace-k8s/src/client/vendored-workspace.ts`、`packages/workspace-k8s/src/client/styles.ts`（若仅服务于 vendored UI）、`packages/workspace-k8s/src/client/WorkspaceDetailView.tsx`（若不再有入口）；修改 `docker/dsh-web-platform.Dockerfile`（去掉 enable-workspace-ui 步骤与相关注释）、`scripts/harness-profile.sh`、`packages/workspace-k8s/package.json`（去掉不再需要的 devDependency 与构建步骤）、`.github/workflows/release.yml`（去掉对应构建命令）

- [ ] **Step 1:** 逐一删除并在每次删除后 `pnpm -r build`，确保失败点被显式处理而不是被注释掉。
- [ ] **Step 2:** `grep -rn "vendored-workspace\|vendor-workspace-browser\|enable-workspace-ui" --exclude-dir=node_modules` 无残留（历史文档除外，逐一列出）。
- [ ] **Step 3:** `bash scripts/harness-profile.sh <tmp>` + `check-plugin-imports.mjs` + 两个 smoke 全绿。
- [ ] **Step 4:** 提交（每个删除步骤一个提交，便于回滚）。

### Task 4：确保目录选择器仍工作

**Files:** `packages/workspace-picker/**`（如需）、profile

- [ ] **Step 1:** 确认 `workspace-picker`（官方 host `ctx.directoryPicker` 抽象类的实现）仍被插入，且官方 `ui-directory-picker-browse` 仍挂载，二者配合提供 k8s PVC 目录浏览。
- [ ] **Step 2:** 若恢复官方 `ui-workspace` 后出现了第二个目录选择入口（官方自带的 `directory-picker` 行），确认我们的实现仍然胜出，且没有重复注册。
- [ ] **Step 3:** 提交。

### Task 5：端到端验证（真机）

- [ ] **Step 1:** tag → CI → 部署到测试集群（沿用现有 values）。
- [ ] **Step 2:** 用 `.dshcmp/browser-verify.mjs` 走真登录，断言：侧栏渲染官方工作区/会话、**状态面板可见且显示实时 pod 相位**、console errors 为 0。
- [ ] **Step 3:** 触发一次休眠/唤醒，断言面板状态随 API 变化（这是状态展示"没丢"的实证）。
- [ ] **Step 4:** 记录结果并把截图附在报告里。

---

## Self-Review

- **覆盖**：设计 §4.3（状态展示的落点）→ Task 2；§3/§9 的 vendoring 删除 → Task 3；§4.4（插件契约）→ 全程约束；Plan 3 的前置要求 → Global Constraints。
- **风险**：恢复官方 `ui-workspace` 会重新引入官方的工作区 UI（含它自己的工作区创建/删除入口），可能与我们的 `workspace-picker`/生命周期动作重叠——Task 4 专门处理；若官方入口与我们冲突，优先**保留官方**、把我们的动作收进面板，而不是再打补丁。
- **不做**：行内徽标（官方无该槽位）；per-user 语义（用户已推迟）；0.2 升级（Plan 3）。
