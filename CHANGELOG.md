# 变更日志（CHANGELOG）

本仓按 tag 发布：版本格式 `vMAJOR.MINOR.PATCH`，tag 是镜像与插件版本的唯一真值。
已发布的 tag 覆盖 `v0.1.2` … `v0.1.89`；`v0.1.89` 是当前最新 tag（`main` 即它）。
**早期 tag（`v0.1.2` – `v0.1.87`）没有留下逐版本说明**，本文件不补造历史条目；
需要两次 tag 之间的具体改动请直接看 `git log` 与对应 tag 的 diff。
DSH 基线由 `scripts/check-dsh-version.mjs` 强制，与平台版本的对应关系见 README 的兼容性矩阵。

## 未发布

- **对外 URL 单一真值（P1）**：identity-bridge 的 launch-token handoff 根现在优先取官方
  advertised URL（0.2.1 `--public-url` → `web-runtime.publicUrl` →
  `ctx.webApp.getAdvertisedUrl()`）。显式 `publicOrigin` 仍是覆盖项，并且现在接受
  `scheme://host[:port][/prefix/]`（为子路径发布铺路）；与监听地址相同的 loopback fallback
  会被忽略（保留反向代理感知的请求 origin），不在 connection `trustedHosts` 中的 advertised
  authority 会告警一次并回落到请求 origin，launch token 不会离开受信任拓扑。
- 下一版部署 chart 会把同一来源作为 `dsh web --public-url` 传入（`DSH_PUBLIC_ORIGIN` 显式
  覆盖仍兼容），从而消除 chart 与 identity-bridge 两套 origin 配置的漂移。

## v0.1.89（预览）

`v0.1.89` 相对 `v0.1.88` 的内容。**预览版，不面向生产**；明确的限制见 README「已知限制」。
本轮把 DSH 基线从 `0.2.0-rc.2` 升到 `0.2.1-rc.2`（npm `latest`），并把四个版本真值、
profile 补丁层、vendored 测试夹具与文档一起对齐。

### DSH 基线升级

- **四个真值同步到 `0.2.1-rc.2`**：`pnpm-lock.yaml`、各 `packages/*/package.json` 的
  `@deepseek-ai/dsh-*` 精确依赖、`docker/dsh-web-platform.Dockerfile` 的 `ARG DSH_VERSION`、
  `.github/workflows/release.yml` 的 `DSH_VERSION` build-arg；`scripts/check-dsh-version.mjs`
  断言一致。`scripts/harness-profile.sh` 的默认版本、profile 里工作区 daemon 镜像的
  `WS_IMAGE` 兜底值（`v0.1.89`）与 README/CONTRIBUTING/SECURITY 的版本陈述同步更新。
- **`@deepseek-ai/cordis` 依赖从 `^4.0.4` 提到 `^4.0.5`**：0.2.1 的官方包把 cordis 作为
  `~4.0.5` peer，继续解析到 4.0.4 会留下 unmet peer（`pnpm peers check` 现在干净）。
  cordis 是宿主的单例服务容器，多个副本会破坏插件服务解析，所以这个 pin 跟着官方走。
- **profile 补丁层校正**（`docker/profiles/*.cordis.patch.yml`）：按 0.2.0-rc.2 → 0.2.1-rc.2
  两个 `--dump-default-config` 的实测行差重写注释与 restatement。`web-runtime` 的官方 config
  集合新增 `publicUrl`、移除 `trustedHosts`；Host 栅栏整体移到 `connection` 行，且其注入的服务名
  从 0.2.0 的 `webRuntime` 变为 `webStartup`——不跟着改会让该行永久 pending、`trustedHosts`
  为空，反向代理入口的 `/api` 请求会被 Host/Origin 栅栏拒绝。
- 新增的 `schedule` / `ui-schedule`（官方自动化/提醒）保持默认启用：它们经
  `ctx.storageDomain` 持久化（`storage-domain` restatement 已把该 backend 接到 PostgreSQL），
  执行的是普通会话，不需要平台改造。
