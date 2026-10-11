# 贡献指南

感谢参与。本仓是 DeepSeek Harness 多用户平台的插件 monorepo，**当前是预览版**，
接口与部署形态都可能变动；提交前请先读 [README](README.md) 的「已知限制」和
[docs/architecture.md](docs/architecture.md)。

## 环境

| 项 | 要求 |
|---|---|
| Node | `>= 22.19`（根 `package.json` 的 `engines`） |
| 包管理器 | pnpm 11（CI 用 `pnpm/action-setup@v4` + `version: 11`） |
| 构建 | 各包用 esbuild 打包（`scripts/build-pkg.mjs`）；`packages/sandbox-daemon` 走 `tsc --noEmit` |
| 测试 | vitest |

## 基本命令

```bash
pnpm install && pnpm build && pnpm test
```

`pnpm build` 不做全量类型检查（只有上面提到的少数包过 `tsc`），`pnpm -r test` 里
PostgreSQL 与 golden-fixture 用例默认跳过：需要 `TEST_PG_URL`（Postgres 后端）或
`DSH_CAPTURE_FIXTURE=1`（golden fixture）才会执行，**所以本地全绿不等于 Postgres 后端被覆盖**。

## 冒烟与 harness

端到端验证要先搭一个与镜像同构的临时 DSH home，需要与本仓一致版本的 `dsh` CLI
（当前 `0.2.0-rc.2`，与镜像里装的一致）：

```bash
bash scripts/harness-profile.sh /tmp/dsh-harness
DSH_HOME=/tmp/dsh-harness/home dsh --profile web --dump-config > /tmp/web.yml

node scripts/smoke-zero-patch.mjs --target /tmp/dsh-harness/home/profiles/web/node_modules
node scripts/smoke-official-integration.mjs --target /tmp/dsh-harness/home/profiles/web/node_modules
```

两个注意点：

- `--target` 必须指向 **harness profile 的 `node_modules`**（含未打补丁的官方包与
  `identity-bridge`）。仓库根的 `node_modules` 只有构建工具（esbuild / typescript），跑不了。
- `--dump-config` 的未知 id / name 不匹配只会 warn，要检查 stderr 有没有 warning
  （`patch: entry "…" not found` 只 warn 不报错）。

## 硬约束（会被 CI 与冒烟强制）

1. **不给官方 `@deepseek-ai` 包打编译产物补丁，不做 webserver fork。** 镜像里的官方包与 npm
   发布的一致；认证路径走 `identity-bridge` 的官方扩展点，工作区 UI 走官方槽位。这条是
   load-bearing 的：`scripts/smoke-zero-patch.mjs` 会在认证路径上因任何编译产物补丁而失败，
   `scripts/smoke-official-integration.mjs` 断言那两个扩展点仍然存在。
2. **`packages/*/dist` 与 `packages/*/lib` 必须与源码同步。** 它们被提交进仓库，镜像直接安装
   已提交的产物；CI 在 build 之后跑 `git diff --exit-code -- 'packages/*/dist' 'packages/*/lib'`。
   改完源码记得把重建后的产物一起提交。
3. **npm 包只承诺 tarball 里真实存在的文件。** 新增或修改 `main` / `types` / `exports` /
   `files` 时跑 `node scripts/check-package-manifests.mjs`（它按发布时的方式 `pnpm pack`，
   断言每个被承诺的路径都在包里）。
4. **DSH 版本只有四个真值，必须同步。** 升级 DSH 时改这四处：
   `pnpm-lock.yaml`、各 `packages/*/package.json` 的 `@deepseek-ai/dsh-*` 精确依赖、
   `docker/dsh-web-platform.Dockerfile` 的 `ARG DSH_VERSION`、
   `.github/workflows/release.yml` 的 `DSH_VERSION` build-arg；然后跑
   `node scripts/check-dsh-version.mjs` + `pnpm -r test` + 两个 smoke，并逐条复核 README
   「与官方产物耦合的地方」。不要只改依赖不重建镜像。

## CI

`.github/workflows/ci.yml` 在 `push: main` 与所有 PR 上运行：`pnpm install --frozen-lockfile`
→ `pnpm -r build` → 提交产物一致性 → `check-package-manifests.mjs` → `check-dsh-version.mjs`
→ `pnpm -r test` → 两个包的 `tsc` typecheck；随后 `auth-smoke` job 装 pin 的 `dsh` CLI、
重建 harness profile、跑两个 smoke。`release.yml` 由 `v*` tag 触发（见下）。

其余脚本按需跑：`scripts/check-plugin-imports.mjs <profile-dir>`（profile 里每个插件能否
`import`）、`scripts/check-loopback-bind.mjs <dsh-home>`（官方 CLI 是否仍然拒绝 `--host 0.0.0.0`）。

## 提交与 PR

- 提交信息用 `type(scope): 说明`，例如 `fix(workspace-k8s): …`、`docs(readme): …`、
  `test(fs-k8s): …`；scope 用包名或目录名（`release`、`profiles`、`scripts`、`kind` 等）。
- 一个 PR 做一件事；说明清楚**为什么**改，以及你跑了哪些验证命令。
- 文档、注释与提交信息以中文为主，代码标识符与官方 API 名保持原文。
- 新增/调整面向用户的包元数据（`license`、`types` 等）后，先跑
  `node scripts/check-package-manifests.mjs` 再提 PR。

## 发布（维护者）

发布是 tag 驱动的：打 `v*` tag（或 `workflow_dispatch` 时显式给一个已存在的 tag）。
tag 是唯一版本真值——所有包在发布前被 version 到该 tag，镜像安装的正是这个版本。
发布流程包含：`pnpm -r test`、提交产物一致性、manifest 检查、构建 `linux/amd64` +
`linux/arm64` 双架构镜像（含 provenance / SBOM），以及用 **npm Trusted Publishing（OIDC，
无长期 token）** 发布 `@visecy/*` 包。含 prerelease 段的 tag 不会移动 `latest`。
`identity-bridge` 尚未发布到 npm（首次发布需要人工 bootstrap），镜像从本仓检出安装它。

## 许可证

本仓采用 MIT，见 [LICENSE](LICENSE)。提交即表示你同意以该许可证发布你的贡献。
