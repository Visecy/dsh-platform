# 架构（一页纸）

> 面向准备部署或阅读本仓的工程人员。深度设计见 [`../design/`](../design/)；
> 部署步骤见配套仓库 `dsh-platform-deploy` 的 `docs/deployment.md`。

## 组件

```
浏览器 ── TLS ── Ingress / Istio gateway（按 host + 可选单段前缀路由；前缀必须由入口剥离）
  │
  └─ 控制面 Pod（无状态；emptyDir 的 DSH_HOME，无 PVC）
       ├─ oauth2-proxy sidecar :4180      ← Pod 唯一入口（Service 只暴露它）
       │    OIDC 会话（cookie store，无 Redis / DB）
       │    向上游注入 X-Forwarded-User / -Groups（已认证身份）
       └─ dsh web 127.0.0.1:3080          ← 只绑 loopback，Service 不指向它
            ├─ identity-bridge            官方扩展点：transport hook + launch-token handoff
            │                             + ctx.dshAuth（读 sidecar 注入的身份头）
            ├─ workspace-k8s              工作区生命周期（ensure / sleep / delete / 面板）
            ├─ fs-k8s / subprocess-k8s    把 ctx.fs / ctx.subprocess 路由到工作区 Pod
            ├─ workspace-picker           ctx.directoryPicker → 工作区 PVC
            ├─ session-persistence-rdb    ctx.sessionPersistence → PostgreSQL
            ├─ storage-db / platform-domain / storage-domain → PostgreSQL
            └─ logging-stdout             平台插件的 warn/error → Pod 日志
  │
  └─ 工作区 Pod（每工作区一个，由 workspace-k8s 动态创建/回收）
       ├─ sandbox-daemon :4390           files / commands / pty（**无认证**）
       └─ PVC（ReadWriteOnce）挂到 /workspaces/<id>
```

数据面：会话与事件、`storage-domain` 单元、平台凭据、工作区记录都在 PostgreSQL；
工作区**文件**只在工作区 PVC 里。控制面不持有任何工作区字节。

## 身份与信任模型

- 身份**只**来自认证代理注入的请求头（默认 `X-Forwarded-User` / `X-Forwarded-Groups`，
  可在 `identity-bridge` 的 `userHeader` / `groupsHeader` 改）。
- 该信任是**拓扑性的**：DSH 进程绑 loopback、Pod 内没有第二个调用方、
  Service / Ingress 都不指向应用端口。所以「谁能连到这个端口」等于「谁能冒充任意用户」。
- `identity-bridge` 不做认证也不做授权；它只把代理已认证的主体暴露成 `ctx.dshAuth`。
- **授权目前不存在**：`rbac` / `cluster-access` 是空实现，`ctx.dshAuth` 没有消费方。
  所有通过认证的用户共享同一份控制面状态，见 README「已知限制」。

## 工作区生命周期

`workspace-k8s` 是唯一的 lifecycle owner：

| 阶段 | 触发 | 动作 |
|---|---|---|
| provision | 首次 ensure / 从 sleep 唤醒 | 建 PVC（若无）+ 建 Pod + headless Service，等 Ready（上限 180s） |
| running | Pod Ready | 记录 Pod IP；控制面用 `http://<podIP>:4390` 调用 daemon（DNS 仅回退） |
| sleep | 空闲 `WS_IDLE_TIMEOUT_MS`（默认 5 分钟）且无遗留命令 | 删 Pod，保留 PVC |
| grace | 有遗留命令 | 延长到 `WS_GRACE_MS`（默认 3 小时）后强制回收 |
| deleted | 用户删除 | 删 Pod + Service + **PVC（数据随之删除）** |
| reconcile | 周期性 + 启动时 | 收敛漂移：孤儿 Pod、丢失的 PVC、镜像漂移后的回收 |

