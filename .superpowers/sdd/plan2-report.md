# Plan 2 报告：工作区 UI 解耦（Tasks 1–4）

**执行者**：subagent（Tasks 1–4）。**Task 5（真机部署 + 浏览器验证）不在本次范围内**（无集群访问），未执行。
**仓库**：`/home/ovizro/Code/dsh-platform`，分支 `main`。
**状态**：DONE_WITH_CONCERNS（见 §6；均为"未能本地验证"类，不是已知缺陷）。

---

## 1. 逐任务结果

### Task 1 — 恢复官方 `ui-workspace` 行 ✅

**Files**：`docker/profiles/web.cordis.patch.yml`

删除了 `- id: ui-workspace / disabled: true` 及其注释（注释里"vendored 浏览器与官方都注册
`workspace` locale 命名空间会崩"的理由随 vendoring 一起失效），替换为一段说明官方行回归、
平台只**新增**槽位的注释。

**验证**（见 §4.1）：`dsh --profile web --dump-config` 退出 0、**stderr 0 字节**，
dump 中 `ui-workspace` 行存在且**没有** `disabled`。

**Commit**：`1e41c41`

---

### Task 2 — 状态面板（`main` + `sidebar.panellist` + 可选 `shell.overlay`）✅

**新增/改动文件**

| 文件 | 作用 |
|---|---|
| `packages/workspace-k8s/src/client/panel-model.ts`（新） | 纯视图模型：相位文案、倒计时、每相位可做的动作、动作→API 语义、指标/时间线文案、药丸可见性 |
| `packages/workspace-k8s/src/client/register.ts`（新） | **无 React** 的槽位注册：`main`(keyed) + `sidebar.panellist`(list) + `shell.overlay`(list) |
| `packages/workspace-k8s/src/client/panel.tsx`（新） | 三个组件：面板、侧栏图标、药丸；`useSyncExternalStore` 订阅快照，挂载期轮询 2s |
| `packages/workspace-k8s/src/client/store.ts`（改） | 快照增加 `error` / `pendingId` / `loading`；`poll()` 失败把 `error.message` 写进快照；`runStatusAction` 失败写快照并 reject |
| `packages/workspace-k8s/src/client/index.tsx`（改） | `apply()` 只剩：注入样式 + 注册三类槽位。inject 从 8 项缩到 `['slots','locale','layout']` |
| `packages/workspace-k8s/src/client/styles.ts`（改） | 删除详情页 CSS，新增面板/图标/药丸 CSS；导出 `injectPanelStyles()` |
| `packages/workspace-k8s/src/client/WorkspaceDetailView.tsx`（删） | 旧 `conversation.view`"工作区"页；其数据（pod/指标/k8s/时间线）已在面板中 |

**行为要点**

- **按相位渲染**：`running`（有 idle/grace deadline 时显示 `⏳ m:ss 后休眠`）、`sleep`、`provision`/`waking`、
  `orphan`、`deleted`、`unknown`；deadline 已过显示 `0:00`，不出现负数。
- **每相位动作**（相斥、不会同时给唤醒与休眠）：`sleep`/`unknown` → 唤醒(ensure)+删除；
  `running` → 休眠(sleep)+删除；`orphan` → 清理(cleanup)+删除；`deleted` → 无。
  删除是**两步**（确认删除/取消）。
- **失败必显**：面板顶部 `role="alert"` 横幅直出 API 的 `error.message`；列表轮询失败同样进
  `snapshot.error`；面板从不因失败而"看起来还活着"。store 里没有任何 `catch {}`。
- **不做行内徽标**：`ProjectRowItem` 无 `renderSlot`、bundle 只导出 `apply`/`inject`——按计划放弃，
  状态落在面板（0.1.5 与 0.2.x 均如此，已在 0.2.0-rc.2 的类型与 bundle 中复核）。
- **与身份无关**：没有引入任何用户/权限/会话归属概念；面板只读 `/workspaces/api/list` 并派发
  生命周期动作。
- **可选药丸**：仅当有 `provision`/`waking`/`sleep` 的工作区时渲染，其余时候 `return null`。

**TDD 过程**：先写 `tests/panel-model.spec.ts` + `tests/panel-slots.spec.ts`，确认**失败**
（`Failed to load url ../src/client/panel-model.ts / register.ts`），再实现，再转绿。