- **identity-bridge 按 0.2.1 API 复核，无需改代码**：`serveStatic` 签名未变，
  `authorizeIndex` / `authenticatedUrl` / `requestRejection` / `ConnectionIndexResponse` 都在
  （`authorizeIndex` 只多了一个可选 `secure` 参数），浏览器端仍读
  `__DSH_TRANSPORT__.ownsHost`。两个 smoke 在 0.2.1 上全绿。
- **smoke 脚本适配 0.2.1 的 client 条件导出**：`@deepseek-ai/dsh-client-connection` 从单一
  `lib/client.js` 拆成 `lib/client.browser.js` / `lib/client.node.js`；两个 smoke 现在按包
  `exports["./client"]` 的 `browser` 条件解析要检查的源码，而不是硬编码文件名。

### 工作区注册表语义（vendored 夹具 0.2.1-rc.2）

- 测试夹具 `packages/workspace-k8s/tests/vendor/dsh-workspace/` 整体重新 vendored 到
  `0.2.1-rc.2`（`npm pack` 的完整字节），peer 树按新 manifest 重新 materialize。
- **官方语义变化**：`sessionIds` 的候选过滤从 `host.sessionPath(id) === record.path` 改为
  `host.candidateMatches(id, path)`；存储 header 的 cwd 是全限定路径、解析失败为 `ENOENT` 的
  会话现在进入 `missingSessionPaths`、**仍算作候选成员**（保持可见，不会被下一次写入剪除）。
  `attachSession` 的 durable-membership 短路顺序不变。`@deepseek-ai/dsh-invariants` 随上游
  “移除 runtime invariant 插件与 `./invariant` 导出”一起消失，夹具 peer 清单同步删除。
- 影响：控制面先于 `/workspaces/<id>` 锚点启动的生产场景，从「会话被隐藏、下一次写入剪除」
  变为「被容忍」；原先断言「已认领但被索引隐藏」的用例改为断言新的容忍语义（不写、不剪除）。
  `rebind` 仍是非 ENOENT 隐藏场景的修复路径。

### 0.2.1 语义对齐（升级后按上游审计补）

- **凭据优先级跟到 0.2.1（stored-first）**：`platform-domain` 的 `ctx.credentials` 原先复刻的是
  0.2.0 语义——环境层覆盖 store，且被环境“遮挡”的 `set`/`unset` 直接拒绝。0.2.1 反过来了：
  已保存的凭据优先，进程环境与 `.env` 降为 fallback，`describe` 一律 `writable: true`，也不再
  有 shadow 拒绝。实现、类文档与 `tests/credentials.spec.ts` 一起翻转；否则 pod 环境里一个
  `DEEPSEEK_API_KEY` 会让 Models 页保存的 key 被静默忽略。
- **两个新行的决定**：`working-directory` 的部署 fallback 显式 restate 为 `/workspaces`（镜像
  没有 `WORKDIR`，否则控制面上的 `process.cwd()` 是 `/`，落在 fs-k8s/subprocess-k8s 的
  `/workspaces` 执行根之外）；`harness-dev-context` 关闭（它把控制面的“实现 checkout / Web GUI
  URL”注入每个会话的模型上下文，对在 workspace pod 里执行的 agent 是误导）。两个 profile 都
  同步（headless 只有前者）。
- **跨仓后续（部署 chart）**：0.2.1 新增 `--public-url`；本仓已把 `web-runtime.publicUrl` 转发为
  `ctx.webStartup.publicUrl`。部署 chart 需要把 `DSH_PUBLIC_ORIGIN` 同时传给
  `dsh web --public-url`，否则 `DSH_WEB_URL` 与运行时上下文仍是 loopback；这一项不在本仓内。

### 验证

- `pnpm install --frozen-lockfile`、`pnpm -r build`、`pnpm -r test` 全绿；提交的
  `packages/*/dist|lib` 与源码一致（`git diff --exit-code`）。
- `bash scripts/harness-profile.sh … 0.2.1-rc.2` 搭出与镜像同构的 web/headless profile；
  两个 `--dump-config` stderr 为空（无 `patch: entry "…" not found`），
  `check-plugin-imports`、`check-loopback-bind` 通过。
