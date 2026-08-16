# dsh-platform

DeepSeek Harness 多用户平台——插件 monorepo（pnpm workspace）。

**架构**：方案 1（执行世界 seam）。会话/agent loop/Web UI 在控制面宿主；执行（fs/subprocess/PTY）经官方 seam 路由到每工作区一个的 k8s 执行 pod。

**设计文档**：见 ../dsh-research/specs/（2026-08-16-workspace-lifecycle-design.md、2026-08-16-multiuser-platform-design.md）
**实现计划**：见 ../dsh-research/plans/2026-08-16-platform-implementation.md

## 包清单

| 包 | 职责 | 计划 |
|---|---|---|
| daemon-protocol | 沙箱 daemon 协议类型（daemon 与适配器共享） | Plan 1 |
| sandbox-daemon | 工作区执行 pod 内 daemon（files/commands/pty） | Plan 1 |
| fs-k8s | ctx.fs 提供方（→ daemon） | Plan 1 |
| subprocess-k8s | ctx.subprocess 提供方（→ daemon） | Plan 1 |
| workspace-k8s | 工作区生命周期状态机 + lifecycle owner | Plan 1-2 |
| auth-oidc | registerGate + authentik 登录 | Plan 3 |
| user-domain | per-user settings/credentials + 执行 env 白名单 | Plan 3 |
| rbac | 会话注册表 + 授权 + 只读分享 | Plan 4 |
| cluster-access | 集群准入 + OIDC token 注入 + kubectl credential plugin | Plan 5 |

## 开发

pnpm install && pnpm build && pnpm test