**测试**（workspace-k8s 146 passed / 19 files）：
- `tests/panel-model.spec.ts`（30）：相位文案、倒计时（含 deadline 过期钳位）、每相位动作集合、
  动作标签/确认标签、`timelineHead`、药丸可见性、**API 方法派发**（ensure/sleep/cleanup/delete →
  对应 endpoint 与 `{workspaceId}` body）、动作后重新 list、**错误message 进快照并同时 reject**、
  失败轮询的 error、成功后清 error、`startPolling` 立即+间隔+dispose。
- `tests/panel-slots.spec.ts`（6）：注册的三个槽位与 id/key、label、组件非空、槽位未声明时**等待**
  而不抢先注册、**不得**占用 `sidebar.workspaces` / `conversation.hero.workspace` / `conversation.view` / `sidebar`。
- `tests/client-bundle.spec.ts`（5）：用假 `window.__ModuleLoader__` **真实物化 `lib/client.js`**
  （镜像里加载的那个产物），断言导出了 `apply`、注册了三个槽位、未占用官方 surface、产物里**不含**
  vendored bundle 字符串、且**只提供 `slots` 服务的 ctx 也能 apply**（不再读 `remote`/`workspaces`/`sessions`，
  这正是旧版把整个插件挂起的坑）。

**Commit**：`7aa7e60`

---

### Task 3 — 删除 vendoring 链路 ✅

**删除清单（每个删除后都跑 `pnpm -r build`，逐个提交）**

| 删除 | 它当时"撑着"什么 | 删除后的处理 |
|---|---|---|
| `scripts/vendor-workspace-browser.mjs` | 把官方 bundle 抠出来、打 14 处补丁并生成 vendored 文件 | 无引用；`pnpm -r build` 仍绿（`9b54fcf`… 构建在 `cd70daa` 前后各跑一次） |
| `packages/workspace-k8s/src/client/vendored-workspace.ts`（261 KB 生成物） | `index.tsx` 里 `eval()` 后经 `ctx.get('modules')` 注册 | `index.tsx` 在 Task 2 已改为直接注册官方槽位，故无引用 |
| `scripts/enable-workspace-ui.mjs` | ① 把 `@visecy/dsh-workspace-k8s` 塞进 `dsh.profile.bundles`；② （名字造成的）"启用 UI"印象 | 见下方**关键发现**：插件宿主行由 profile 的 `cordis.patch.yml` `insert:` 提供（`workspace-runtime`），客户端半边由 `dsh-client-modules` 依据 loader entry 的 `dsh.client` 声明装载；profile bundle 声明是**冗余的**（删除前后 `--dump-config` 差异 = 少了一个重复的 bundle 层行，`workspace-runtime` 仍在），故安全删除 |
| `packages/workspace-k8s/src/client/WorkspaceDetailView.tsx` | `conversation.view`"工作区"入口 | 已在 Task 2 随面板落地一起删除（数据不丢） |
| `packages/workspace-k8s/package.json` 的 `@deepseek-ai/dsh-client-ui-workspace` devDependency | 只有 vendoring 脚本读官方 bundle 才需要 | 删除并刷新 lockfile（`pnpm install --prefer-offline --store-dir /home/ovizro/Code/.pnpm-store`，lock 仅少 12 行） |
| `docker/dsh-web-platform.Dockerfile`：`COPY enable-workspace-ui.mjs` + `RUN node …enable-workspace-ui.mjs` | 把 bundle 层声明写进镜像 profile | 两处删除，注释改为说明"插件自带 `dsh.client` 声明，无需注入步骤" |
| `scripts/harness-profile.sh`：`node …/enable-workspace-ui.mjs "$PROFILE"` | 同上（harness 与镜像同构） | 删除，改为注释说明；其余步骤（两个 profile 的 pnpm add、check-plugin-imports、loopback 检查、smoke 用官方包）不变 |
| `.github/workflows/release.yml` | 其 "Build packages" 步骤逐包调 `build-pkg.mjs`（**只打包宿主半边**） | **保留了 `node scripts/build-workspace-ui.mjs`** 并加注释：镜像 COPY 的是这个 checkout，`lib/client.js` 必须在 CI 重新生成，否则发布出陈旧客户端。这不是 vendoring 遗留，而是客户端半边的构建步骤 |
| `docs/superpowers/plans/…`、`design/*.md`、`.superpowers/sdd/*`、`README.md` 提及 | 历史/计划文档 | 历史文档保留并逐一列出（§4.4）；`README.md` 是**现役文档**，已改写（`5c9bf6a`） |

