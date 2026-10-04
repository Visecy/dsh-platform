# dsh-platform 2.0 设计（结构性改造）

日期：2026-10-04
状态：设计已确认（用户批准形状）；**用户/多租户语义部分明确推迟**，另行讨论
前置调研：`design/2026-09-12-dsh-0.1.5-upgrade.md`、`.dshcmp/findings/` 下的 0.2.1 delta / dsh-passwords fs 审计 / 0.2.1 工作区与槽位审计 / DSH 认证替代方案调研

---

## 1. 目标与约束

来自用户明确给出的要求：

| # | 要求 | 出处 |
|---|---|---|
| R1 | **控制面必须是无状态容器**（`readOnlyRootFilesystem`，无 PVC，持久状态只能在外部 Postgres） | "必须保证控制面是无状态容器，这是目前所有开发的根本出发点" |
| R2 | **工作区 pod 插件与登录解耦**，不含任何身份概念 | "工作区pod应当作为一个独立不与用户登录耦合的插件" |
| R3 | **状态展示不能丢**；pod 工作区与文件夹的差异必须被正面处理 | "状态展示不能丢…最好先调研一下怎么兼容" |
| R4 | **不能只考虑 visecy 集群**（开源项目，别人要能部署） | "这是一个开源项目，不要只考虑visecy集群的兼容性" |

派生的设计目标：
- **跟 DSH 最新版**（当前 `latest` = `0.2.0-rc.2`），不依赖只支持某条补丁线的第三方
- **零编译产物补丁、零 fork**：消除与官方产物逐文件耦合的最大维护风险
- 仓库根补 **MIT LICENSE**（当前只有各包元数据写了 MIT）

**明确不在本次范围**（留待后续讨论）：per-user 身份语义、per-user 设置/凭据（`user-domain` 接线）、授权与多租户隔离（工作区/会话可见性、配额、审计）。

---

## 2. 架构

```
浏览器 ── host/子域路由（DSH SPA 用绝对路径，不能挂在子路径下）
   │
   ▼ 同一个 Pod
┌─────────────────────────────────────────────────────────┐
│ oauth2-proxy sidecar :4180（cookie 会话 = 无状态）        │
│    └─ 注入 X-Auth-Request-User / -Groups                 │
│                                                          │
│ DSH 控制面 127.0.0.1:3080（readOnlyRootFilesystem，无 PVC）│
│    ├─ session-persistence-rdb  → Postgres：会话           │
│    ├─ storage-db + platform-domain → Postgres：平台状态   │
│    └─ identity-bridge（新）                              │
│         头 → ctx.dshAuth ／ DSH token handoff ／           │
│         __DSH_TRANSPORT__ 注入                            │
└─────────────────────────────────────────────────────────┘
   │ ctx.fs / ctx.subprocess / ctx.fileReferences / ctx.directoryPicker
   ▼
k8s：每工作区一个 pod + PVC（控制面只有空锚点）
```

DSH 绑 loopback + 同 pod sidecar ⇒ 身份头只可能来自 sidecar，**信任是结构性的而非策略性的**，也因此不再需要把控制面绑到 `0.0.0.0`（回到上游威胁模型内）。

---

## 3. 组件处置

