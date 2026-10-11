# 变更日志（CHANGELOG）

本仓按 tag 发布：版本格式 `vMAJOR.MINOR.PATCH`，tag 是镜像与插件版本的唯一真值。
已发布的 tag 覆盖 `v0.1.2` … `v0.1.87`；当前 `main` 对应 `v0.1.87`。
**早期 tag（`v0.1.2` – `v0.1.87`）没有留下逐版本说明**，本文件不补造历史条目；
需要两次 tag 之间的具体改动请直接看 `git log` 与对应 tag 的 diff。
DSH 基线由 `scripts/check-dsh-version.mjs` 强制，与平台版本的对应关系见 README 的兼容性矩阵。

## 未发布（预览）

当前 `main` 相对 `v0.1.87` 的内容。**预览版，不面向生产**；明确的限制见 README「已知限制」。
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

- `v0.1.87` 是当前 `main` 之前最后一个 tag，也是部署文档与 chart 默认 pin 的版本。
- `v0.1.80` – `v0.1.87` 面向 DSH `0.2.0-rc.2`；`v0.1.2` – `v0.1.79` 面向 `0.1.5-rc.1` 及更早，
  不再回归验证，也不提供逐版本说明。
- 这一区间的历史条目请以 `git log`、tag 的 diff 与 GitHub Releases 为准。