**残留 grep（Task 3 Step 2）**：见 §4.4，逐条给理由。

**Commits**：`cd70daa`（两个文件）、`dcab0df`（harness）、`9b54fcf`（image）、`d08b50c`（release）、`5c9bf6a`（README）、`7898fc1`（devDependency + lock）

---

### Task 4 — 目录选择器仍然可用 ✅

**结论：无需改代码；新增一份契约测试把不变量钉住。**

- `workspace-picker`（官方 host `ctx.directoryPicker` 抽象类的实现）仍作为 `insert:` 行被装入，
  且**仍胜出**：官方 `- id: directory-picker`（`@deepseek-ai/dsh-host-directory-picker-auto`）仍是
  `disabled: true`。
- 恢复 `ui-workspace` **没有**带来第二个 directory picker：官方 ui-workspace 客户端只**消费**
  `directoryFlow`（`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`），
  不注册 provider（在 vendored 原文与 0.2.x bundle 中复核）。
- 官方 `ui-directory-picker-browse` 仍挂载，与我们的 picker 配合提供 k8s PVC 目录浏览。
- **无重复注册**：`--dump-config` 顶层 row id **无重复**（`grep -o "^- id: .*" | sort | uniq -d` 为空）。
  这一点很关键：`DirectoryPicker` 基类注释写明"每个 context 只能有一个实现，加载第二个会抛
  cordis 标准 duplicate-service"。
- 新增 `packages/workspace-k8s/tests/profile-workspace-ui.spec.ts`（4 tests）：patch 层里**不存在**
  `ui-workspace` 行（即 disable 不会回来）、`directory-picker` 仍 disabled、`workspace-picker` 与
  `ui-directory-picker-browse` 各恰好一次、`workspace-runtime` 仍在。

**Commit**：`8a08e0d`

---

## 2. 关键发现（执行中发现的、计划未覆盖的事实）

1. **`enable-workspace-ui.mjs` 是"名不副实"的双职责脚本**：它唯一做的事是把
   `@visecy/dsh-workspace-k8s` 追加进 `dsh.profile.bundles`（一个 patch 层 bundle），**不是**启用
   UI 的必要条件。删除后用全新 harness 实测：`dsh --profile web --dump-config` 仍含
   `- id: '@visecy/dsh-workspace-k8s'`（来自 bundle 层）**与** `- id: workspace-runtime`（来自
   profile patch 层 `insert:`）。两点说明：
   - 该 bundle 声明与 `workspace-runtime` **重复**（旧配置里同一包被装载两次）；
   - 客户端半边由 `dsh-client-modules` 的 `ClientModuleRegistry` 扫描 **host loader entries** 的
     `dsh.client` 声明决定（构造函数里 `for (const entry of ctx.loader.entries())` + `require.resolve`
     该包名），与 `dsh.profile.bundles` 无关。`@visecy/dsh-workspace-k8s` 是 loader entry 且其
     package.json 声明了 `dsh.client`，所以面板仍会被装载。
   - **未能本地实证**这一点（本地 `dsh` CLI 是 0.2.0-rc.2，会把 0.1.5-rc.1 的插件行按版本策略
     disable，无法启动 profile）——见 §6 第 1 条。
2. **`lib/client.js` 的覆盖方式**：`esbuild` 生成 `module.exports = __toCommonJS(index_exports)`
   之后才执行 `panel-model.ts` 的顶层代码，但 `index_exports` 的属性是 **getter**
   （`apply: () => apply`），所以 factory 返回时 `apply`/`inject` 仍在。已用假
   `__ModuleLoader__` 真实物化产物验证（`tests/client-bundle.spec.ts`），并在实现中途一度看到
   `__export` 表为空（我当时在源码里插了 `export const __probe` 探查，随后已完全还原）——
   因此这条测试是有价值的：**它会在产物导出表被破坏时失败**（`apply` 缺失 = 浏览器里整个插件消失）。