## 运行时配置（镜像 profile 读取的环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `WS_NAMESPACE` | 无（必填） | 工作区 Pod / PVC / Service 所在命名空间 |
| `WS_IMAGE` | 与平台 tag 对齐的 daemon 镜像 | 工作区执行镜像 |
| `WS_STORAGE_CLASS` | `local-path` | 工作区 PVC 的 StorageClass（空串 = 集群默认） |
| `WS_STORAGE_SIZE` | `2Gi` | 每个工作区 PVC 的容量 |
| `WS_IDLE_TIMEOUT_MS` | `300000` | 空闲多久进入 sleep |
| `WS_GRACE_MS` | `10800000` | 有遗留命令时的宽限上限 |
| `WS_RECONCILE_INTERVAL_MS` | `60000` | 周期性收敛间隔（0 关闭） |
| `WS_METRIC_INTERVAL_MS` | `15000` | metrics.k8s.io 采样间隔（需 metrics-server） |
| `WS_CPU_LIMIT` / `WS_MEM_LIMIT` | `2` / `2Gi` | 工作区 Pod 的 requests=limits |
| `WS_DAEMON_ENDPOINT` | `http://127.0.0.1:4390` | 静态回退端点（仅在无 resolver 的组合里生效） |
| `DSH_PUBLIC_ORIGIN` | 无（推荐必填） | launch-token handoff 的公开 origin；缺失时从请求头推导 |
| `DSH_TRUSTED_HOSTS` | 空 | 追加到官方 Host/Origin fence 的 authority 列表（逗号分隔，裸 `host[:port]`） |
| `DSH_LOG_LEVEL` | `warn` | 平台插件日志级别（`error`/`warn`/`info`/`debug`） |
| `DSH_PG_CONNECTION_STRING` | 无（必填） | PostgreSQL 连接串 |

工作区 Pod 侧：`DAEMON_ROOT`（默认 `/workspace`）、`DAEMON_PORT`（默认 `4390`）、
`DAEMON_RUNTIME_ROOT`（daemon 自身运行态，不得落在工作区内）、
`DAEMON_COMMAND_TIMEOUT_MS`（默认 3 小时）。

## 网络与安全边界（部署方必须自己补的部分）

1. **daemon 无认证**：`sandbox-daemon` 监听 `0.0.0.0:4390`，提供文件读写、命令执行与 PTY，
   没有任何凭据校验。平台可以按工作区创建一条 NetworkPolicy 把它围到控制面
   （`workspace.networkPolicy.enabled=true`；默认**关闭**，因为策略在不支持 NetworkPolicy 的
   CNI 上等于没有，而 selector 写错会让所有工作区不可达）。保持关闭时，需要部署方在命名空间上
   提供默认拒绝，并只放行控制面 Pod 到 4390。
2. **控制面必须能直连 Pod IP**：解析顺序是 Pod IP → `<id>-svc.<ns>.svc.cluster.local`。
   默认拒绝 egress、Istio STRICT mTLS 或集群外控制面都会让 fs / 命令 / PTY 全部不可用。
3. **不要发布应用端口**：见 README「部署硬前提」。
4. **TLS 终止在 Ingress / 网关**：sidecar 与应用之间是 Pod 内明文 loopback。

## 官方扩展点（升级 DSH 的复核清单）

| 扩展点 | 用途 |
|---|---|
| `webserver/index-inject`（`{kind:'global'}`） | 注入 `__DSH_TRANSPORT__`，让远端浏览器按 host 语义工作 |
| `ctx.connection.authenticatedUrl()` / `authorizeIndex()` | 官方 launch-token 交换，不绕过 cookie 层 |
| `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic(...)` | 接管精确 `/` 路由渲染首页 |
| 客户端槽位 `main` / `sidebar.panellist` / `shell.overlay` / `conversation.view` | 工作区状态面板与详情页 |
| `ctx.fs` / `ctx.subprocess` / `ctx.directoryPicker` / `ctx.sessionPersistence` / `ctx.storageDomain` / `ctx.credentials` | 平台提供方的替换点 |
| profile patch 层（`docker/profiles/*.cordis.patch.yml`） | disable 官方本地执行行、重述 web-runtime / connection 行 |