| 处置 | 组件 | 理由 |
|---|---|---|
| 留 | `fs-k8s`（**须实现 `fs.watch`**） | 0.2.x 的文件查看路径要求 `watch`，provider 不支持会抛 `workspace-file/watch-unsupported`（0.1.5 无此调用） |
| 留 | `subprocess-k8s`、`sandbox-daemon` | 执行世界 |
| 留 | `session-persistence-rdb`、`storage-db`、`platform-domain` | **它们就是 R1 的实现**：DSH_HOME 是临时卷，会话与平台状态必须落 Postgres |
| 留 | `workspace-k8s`（执行/生命周期/registry 桥/状态 API） | R2：对外契约不含任何身份概念 |
| 留 | `workspace-picker` | 官方 host `ctx.directoryPicker` 抽象类的实现，官方对话框自动跟随 |
| 新增 | `identity-bridge` | 头 → `ctx.dshAuth`；DSH token handoff；`__DSH_TRANSPORT__` 注入 |
| 新增 | `file-reference-k8s` | `ctx.fileReferences.list()` 是单方法 seam，用 `ctx.fs.listDir` 实现 |
| 新增 | 工作区状态客户端插件 | `main`(keyed) 面板 + `sidebar.panellist` 入口 |
| 改 | `workspace-k8s` 客户端半边 | 删 vendored browser 与详情页，改为官方槽位面板 |
| 改 | profile / Dockerfile / chart | 0.2.0-rc.2 基线；sidecar；loopback 绑定；行清单校正 |
| 删 | `auth-oidc`（gate/OIDC/session 部分） | 认证移出进程 |
| 删 | `vendor/dsh-web-auth`（fork） | 上游**没有** `registerGate`，它只是我们的私有扩展；认证移出后不再需要前置闸门 |
| 删 | `scripts/patch-dsh.mjs` | P1/P2 都有官方替代（见 §4） |
| 删 | `vendor-workspace-browser.mjs` + `vendored-workspace.ts` + `check-webserver-fork.mjs` | 不再 vendoring / 不再有 fork |
| 删 | `rbac`、`cluster-access`、`daemon-protocol` | 空实现，零消费者 |

---

## 4. 四个关键机制

### 4.1 零补丁（替代 P1/P2）
- **P1（浏览器 `isLoopback`）** → 官方 transport hook：宿主插件监听 `webserver/index-inject` push `{kind:'global', name:'__DSH_TRANSPORT__', value:{ownsHost:true}}`。上游 `ClientTransportHooks.ownsHost` 是有类型、有文档、有官方消费者的接口。**已验证**（`scripts/smoke-official-integration.mjs`，跑在未打补丁的官方产物上）。
- **P2（进程内 launch-token cookie 层）** → 官方 token 交换：`ctx.connection.authenticatedUrl(origin)` + `authorizeIndex`。**已验证**：无 cookie → 401；带 token 的 `/` → 303 + Set-Cookie；之后 `/api` 正常；错误 token → 401；围栏仍生效。

### 4.2 DSH handoff
`identity-bridge` 注册**精确路由 `/`**（精确优先于 fallback）：
- 携带有效 DSH cookie → 用官方导出的 `serveStatic()` 渲染 index；
- cookie 缺失/失效 → 302 到 `authenticatedUrl(公网 origin)`，由官方铸 cookie 后 303 回干净 `/`。

因为 cookie 签名密钥存在 DSH credentials 里，R1 下 DSH_HOME 是临时卷（密钥每次重启变化）⇒ handoff 必须能重复触发；上述"cookie 无效即重定向"天然满足。

### 4.3 状态展示（R3）
- **主**：`main`（keyed 面板）+ `sidebar.panellist`（列表入口）——工作区列表、pod 阶段、最后活动时间、唤醒/休眠/清理
- **可选**：`shell.overlay` 状态药丸（冷启动/休眠中）
- **明确放弃**：工作区行内徽标——`ProjectRowItem` 无 `renderSlot`，且 bundle 只导出 `apply`/`inject`，无法组合装饰（0.1.5 与 0.2.x 均如此，已核实）
- 数据来源：`workspace-k8s` 的 `/workspaces/api/*`（k8s 是唯一真相源，不引入平台存储）

### 4.4 工作区插件契约（R2 落地）
- **提供**：`ctx.fs`、`ctx.subprocess`、工作区生命周期（pod/PVC）、`/workspaces/api/*` 状态查询、客户端面板
- **不知道**：用户是谁、会话归属、任何权限概念
- **授权**：全部由外部按文件夹路径判定（它看到的就是 `/workspaces/<id>`）

---

## 5. DSH 0.2.0-rc.2 升级工作项