3. **另一个会话正在并发修改 `packages/session-persistence-rdb`**（`migration-v4.spec.ts`、
   `testing/sqlite-raw.ts` 未跟踪，`rdb.spec.ts`/`testing/agent-loop.ts`/`package.json` 被改，
   时间戳 01:24–01:25）。因此本次 `pnpm -r test` 在该包出现 9 个 migration 失败——**与本次改动无关**，
   我按路径提交，未触碰该包任何文件。详见 §4.2。

---

## 3. 未能验证 / 已知限制

1. **未做真机/浏览器验证**（Task 5 属 lead；本会话无集群访问）。因此"侧栏渲染官方工作区/会话、
   面板显示实时 pod 相位、休眠/唤醒后状态随 API 变化、console errors 0"这些只由代码与单元测试覆盖。
2. **未在 0.1.5-rc.1 CLI 下启动过完整 profile**：本机 `dsh` 是 **0.2.0-rc.2**，会把 profile 里所有
   0.1.5-rc.1 的官方行（`session`、`storage-domain` …）与 `@visecy/dsh-*@0.1.22` 行按 peer 版本策略
   **disable**（输出见 §4.3 harness 日志尾部）。因此 `harness-profile.sh` 用的是 0.1.5-rc.1 运行时包，
   而客户端 UI（`dsh-client-ui-*`）来自本机 CLI = 0.2.0-rc.2 的 bundle 层。这带来两点：
   - **好消息**：本仓库的客户端半边在 **0.2.0-rc.2 的槽位契约**下同样是合规的（我据此复核了
     `main` keyed / `sidebar.panellist` list / `shell.overlay` list 与 panellist 图标的
     `{size, active}` props）。
   - **风险**：见 §6 第 2 条。
3. **未跑 Docker 构建**（无法起 docker/无审批）；Dockerfile 改动是纯删除 + 注释，已逐行复核。
4. `pnpm -r test` 的 PostgreSQL 门控跳过符合预期：`session-persistence-rdb` 2 files / 24 tests skipped。

---

## 4. 命令与输出

### 4.1 `bash scripts/harness-profile.sh <tmpdir>`

```
$ bash scripts/harness-profile.sh "$PWD/.tmp-harness-final"      # exit=0
…
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain
ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-identity-bridge

check-plugin-imports: all 8 plugins import cleanly from …/.tmp-harness-final/home/profiles/web
ok   @visecy/dsh-fs-k8s
… (headless: 6 plugins) …
ok   official CLI refuses --host 0.0.0.0 (exit 1): dsh: disabling profile plugin row "session": Plugin
     @deepseek-ai/dsh-session@0.1.5-rc.1 is incompatible with dsh 0.2.0-rc.2: peerDependencies
     {"@deepseek-ai/dsh-scope":"^0.1.5-rc.1"}. …EXACT-VERSION EXEMPTION NOT ACTIVE
harness ready: /home/ovizro/Code/dsh-platform/.tmp-harness-final
```

（那一行 0.2.0-rc.2 的版本策略输出是**本机 CLI 版本不匹配**造成的，不是配置错误；见 §3.2。）

**Task 1 Step 2 / dump 断言**：

```
$ DSH_HOME=…/.tmp-harness-final/home dsh --profile web --dump-config > dump.yml 2> dump.err
dump exit=0 stderr_bytes=0
$ grep -n -A2 "^- id: ui-workspace$" dump.yml
598:- id: ui-workspace
599-  name: '@deepseek-ai/dsh-client-ui-workspace'
600-- id: ui-workflow-run
   (无 disabled 行)
$ grep -o "^- id: .*" dump.yml | sort | uniq -d          # 无重复 row id
   (空)
$ grep -n "@visecy/dsh-workspace-k8s'" dump.yml
1291:  name: '@visecy/dsh-workspace-k8s'                     # workspace-runtime 行，enabled
$ node -e "console.log(require('./.tmp-harness-final/home/profiles/web/package.json').dsh.profile.bundles)"
[ '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app' ]   # 已无注入的 bundle 声明
```

### 4.2 `pnpm -r build` / `pnpm -r test`

`pnpm -r build`（最终，exit=0）：

```
packages/fs-k8s build: Done
packages/subprocess-k8s build: Done
packages/workspace-k8s build: built workspace-k8s -> dist/index.js
packages/workspace-k8s build: built @visecy/dsh-workspace-k8s client UI -> lib/client.js
packages/workspace-k8s build: Done
```

