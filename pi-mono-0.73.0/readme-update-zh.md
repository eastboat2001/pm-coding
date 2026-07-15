# PI Coding Web 本地开发与运维说明

本文记录本仓库相对上游 PI-mono 的产品化边界、Application Generation Agent v2 运行方式和 Phase 10 验证入口。上游项目介绍仍以根目录 `README.md` 为准。

## 1. 架构边界

- `apps/pi-coding-web`：浏览器应用、v2 run client、worker 入口和 PM handoff 适配。
- `packages/web-workspace`：v2 runtime、PostgreSQL store、Redis queue/live stream、构建与静态预览、诊断和 Vite middleware。
- `packages/web-ui`：通用浏览器 UI 组件，不承载 PM 或服务端 runtime 逻辑。
- `docker/pi-coding-web`：远程内网部署配置。本地源码开发不要为了方便而修改它。

PM 是外部需求来源。PM handoff 只负责把目标和文档带入 PI；正式应用生成、规划、执行、验证、修复和事件回放全部由服务端 Application Generation Agent v2 完成。

## 2. 唯一正式生成运行时

Application Generation Agent v2 是唯一生产生成路径：

- 不存在 v1/v2 feature flag 或正式双路径。
- 不兼容旧 prompt、spec/plan/tasks、preview-goal continuation、旧 repair 流程或旧内部接口。
- 不读取或迁移旧 run/session/message/app-preview-goal/diagnostic 数据。
- schema 允许破坏式 reset；回滚通过重新部署旧代码版本和必要的数据备份完成。
- 浏览器只发送严格 v2 start DTO，只投影 v2 run snapshot/event；不得把 payload cast 为旧 `AgentEvent`。

已退役的 run queue/event bus/retry bridge、旧 runtime wrapper、旧消息转换和浏览器 planner/continuation 模块不得恢复。

## 3. 生产数据与事件流

- PostgreSQL：v2 run、task graph、artifact index、validation attempt、diagnostic、durable event 和 outbox 的权威存储。
- Redis：ready/active claim、cancel token、live event stream。Redis 不是 durable 业务事实来源。
- Durable outbox dispatcher：queue、live event、Workspace diagnostic 和 Langfuse projection 的唯一投递路径。
- SSE：以 PostgreSQL durable log 补洞，以 Redis stream 降低延迟；使用 `afterSeq` 与 `Last-Event-ID`，只连续推进 cursor。
- Worker：使用 workerId + claimToken 精确拥有 claim；状态和事件先原子持久化，终态成功后才 complete claim。

Web 和 worker 启动前会探测 PostgreSQL、Redis queue 和 Redis event bus。依赖失效时 `/api/pi-storage/status` 返回 503，run mutation 和新 claim 暂停；依赖恢复后自动继续。非法配置会在启动阶段失败，不会静默回退。

## 4. 本地运行

本地推荐模式是：Web/worker 从源码运行，Docker 只运行 PostgreSQL 和 Redis。

```powershell
Set-Location C:\VibeCoding\pm-coding\pi-mono-0.73.0
docker compose -f docker\pi-coding-web\docker-compose.yaml up -d postgres redis
```

从模板创建本地配置，但不要提交或输出其中的密码、Token 和 API Key：

```powershell
Copy-Item apps\pi-coding-web\.env.example apps\pi-coding-web\.env
```

本地配置应使用：

- `PI_RUNTIME_STORE=postgres`
- `PI_POSTGRES_URL` 指向宿主机可访问的 PostgreSQL
- `PI_REDIS_URL` 指向宿主机可访问的 Redis
- `PI_AGENT_V2_RUN_QUEUE_NAME` 为当前环境使用独立队列名
- `PI_WORKER_ID` 在多 worker 部署中保持稳定且唯一
- `PI_PREVIEW_BASE_URL`/`PI_PREVIEW_INTERNAL_ORIGIN` 使用受信任 origin

源码启动：

```powershell
# 终端 1
Set-Location apps\pi-coding-web
npm run dev

# 终端 2（修改 worker 或 web-workspace 后需要重新 build）
Set-Location C:\VibeCoding\pm-coding\pi-mono-0.73.0
npm run build:worker --workspace=pi-coding-web
npm run worker --workspace=pi-coding-web
```

本地源码运行不应修改 `docker/pi-coding-web` 的远程部署配置。