| 项 | 说明 |
|---|---|
| 依赖升版 | 所有 `@deepseek-ai/dsh-*` → `0.2.0-rc.2`；Dockerfile / release workflow 同步 |
| profile 行清单 | 3 行移除（`workflow-worker-thread`、`code-runtime`、`agent-presets`）、32 行新增、`ui-schedule` 由禁转启、若干 name/config 变化；**`web-runtime` 行是整段替换 config，必须补上新增的 `publicUrl`**，否则跳转地址静默回落到 loopback |
| `fs.watch` | `fs-k8s` 必须实现（0.2.x 文件查看依赖）；实现方式：基于 daemon 的版本/时间戳轮询，或 daemon 侧提供 watch 通道 |
| `session-persistence-rdb` | `SESSION_FORMAT_VERSION` 3→4；静态 catalog **拒绝**迁移 v3 正文（"requires explicit historical child facts"），后端必须收集并持久化 child descriptors（我们从未存过）→ 需要 schema 变更 + 迁移。**本次最重的改造项** |
| 已禁用行的复核 | 我们的 10 个 disable id 在 0.2.x 仍全部存在（已核对），但需在真机上用 `--dump-config` 再验一遍 |

---

## 6. 已知取舍与风险

1. **`dsh-workspace-changes`（0.2.x 新增）没有 seam**，直读宿主文件做编辑前后 diff 快照 → pod 工作区下会失真。处置：profile 禁用该行 + 向上游提"改用 `ctx.fs`"的 issue + 文档标注不可用。
2. **`session-persistence-rdb` 的 v4 迁移**是本设计最大的不确定项：新增的 child-descriptor 维度需要 data-model 变更，且没有真实旧库可验证（需构造 fixture）。
3. **oauth2-proxy sidecar** 引入一层部署拓扑（Service 指向 sidecar 端口、NetworkPolicy 保证 DSH 端口不可直连、host/子域路由）。这些是结构性隔离的前提，不是可选项。
4. **多副本**：R1 意味着可水平扩展，但 `auth-oidc` 的 PKCE verifier 在进程内 Map 里（该实现将被删除）；新的 proxy 方案本身无此问题。
5. 长连接（`/api/remote.mux` WebSocket、`/plugins/events` SSE）经代理需要显式调优（`--flush-interval`、超时）。

---

## 7. 验证要求

沿用并扩展已有验证设施：

- `scripts/harness-profile.sh`：从零搭与镜像同构的 profile，跑插件导入闭包检查 + `--dump-config`（stderr 必须为空）
- `scripts/check-plugin-imports.mjs`：构建期断言每个插件都能在 profile 内被 import（0.1.5 时曾借此发现三个插件缺运行时依赖）
- `scripts/smoke-web-trust.mjs`：改为断言新链路（proxy 头 → 身份；无 DSH cookie → handoff → 303 + cookie；闸门覆盖命名路由）
- `scripts/smoke-official-integration.mjs`：保留，作为"官方扩展点可替代补丁"的回归证明
- 包测试：`pnpm -r test` 全绿
- 新增：`fs.watch` 的行为测试；`session-persistence-rdb` 的 v3→v4 迁移用例

---

## 8. 实施阶段

1. **基础**：LICENSE；依赖升到 0.2.0-rc.2；profile 行清单校正（含 `publicUrl`）
2. **执行 seam 补齐**：`fs-k8s.watch`
3. **持久化**：`session-persistence-rdb` v3→v4 迁移 + child descriptors
4. **零补丁**：`identity-bridge`；chart 加 sidecar 与 loopback；删 fork / `patch-dsh.mjs` / `auth-oidc` 闸门
5. **工作区 UI 与解耦**：官方槽位面板；删 vendored browser 与 vendor 脚本
6. **清理与文档**：删空包与死代码；更新 README；重跑全部验证

后续单独讨论：per-user 身份语义、`user-domain` 接线、授权与多租户隔离。