`pnpm -r test`（**逐包结果**；`session-persistence-rdb` 的失败来自并发会话，见下）：

| 包 | 结果 |
|---|---|
| sandbox-daemon | 6 files / **36 passed** |
| fs-k8s | 1 file / **16 passed** |
| subprocess-k8s | 1 file / **16 passed** |
| **workspace-k8s** | 19 files / **146 passed** |
| workspace-picker | 1 file / **7 passed** |
| identity-bridge | 5 files / **31 passed** |
| storage-db | 1 file / **1 passed** |
| platform-domain | 1 file / **2 passed** |
| user-domain | 1 file / **11 passed** |
| auth-oidc | 1 file / **7 passed** |
| session-persistence-rdb | 第一次运行（本次改动后、lockfile 未变）：6 files passed + 2 skipped；108 passed + **24 skipped（PostgreSQL 门控，预期）**，0 failed。第二次运行出现了 9 个 `migration-v4` 失败（来自并发会话，见下） |

**为什么 `session-persistence-rdb` 第二次失败与本次改动无关**：同一命令的第一次运行（改动集合
完全相同、lockfile 尚未变化）该包是 **108 passed / 24 skipped / 0 failed**，且当时
`migration-v4.spec.ts` 根本不在测试文件列表里；随后我在 01:25–01:26 之间观察到该包源码被另一个
会话写入（`migration-v4.spec.ts`、`testing/sqlite-raw.ts` 均为未跟踪新文件，时间戳 01:24–01:25）。
我的提交只用显式路径（`git add packages/workspace-k8s/package.json pnpm-lock.yaml`），没有触碰该包。
`task-4-logs/.tmp-verify-6.log` 里也留有同一包更早的失败记录，说明这是该会话正在进行的工作。

### 4.3 `node scripts/check-plugin-imports.mjs <profile>`

```
$ node scripts/check-plugin-imports.mjs "$PWD/.tmp-harness-final/home/profiles/web"
ok   @visecy/dsh-fs-k8s
ok   @visecy/dsh-subprocess-k8s
ok   @visecy/dsh-workspace-k8s
ok   @visecy/dsh-session-persistence-rdb
ok   @visecy/dsh-storage-db
ok   @visecy/dsh-platform-domain
ok   @visecy/dsh-workspace-picker
ok   @visecy/dsh-identity-bridge

check-plugin-imports: all 8 plugins import cleanly from …/profiles/web      # exit=0
```

（headless：`all 6 plugins import cleanly`，由 harness 步骤自带。）

### 4.4 两个 smoke

```
$ node scripts/smoke-zero-patch.mjs --target …/profiles/web/node_modules          # exit=0
ok   [string guard] official connection has no cookie-layer bypass (deleted patch P2)
ok   [string guard] official connection has no isLoopback pin (deleted patch P1)
ok   [string guard] official webserver carries no registerGate fork extension
ok   [string guard] official client still reads the transport hook the plugin publishes
ok   1a. __DSH_TRANSPORT__ is injected through webserver/index-inject
ok   1b. the injected transport hook says ownsHost === true
ok   2. cookieless GET / is a 302 handoff
ok   2. the handoff Location carries the launch token
ok   3a. the launch token is exchanged with a 303
ok   3b. the exchange mints the official browser cookie
ok   3c. the exchange redirects to clean /
ok   3d. clean GET / with the cookie renders the index (200)
ok   3e. the transport global is rendered into the served HTML
ok   3f. the transport global lands before the boot-readiness tail
ok   4a. /api without the cookie is refused 401
ok   4b. the same /api request with the cookie passes the official fence (404, not 401)
ok   5a. ctx.dshAuth.currentUser reads x-forwarded-user / x-forwarded-groups
ok   5b. ctx.dshAuth.currentUser reports no principal without the user header
ok   5c. the principal is readable on a live request
ok   fence: a foreign Host never receives the launch token (403)

ZERO-PATCH SMOKE OK: the unpatched official composition serves the platform auth path
```