## 5. 关键配置

当前正式变量使用 `PI_AGENT_V2_*` 命名：

- `PI_AGENT_V2_RUN_QUEUE_NAME`
- `PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN`
- `PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS`

其他核心变量：

- `PI_RUNTIME_STORE`、`PI_POSTGRES_URL`、`PI_REDIS_URL`
- `PI_WORKER_ID`、`PI_WORKER_CONCURRENCY`
- `PI_CLIENT_ID_REQUIRED`
- `PI_PREVIEW_BASE_URL`、`PI_PREVIEW_INTERNAL_ORIGIN`
- `PI_LANGFUSE_ENABLED`、`PI_LANGFUSE_HOST`、`PI_LANGFUSE_OTEL_ENDPOINT`

旧的 `PI_APP_AGENT_VERSION`、`PI_RUNS_ENABLED`、`PI_RUN_QUEUE_NAME` 和旧 checkpoint/runtime switch 配置均为无效配置；不要把它们写回 `.env.example` 或部署说明。

URL、boolean、integer、runtime store 和资源限制变量均严格解析。显式空值或非法值会抛出只包含变量名和期望格式的配置错误，避免泄露凭据。

## 6. 构建与自动验证

```powershell
# 根检查（Biome、TypeScript、browser smoke、各 workspace）
npm run check

# Worker 和前端 production build
npm run build:worker --workspace=pi-coding-web
npm run build --workspace=pi-coding-web
```

真实 Redis integration：

```powershell
$env:PI_TEST_REDIS_URL = 'redis://127.0.0.1:6379'
Set-Location packages\web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run `
  test\run-queue-redis.integration.test.ts `
  test\agent-v2-run-event-bus-redis.integration.test.ts `
  test\agent-v2-outbox-redis.integration.test.ts `
  test\agent-v2-durable-live-redis.integration.test.ts
Remove-Item Env:PI_TEST_REDIS_URL
```

真实 PostgreSQL integration 必须显式设置 `PI_TEST_POSTGRES_URL`，测试不会从 `.env` 猜测连接，也不应打印连接串：

```powershell
Set-Location packages\web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run `
  test\agent-v2-postgres-schema.integration.test.ts `
  test\agent-v2-postgres-durable.integration.test.ts `
  test\agent-v2-readiness-postgres.integration.test.ts
```

完整 preflight 还必须通过：

- web-workspace 全量测试和 Node workspace scenarios
- pi-coding-web 全量测试
- source mirror 全量审计
- worker/frontend production build
- `git diff --check`
- 普通/cutover Docker Compose config
- 独立整分支复审，0 Blocker / 0 Important

## 7. 手动端到端验收顺序

自动 preflight 全绿后，才进入手动真实 E2E：

1. 确认本地 Docker PostgreSQL/Redis healthy。
2. 从源码启动 Web 与 worker。
3. 执行 local cutover rehearsal。
4. 使用真实模型生成一个小型完整静态应用。
5. 验证 task graph、artifact index、build、validation 和 preview。
6. 注入可修复错误，验证 diagnostic → repair → revalidate。
7. 验证 worker crash/restart/reclaim。
8. 验证 cancel、SSE 断线重连和 durable replay。
9. 形成最终 E2E 报告。

在用户明确批准 preflight 结果前，不启动付费模型生成或 cutover E2E。

## 8. 安全与维护原则

- Workspace 所有路径必须经过 `WorkspacePathGuard`，禁止绝对路径、越界和 symlink escape。
- 静态构建使用受限 BuildRunner；不要重新暴露任意宿主 shell 或 host build command。
- preview 只服务经过验证的静态产物，并使用受信任 origin。
- canonical diagnostic 在持久化前完成脱敏；Workspace/Langfuse/archive 不接收 raw secret。
- TS/JS/source-map 是受测试约束的镜像集合；删除或修改 TS 时必须同步 JS/map，不得凭“重复”直接删除。
- 不恢复旧模块、旧 DTO、旧配置或兼容 wrapper。发现遗留 caller 时迁移 caller 到 v2 后删除旧实现。
- `.env`、本地数据库、构建产物、离线镜像和 `.superpowers/sdd` 临时报告不得提交。

当前架构依据以 Phase 9 cutover design、Phase 10 preflight design/review 和最终验收报告为准。