- `scripts/smoke-zero-patch.mjs` 与 `scripts/smoke-official-integration.mjs` 在 0.2.1-rc.2 上
  全绿（认证路径零编译产物补丁、零 webserver fork）。
- `node scripts/check-dsh-version.mjs`、`node scripts/check-package-manifests.mjs` 通过；
  `pnpm peers check` 无未满足 peer。
- 升级后按上游审计补的两处（`platform-domain` 凭据 stored-first、`working-directory` /
  `harness-dev-context` 行决策）另跑：`packages/platform-domain` vitest 20/20，web+headless
  `--dump-config` 仍 stderr 为空，生效行分别出现 `defaultDirectory: /workspaces` 与
  `harness-dev-context: disabled`，提交的 `dist` 可重复构建。
- 发布前由独立（fresh-context）验证者跑了两轮：第一轮全量 PASS；第二轮在审计补丁
  （`fb1e96a`、`3fb38bf`）之后复核版本真值、构建/测试、全新 harness 的 dump-config 与两个
  smoke，仍为 PASS。

## v0.1.88（预览）

`v0.1.88` 相对 `v0.1.87` 的内容。**预览版，不面向生产**；明确的限制见 README「已知限制」。
本轮的目标是让预览版第一次发布前，仓库自身的版本真值、CI 与文档都不再自相矛盾。

### 发布就绪修正（相对 `v0.1.87`）

- **版本真值统一**：README 兼容性矩阵、各包 `@deepseek-ai/dsh-*` 精确依赖、
  `docker/dsh-web-platform.Dockerfile` 的 `ARG DSH_VERSION`、`.github/workflows/release.yml`
  的 build-arg 现在都指向 `0.2.0-rc.2`，并由 `scripts/check-dsh-version.mjs` 在 CI 与发布流程中
  断言一致（此前四处各写各的，还留着指向旧版本的排除列表）。
- **部署文档与 chart 重写**：部署仓的 `docs/deployment.md` 重写为从零开始的快速开始
  （命名空间、数据库连接串 Secret、IdP 回调与两个 Secret、安装、验证、升级/回滚、备份、
  故障排查、已知限制）；控制面 chart 现在把全部 `WS_*` 运行时开关接到工作区 Pod
  （此前部分 knob 只有 values.yaml 没有出口），并支持可配置的 `imagePullSecrets`
  与工作区 Pod 的 `seccompProfile: RuntimeDefault`。
- **新增检查脚本**：`scripts/check-package-manifests.mjs`（按发布方式 `pnpm pack`，断言
  `main` / `types` / `exports` 承诺的文件真的在 tarball 里）与 `scripts/check-dsh-version.mjs`
  （DSH 版本只有一处真值）。
- **新增 main 分支 CI**：`.github/workflows/ci.yml` 在 `push: main` 与 PR 上跑安装 / 构建 /
  测试 / 提交产物一致性 / manifest 检查 / DSH 版本检查 / 两个包的 typecheck，并单独跑
  auth smoke（装 pin 的 `dsh` CLI、重建 harness profile、跑零补丁与官方集成两个冒烟）。
  此前唯一的 workflow 只在 `v*` tag 上运行。
- **公共目录清理**：内部流程文档（`.superpowers/`、`docs/superpowers/`）从公开树中移除，
  只保留面向使用者的 `docs/architecture.md` 与 `design/` 设计文档。
- **npm 元数据修正**：各包补上 `license: MIT`，并删除指向并不存在的 `dist/index.d.ts` 的
  `types` 字段（构建只产出 `dist/index.js`，esbuild 不做类型声明）。

## v0.1.87 及更早

- `v0.1.88` 是 `v0.1.89` 之前最后一个 tag，也是此前部署文档与 chart 默认 pin 的版本。
- `v0.1.80` – `v0.1.88` 面向 DSH `0.2.0-rc.2`；`v0.1.2` – `v0.1.79` 面向 `0.1.5-rc.1` 及更早，
  不再回归验证，也不提供逐版本说明。
- 这一区间的历史条目请以 `git log`、tag 的 diff 与 GitHub Releases 为准。