```
$ node scripts/smoke-official-integration.mjs --target …/profiles/web/node_modules   # exit=0
ok   fixture is unpatched (no cookie bypass)
ok   fixture is unpatched (no isLoopback pin)
ok   fixture has no webserver fork extension (no registerGate)
ok   transport hook is read by the official client
ok   transport hook honours ownsHost
ok   identity-bridge publishes the transport hook as an index-inject global
ok   ownsHost hook satisfies the official isLoopback expression
ok   without the hook the same expression stays false
ok   the official connection exposes both exchange entry points
ok   authenticatedUrl carries the process launch token
ok   the official cookie layer is still ACTIVE (401 without it)
ok   the exact / route hands a cookieless browser to the token exchange
ok   the token exchange redirects to clean / (303)
ok   the token exchange mints the signed browser cookie
ok   the cookie satisfies the official check (no 401)
ok   a wrong token is refused (sent back through the handoff, never a dead 401)
ok   the Host/Origin fence still applies to a cookie holder
ok   index served without any connection patch
ok   __DSH_TRANSPORT__ injected as a head global
ok   transport global lands before the boot-readiness tail
ok   the booted webserver has no registerGate seat (no fork needed)
ok   identity-bridge provides ctx.dshAuth over the sidecar headers

OFFICIAL-INTEGRATION SMOKE OK: both patches have a supported replacement, and identity-bridge uses it
```

### 4.5 残留 grep（Task 3 Step 2）与逐条理由

命令：`grep -rn "vendored-workspace\|vendor-workspace-browser\|enable-workspace-ui" --exclude-dir=node_modules --exclude-dir=.git .`

**零处"活的"引用**：没有任何构建脚本、profile、Dockerfile、workflow、包源码、测试、`lib/` 产物
命中。剩余命中分三类，全部是**历史/说明性文本**：

| 位置 | 性质 | 理由 |
|---|---|---|
| `.superpowers/sdd/fixwave-report.md`、`progress.md` | 历史报告/进度记录 | 记录当时"唯一剩余补丁点"的状态；改写历史报告会伪造记录 |
| `.superpowers/sdd/review-*.diff`（2 个） | 既往 review 的 diff 归档 | 同上，是某一历史 commit 区间的原始 diff |
| `.superpowers/sdd/task-4-logs/.tmp-verify-6.log` | 既往验证日志 | 同上 |
| `design/2026-09-12-dsh-0.1.5-upgrade.md` | 历史设计文档 | 描述当时 vendoring 的锚点调整 |
| `design/2026-10-04-dsh-platform-2-design.md` | 设计文档 | §3 处置表里写的是"**删** vendoring"——即本计划的来源，属于需求文本 |
| `docs/superpowers/plans/2026-10-05-workspace-ui-decoupling.md` | 本计划本身 | 任务清单里逐字列了要删的文件名 |
| `README.md:63-64` | **现役文档**（已改写，`5c9bf6a`） | 明确写"vendoring 链路已整体删除"，是**声明已完成**，不是使用指引 |

> 说明：`packages/workspace-k8s/lib/client.js` 里已无 `vendored-browser` 字符串，
> 由 `tests/client-bundle.spec.ts` 断言。

---

## 5. 提交清单

| # | Hash | Message |
|---|---|---|
| 1 | `1e41c41` | `feat(profile): re-enable the official ui-workspace row` |
| 2 | `7aa7e60` | `feat(workspace-ui): show workspace status on official slots` |
| 3 | `cd70daa` | `refactor(workspace-ui): delete the vendored workspace browser` |
| 4 | `dcab0df` | `build(harness): stop injecting the workspace client bundle` |
| 5 | `9b54fcf` | `build(image): drop the enable-workspace-ui step` |
| 6 | `d08b50c` | `build(release): still build the workspace client bundle in CI` |
| 7 | `5c9bf6a` | `docs(readme): the workspace UI is decoupled, not vendored` |
| 8 | `8a08e0d` | `test(workspace-ui): pin the picker wiring the official row depends on` |
| 9 | `7898fc1` | `build(workspace-k8s): drop the vendored browser's official devDependency` |
| 10 | `a5497b3` | `docs(sdd): report the workspace UI decoupling (Tasks 1-4)`（本文件；`.superpowers/sdd/.gitignore` 是 `*`，需 `git add -f`，与既有 report 一致） |
| 11 | `e150cf8` | `chore: ignore verification debris at the repo root`（新增 `.tmp-*` 规则） |
| 12 | `b13c0d1` | `build(scripts): actually delete the enable-workspace-ui injector`（**补提交**：`git rm` 的删除一度被后一条 `git restore --staged` 复原，导致 `cd70daa`…`9b54fcf` 期间 HEAD 里仍留着该脚本；补提交后 `git ls-tree HEAD scripts/` 已无此文件） |

工作树：除并发会话正在写的 `packages/session-persistence-rdb/**` 与 `pnpm-lock.yaml` 外干净；
本次未提交任何该包文件。`lib/client.js` 与已提交版本一致（`git status` 无差异）；
`git ls-tree HEAD scripts/` 里已无 `enable-workspace-ui.mjs`。

> 注：`pnpm-lock.yaml` 在我提交 `7898fc1` 之后又被并发会话改动（正在升 `dsh-session` /
> `dsh-session-persistence` / `dsh-session-format-catalog` 到 0.2.0-rc.2），我**没有**再碰它；
> 我的那次 lockfile 变更（删除 `dsh-client-ui-workspace`）已在 `7898fc1` 里。

---

## 6. 风险与需要在 0.2.x 上复核的点

1. **客户端半边的装载路径只做了代码级论证，未做运行时实证**（最高优先复核项）。
   删除 `enable-workspace-ui.mjs` 后，`@visecy/dsh-workspace-k8s` 不再出现在
   `dsh.profile.bundles` 里。它仍作为 `workspace-runtime` 行被 loader 装载，而
   `@deepseek-ai/dsh-client-modules` 的 `ClientModuleRegistry` 是按 **host loader entries** 的
   `dsh.client` 声明来组装的（构造函数 `for (const entry of ctx.loader.entries())`，
   随后 `require.resolve(<entry name>)` 读其 manifest 的 `dsh.client`），因此应当照常装载。
   我在本地**无法启动 0.1.5-rc.1 profile**（本机 CLI 0.2.0-rc.2 会把该版本的行 disable）。
   **Task 5 必须在浏览器里确认面板入口存在**；若不出现，恢复方式是把
   `@visecy/dsh-workspace-k8s` 重新写回 profile 的 `dsh.profile.bundles`
   （一行 JSON，等价于被删脚本唯一的有效行为）。
2. **0.1.5-rc.1 客户端槽位契约来自我对官方包的实测复核，不是来自本地运行**：
   我下载并解包了 `@deepseek-ai/dsh-client-ui-{layout,sidebar,slots}@0.1.5-rc.1` 的
   `lib/types`，确认三件事在该版本就已存在：`main` = `{kind:'keyed', scope:'root'}`、
   `sidebar.panellist` = `{kind:'list', scope:'root'}`、`shell.overlay` = `{kind:'list', scope:'root'}`，
   且 panellist 渲染时给图标传 `{size, active}`（与 `register.ts`/`panel.tsx` 一致）。0.2.0-rc.2 的
   对应契约逐字相同（`main`/`sidebar.panellist`/`shell.overlay` 与 panellist 的 `renderSlot`
   调用点在两个版本的 bundle 中都复核过），所以面板在 0.2.x 上应当同样挂载。
3. **面板不再有 `conversation.view`"工作区"页**：会话内的"工作区"标签消失，状态改从
   `main` 面板（侧栏图标入口）看。这是计划要求的"单一 surface"，但属于**可见的产品变化**，
   请在 Task 5 的浏览器检查里确认可接受。
4. **面板是全局（root scope）的，不是按会话的**：计划明确"不做 per-user 语义"，面板列出全部
   工作区；旧详情页的"该会话未关联工作区"文案随之消失。若产品希望"只看当前会话的工作区"，
   需要 `main` 之外的 session-scoped 槽位（0.1.5 起 `main` 就没有 session 绑定）。
5. **`main` 面板的 `usePanelInfo` 等框架 hooks 没有使用**：面板用 `useSyncExternalStore` 订阅自己的
   HTTP 快照，因此不依赖 `GlobalStandardProps` 的具体形状——这在 0.1.5→0.2.x 之间是更稳的选择，
   但也意味着面板**不会**随会话/布局变化做特殊处理（例如不会在切换面板时暂停轮询，仅在卸载时停止）。
6. **错误路径是"快照 + reject"双通道**：面板用 `.catch(() => undefined)` 消费 reject，错误文本已
   在快照里（有测试断言两者同时成立）。若未来有人把 store 的 reject 当唯一错误通道，面板就会
   重新变成静默失败——`tests/panel-model.spec.ts` 的两个用例正是为此设置的路障。
