# PI 诊断日志系统使用说明

本文档说明当前 PI Coding Web 的后台诊断日志系统如何启用、查看和用于排查模型问题。该日志系统面向开发和运维，不在前端界面展示。

## 1. 设计目标

PI 诊断日志用于定位以下问题：

- 模型服务连接失败、HTTP 状态异常或 provider 返回错误。
- 模型一直处于 thinking 但没有正常输出 text。
- 模型输出进入 thinking 区域，或 text/thinking 事件分布异常。
- vLLM、llama.cpp、Ollama、LM Studio 等 OpenAI-compatible 服务端的流式输出异常。
- 工具调用、项目构建、preview、PM handoff、服务端存储等后台流程异常。

日志只写入后台 SQLite 数据库，并可选把 warn/error 摘要输出到服务端 stdout。诊断采集失败不会中断 PI 主流程。

## 2. 日志存储位置

默认日志库：

```text
apps/pi-coding-web/data/logs/pi-diagnostics.sqlite
```

相对路径基于 `apps/pi-coding-web/` 解析。默认日志目录已加入 `.gitignore`，不应提交到 Git。

日常配置统一写在 `apps/pi-coding-web/.env`。`.env.example` 已列出完整配置并按用途分组。诊断日志相关变量示例：

```env
PI_LOG_DB=./data/logs/pi-diagnostics.sqlite
PI_LOG_ENABLED=true
PI_LOG_STDOUT=true
PI_LOG_RAW_PROVIDER_ENABLED=false
PI_LOG_RAW_PROVIDER_MAX_CHARS=12000
PI_LOG_PROMPT_SNAPSHOT_ENABLED=false
PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS=20000
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=false
PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS=20000
PI_LOG_RETENTION_DAYS=30
PI_LOG_MAX_EVENTS=50000
PI_LOG_CLEANUP_INTERVAL_MS=3600000
PI_LOG_VACUUM_INTERVAL_MS=86400000
```

系统环境变量仍可用于 Docker、CI 或临时调试时覆盖 `.env`：

```powershell
$env:PI_LOG_DB="C:\data\pi\logs\pi-diagnostics.sqlite"
```

系统环境变量优先级高于 `.env`，但常规部署建议把默认行为写进 `.env`，避免依赖隐式默认值。

密钥写入 `apps/pi-coding-web/.env`：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

该文件已被 `.gitignore` 忽略。配置加载优先级为：系统环境变量 > `.env` > 代码内默认值。

## 3. 启用与关闭

配置文件中默认显式启用：

```json
"loggingEnabled": true
```

如需关闭日志，优先修改配置文件：

```json
"loggingEnabled": false
```

也可以临时使用环境变量关闭：

```powershell
$env:PI_LOG_ENABLED="false"
```

开启 warn/error 的服务端 stdout 摘要，优先修改配置文件：

```json
"logStdoutEnabled": true
```

也可以临时使用环境变量开启：

```powershell
$env:PI_LOG_STDOUT="true"
```

`PI_LOG_STDOUT` 只输出 warn/error 简短摘要，完整数据仍在 SQLite 中。当前本地和 Docker 示例默认开启，便于第一时间看到 `.env`、Redis、worker、模型 provider 等关键故障。

## 4. 深度调试开关

深度调试默认关闭，只应在定位具体问题时临时开启。

### Prompt 快照

开启：

```env
PI_LOG_PROMPT_SNAPSHOT_ENABLED=true
PI_LOG_PROMPT_SNAPSHOT_MAX_CHARS=20000
```

开启后会新增：

- `model.prompt.snapshot`：PI 发给模型前的 system prompt、消息列表和工具名快照。
- `provider.payload.snapshot`：provider 实际 payload 的截断快照。

用途：

- 排查 PM handoff、skill、上下文压缩或工具历史裁剪后，最终 prompt 是否拼接错误。
- 排查 provider payload 中 messages/tools 是否符合预期。

注意：

- 快照会保存用户输入和部分上下文内容，虽然敏感字段仍会脱敏，但仍不建议生产环境长期打开。
- `promptSnapshotMaxChars` 是单次请求的快照字符预算，超过后会截断。

### 模型输出快照

开启：

```env
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true
PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS=20000
```

开启后，`model.stream.summary` 会额外保存一次可读输出快照，包含截断后的 `text_delta`、`thinking_delta` 和工具调用名称/参数片段。

用途：

- 在 Langfuse 的 generation observation 中直接查看模型最终输出，而不是只看到 `textChars`、`thinkingChars` 等统计字段。
- 排查模型把正文输出到 thinking 通道、工具调用参数不完整、输出为空但 summary 有字符计数等问题。

注意：

- 输出快照可能包含模型生成的用户数据、代码、文件名和工具参数，默认关闭。
- `PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS` 是单次模型请求输出快照的字符预算，超过后会截断。

### 原始流事件调试

开启：

```env
PI_LOG_RAW_PROVIDER_ENABLED=true
PI_LOG_RAW_PROVIDER_MAX_CHARS=12000
```

开启后会新增：

- `provider.raw_chunk`：OpenAI-compatible provider 在映射成 PI 事件前拿到的结构化 stream chunk。
- `provider.raw_chunk.truncated`：单次请求达到 `PI_LOG_RAW_PROVIDER_MAX_CHARS` 后的 provider chunk 截断提示。
- `model.stream.raw_event`：PI 解析后的流式事件序列，例如 `thinking_delta`、`text_delta`、`toolcall_delta`。
- `model.stream.raw_event.truncated`：单次请求达到 `PI_LOG_RAW_PROVIDER_MAX_CHARS` 后的截断提示。

用途：

- 排查模型是否持续输出 thinking delta，但没有 text delta。
- 排查 vLLM、llama.cpp 等 OpenAI-compatible 服务端返回的结构化 chunk 中，内容到底落在 `content`、`reasoning_content`、`reasoning`、`tool_calls` 等哪个字段。
- 排查 text、thinking、tool call 在 PI 事件层的实际分布。
- 排查工具参数是否在流式 delta 中被截断、拆分或无法解析。

边界：

- `provider.raw_chunk` 记录的是 OpenAI SDK 解析后的结构化 chunk，不是 HTTP SSE 原文字节。
- `model.stream.raw_event` 记录的是 PI 已解析后的 `AssistantMessageEvent`。
- 如果需要分析 HTTP SSE 原始帧、换行、`data:` 前缀或字节级协议问题，后续还需要绕过 SDK 或在更底层 fetch/stream reader 增加字节级 hook。
- 不建议长期打开，日志量会明显增加。

### 日志保留与压缩

默认配置：

```json
"logRetentionDays": 30,
"logMaxEvents": 50000,
"logCleanupIntervalMs": 3600000,
"logVacuumIntervalMs": 86400000
```

含义：

- `logRetentionDays`：保留最近多少天的日志；设为 `0` 表示不按天数清理。
- `logMaxEvents`：最多保留多少条日志；设为 `0` 表示不按条数清理。
- `logCleanupIntervalMs`：写入日志后，至少间隔多久执行一次清理；设为 `0` 表示每次写入后都检查清理。
- `logVacuumIntervalMs`：清理删除数据后，至少间隔多久执行一次 SQLite `VACUUM` 压缩；设为 `0` 表示不执行 `VACUUM`。

Docker 长期部署建议保留默认清理策略，或按磁盘容量调低 `logRetentionDays` / `logMaxEvents`。

## 5. 后台查看命令

进入 PI Coding Web 应用目录：

```powershell
cd C:\PM-Coding\pi-mono-0.73.0\apps\pi-coding-web
```

查看最近 50 条日志：

```powershell
npm run logs
```

查看最近错误：

```powershell
npm run logs -- --level error --limit 50
```

按会话过滤：

```powershell
npm run logs -- --session <sessionId>
```

按 trace 过滤：

```powershell
npm run logs -- --trace <traceId>
```

按分类过滤：

```powershell
npm run logs -- --category model
npm run logs -- --category provider
npm run logs -- --category tool
```

按事件类型过滤：

```powershell
npm run logs -- --event model.stream.summary
npm run logs -- --event provider.response
npm run logs -- --event model.prompt.snapshot
npm run logs -- --event provider.payload.snapshot
npm run logs -- --event provider.raw_chunk
npm run logs -- --event model.stream.raw_event
```

指定日志库路径：

```powershell
npm run logs -- --db C:\data\pi\logs\pi-diagnostics.sqlite --limit 100
```

当前查看脚本最多返回 500 条，默认 50 条。

注意：当前项目使用 Node 内置 `node:sqlite`。在 Node 24 中运行查看命令时可能出现 SQLite experimental warning，这是 Node 的提示，不表示日志读取失败。

## 6. Docker 部署建议

Docker 中应把 PI 运行数据目录挂载到：

```text
/app/apps/pi-coding-web/data
```

这样默认日志库会随数据目录持久化：

```text
/app/apps/pi-coding-web/data/logs/pi-diagnostics.sqlite
```

也可以单独指定并挂载日志路径：

```yaml
services:
  pi-coding-web:
    environment:
      PI_LOG_ENABLED: "true"
      PI_LOG_DB: "/app/apps/pi-coding-web/data/logs/pi-diagnostics.sqlite"
      PI_STORAGE_ENV_FILE: "/app/apps/pi-coding-web/.env"
      PI_LOG_STDOUT: "true"
      PI_LOG_PROMPT_SNAPSHOT_ENABLED: "false"
      PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED: "false"
      PI_LOG_RAW_PROVIDER_ENABLED: "false"
      PI_LANGFUSE_ENABLED: "false"
      PI_LANGFUSE_HOST: "http://langfuse:3000"
      PI_LANGFUSE_OTEL_ENDPOINT: ""
      LANGFUSE_PUBLIC_KEY: ""
      LANGFUSE_SECRET_KEY: ""
      PI_OTEL_SERVICE_NAME: "pi-coding-web"
      PI_OTEL_DEPLOYMENT_ENVIRONMENT: "production"
    volumes:
      - ./data:/app/apps/pi-coding-web/data
```

如果只依赖容器文件系统而不挂载 volume，容器重建后日志会丢失。

当前 Docker 正常部署应使用 `docker/pi-coding-web/docker-compose.yaml`，包含 `redis`、`pi-coding-web`、`pi-worker` 三个服务。常用排查命令：

```bash
docker compose ps
docker compose logs -f pi-coding-web pi-worker redis
docker compose exec pi-coding-web npm run logs -- --level error --limit 50
```

需要重点关注的运行时事件：

- `system.config.env_missing`：容器或本地进程没有读到 `.env`。
- `agent.run.enqueue.error`：Web 创建 run 后写入 Redis 队列失败。
- `worker.queue.claim.error`：worker 从 Redis 队列 claim 任务失败，通常是 Redis 不可用或队列连接断开。
- `agent.remote_run.queued_timeout`：run 长时间停在 queued，通常表示 worker 没启动或无法消费队列。

## 7. API 状态检查

服务端提供日志状态接口：

```text
GET /api/pi-logs/status
```

返回内容包含：

- `enabled`：是否启用日志。
- `databaseFile`：当前 SQLite 日志库路径。
- `eventCount`：当前事件数量。
- `rawProviderLoggingEnabled`：是否启用原始流事件调试。
- `promptSnapshotLoggingEnabled`：是否启用 prompt/payload 快照。
- `modelOutputSnapshotLoggingEnabled`：是否启用模型输出快照。
- `logRetentionDays`、`logMaxEvents`：当前保留策略。
- `lastCleanupAt`、`lastVacuumAt`：最近清理和压缩时间。
- `langfuseEnabled`：是否启用 Langfuse 导出。
- `langfuseConfigured`：Host、public key、secret key 是否已配置完整。
- `langfuseHost`：当前 Langfuse Host。
- `langfuseOtelEndpoint`：当前最终 OTLP trace endpoint。
- `langfuseQueuedEvents`：当前等待导出的内存队列长度。
- `langfuseLastFlushAt`、`langfuseLastError`：最近导出时间和错误摘要。
- `otelServiceName`、`otelDeploymentEnvironment`：当前 OTEL resource/service 标识。

`/api/pi-storage/status` 也会带出日志和运行时相关状态，包括 `envFile`、`envFileExists`、`runsEnabled`、`runtimeDbFile`、`redisUrl`、`workerId`、`workerConcurrency`、`runQueueName` 和日志开关，便于部署排查当前实例是否读到了正确配置。

## 8. 事件分类

常用分类：

- `provider`：模型 provider 请求、payload 摘要、HTTP 响应、请求错误。
- `model`：模型流式输出摘要，包括 text/thinking/tool-call 计数和停止原因。
- `agent`：Agent 生命周期和关键运行事件。
- `tool`：工具执行相关事件。
- `project`：项目 preview、project task、构建和日志读取相关事件。
- `handoff`：PM handoff 读取、下载和注入相关异常。
- `storage`：会话和设置保存异常。
- `system`：通用后台事件。

Skill 配置质量诊断，例如 `SKILL.md` frontmatter、description 质量和 skill 重名冲突，只通过 `/api/pi-skills` 返回并显示在前端 Skill 面板，不写入后台诊断日志。

事件等级：

- `debug`：详细诊断，例如 provider payload 摘要。
- `info`：正常关键节点。
- `warn`：可恢复但需要关注的问题。
- `error`：失败、异常或需要排查的问题。

## 9. 模型问题排查路径

### 模型服务连接失败

优先查看：

```powershell
npm run logs -- --category provider --level error --limit 50
```

重点看：

- `provider.request.error`：请求发起失败、网络错误、base URL 不可达。
- `provider.response`：HTTP 状态码是否为 400、401、404、429、500 等。
- `provider`、`model`：确认实际请求的是哪个服务商和模型。

### 模型一直 thinking 但没有输出

优先查看：

```powershell
npm run logs -- --event model.stream.summary --limit 50
```

重点看：

- `thinkingDeltaCount` 和 `thinkingChars` 是否持续增长。
- `textDeltaCount` 和 `textChars` 是否为 0 或很低。
- `stopReason` 是否为 `error`、`stop` 或其他异常值。
- `durationMs` 是否异常长。

如果 `thinkingChars` 很高但 `textChars` 接近 0，通常说明模型或服务端把主要内容输出到了 thinking 通道，或流式事件映射存在兼容问题。

如果需要进一步看流式事件序列，临时打开：

```env
PI_LOG_RAW_PROVIDER_ENABLED=true
```

然后查看：

```powershell
npm run logs -- --event model.stream.raw_event --limit 100
npm run logs -- --event provider.raw_chunk --limit 100
```

### 工具调用异常

优先查看：

```powershell
npm run logs -- --category tool --limit 100
npm run logs -- --event model.stream.summary --limit 100
```

重点看：

- `toolCallCount` 是否为 0。
- Agent 是否产生了工具事件。
- provider payload 中 `toolCount`、`toolNames` 是否符合预期。

如果 payload 中有工具但模型没有产生工具调用，优先判断模型 tool calling 能力或 vLLM/llama.cpp 兼容层配置。

如果需要确认最终发给 provider 的工具 schema 和消息结构，临时打开：

```env
PI_LOG_PROMPT_SNAPSHOT_ENABLED=true
```

然后查看：

```powershell
npm run logs -- --event provider.payload.snapshot --limit 20
```

### PM handoff 异常

优先查看：

```powershell
npm run logs -- --category handoff --level error --limit 50
```

重点看：

- handoff token 是否可用。
- PM API base URL 是否正确。
- 附件下载是否失败。

## 10. 脱敏与日志边界

当前日志会对常见敏感字段做脱敏，包括：

- `authorization`
- `apiKey`、`api_key`
- `accessToken`、`refreshToken`
- `cookie`
- `password`
- `secret`
- `credential`
- `bearer`

默认 provider payload 不保存完整消息正文，而是保存摘要，例如消息数量、内容类型和长度、工具数量和工具名。字符串会被截断，对象深度、数组长度和 key 数量也有限制。

打开 `PI_LOG_PROMPT_SNAPSHOT_ENABLED` 后，日志会保存截断后的 prompt/payload 快照。打开 `PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED` 后，`model.stream.summary` 会保存截断后的可读输出快照。打开 `PI_LOG_RAW_PROVIDER_ENABLED` 后，日志会保存截断后的流式事件 delta。这些深度开关都应该只在定位问题时临时开启。

注意：

- 诊断日志仍可能包含模型名、provider 名、base URL host、session id、trace id、错误信息和工具名。
- 不应把 SQLite 日志库当作公开前端资源。
- 生产环境如果需要长期保存，应结合当前保留策略继续增加归档、访问权限控制和外部备份策略。

## 11. Langfuse 集成

当前版本已支持后台异步导出到 Langfuse。SQLite 仍是本地兜底日志，Langfuse 只用于集中查看 trace、generation 和关键事件。

默认配置：

```env
PI_LANGFUSE_ENABLED=false
PI_LANGFUSE_HOST=http://localhost:3000
PI_LANGFUSE_OTEL_ENDPOINT=
PI_LANGFUSE_FLUSH_INTERVAL_MS=5000
PI_LANGFUSE_BATCH_SIZE=50
PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=false
PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=false
PI_LANGFUSE_EXPORT_RAW_CHUNKS=false
PI_OTEL_SERVICE_NAME=pi-coding-web
PI_OTEL_DEPLOYMENT_ENVIRONMENT=development
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
```

启用步骤：

1. 在 Langfuse 项目中创建 API key，取得 public key 和 secret key。
2. 修改 `apps/pi-coding-web/.env`：

```env
PI_LANGFUSE_ENABLED=true
PI_LANGFUSE_HOST=http://localhost:3000
PI_LANGFUSE_OTEL_ENDPOINT=
PI_OTEL_SERVICE_NAME=pi-coding-web
PI_OTEL_DEPLOYMENT_ENVIRONMENT=development
```

`PI_LANGFUSE_OTEL_ENDPOINT` 为空时，PI 会自动使用：

```text
<langfuseHost>/api/public/otel/v1/traces
```

如果你后续要先发到 OpenTelemetry Collector，再由 Collector 转发到 Langfuse，可以显式设置：

```env
PI_LANGFUSE_OTEL_ENDPOINT=http://otel-collector:4318/v1/traces
```

3. 在 `.env` 中填写密钥，避免把 secret key 写进仓库跟踪文件。

本地开发推荐创建：

```text
apps/pi-coding-web/.env
```

内容：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

Docker、CI 或临时调试也可以直接使用环境变量：

```powershell
$env:LANGFUSE_PUBLIC_KEY="pk-lf-..."
$env:LANGFUSE_SECRET_KEY="sk-lf-..."
```

也可以使用 PI 专用环境变量覆盖：

```powershell
$env:PI_LANGFUSE_ENABLED="true"
$env:PI_LANGFUSE_HOST="http://localhost:3000"
$env:PI_LANGFUSE_OTEL_ENDPOINT=""
$env:PI_LANGFUSE_PUBLIC_KEY="pk-lf-..."
$env:PI_LANGFUSE_SECRET_KEY="sk-lf-..."
$env:PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS="false"
$env:PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS="false"
$env:PI_LANGFUSE_EXPORT_RAW_CHUNKS="false"
$env:PI_OTEL_SERVICE_NAME="pi-coding-web"
$env:PI_OTEL_DEPLOYMENT_ENVIRONMENT="development"
```

4. 重启 PI Coding Web，使配置重新加载。
5. 发起一次模型对话，等待 `langfuseFlushIntervalMs` 后到 Langfuse 的 Traces 页面查看。

Docker 示例：

```yaml
services:
  pi-coding-web:
    environment:
      PI_LANGFUSE_ENABLED: "true"
      PI_LANGFUSE_HOST: "http://langfuse:3000"
      PI_LANGFUSE_OTEL_ENDPOINT: ""
      LANGFUSE_PUBLIC_KEY: "pk-lf-..."
      LANGFUSE_SECRET_KEY: "sk-lf-..."
      PI_OTEL_SERVICE_NAME: "pi-coding-web"
      PI_OTEL_DEPLOYMENT_ENVIRONMENT: "production"
      PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS: "false"
      PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS: "false"
      PI_LANGFUSE_EXPORT_RAW_CHUNKS: "false"
    volumes:
      - ./data:/app/apps/pi-coding-web/data
```

状态检查：

```powershell
Invoke-RestMethod http://127.0.0.1:5173/api/pi-logs/status
```

重点看：

- `langfuseEnabled` 是否为 `true`。
- `langfuseConfigured` 是否为 `true`。
- `langfuseOtelEndpoint` 是否是期望的 `/api/public/otel/v1/traces` 或 Collector trace endpoint。
- `langfuseQueuedEvents` 是否持续堆积。
- `langfuseLastFlushAt` 是否在模型请求后更新。
- `langfuseLastError` 是否出现 HTTP、认证或网络错误。

如果要在 Langfuse 的 generation observation 中看到可读 Input / Output，而不是只看到统计元数据，需要同时开启本地采集和 Langfuse 上传：

```env
PI_LOG_PROMPT_SNAPSHOT_ENABLED=true
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true
PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=true
PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=true
```

如果还要分析 provider chunk 或 PI raw stream event 的中间过程，再临时开启：

```env
PI_LOG_RAW_PROVIDER_ENABLED=true
PI_LANGFUSE_EXPORT_RAW_CHUNKS=true
```

Langfuse trace 左侧的 `agent.*` observation 是 PI 生命周期事件，不是模型请求；这些事件没有 LLM input/output，界面里出现 `null` 或 `undefined` 是正常的。模型输入输出应查看带粉色 generation 图标的 `model.stream.summary`、`provider.response` 或 `provider.request.error` observation。

导出规则：

- 每个 PI trace 会转换为一个 OTEL root span。
- `model.stream.summary`、`provider.response`、`provider.request.error` 会转换为带 `langfuse.observation.type=generation` 的 OTEL span。
- 其他诊断事件会转换为带 `langfuse.observation.type=event` 的 OTEL span。
- PI 会通过 OTLP/HTTP JSON POST 到最终 `langfuseOtelEndpoint`，并带上 `x-langfuse-ingestion-version: 4`。
- 导出是后台异步队列，Langfuse 网络失败不会中断 PI 对话或项目生成。
- secret、cookie、authorization、api key 等敏感字段会在写入 SQLite 前脱敏，导出前也会再次过滤。

隐私边界：

- 默认不会把完整 prompt/payload snapshot 上传到 Langfuse。
- 默认不会把模型输出快照上传到 Langfuse。
- 默认不会把 provider raw chunk 或 PI raw stream event 上传到 Langfuse。
- 即使本地开启了 `PI_LOG_PROMPT_SNAPSHOT_ENABLED`，仍需同时开启 `PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS` 才会上传 prompt/payload 快照。
- 即使本地开启了 `PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED`，仍需同时开启 `PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS` 才会上传模型输出快照。
- 即使本地开启了 `PI_LOG_RAW_PROVIDER_ENABLED`，仍需同时开启 `PI_LANGFUSE_EXPORT_RAW_CHUNKS` 才会上传 raw chunk/raw event。
- 开启上述上传前，应确认 Langfuse 部署、访问权限和数据保留策略满足当前项目的隐私要求。

当前实现直接发送 OTLP/HTTP JSON 到 Langfuse `/api/public/otel/v1/traces`，没有引入 SDK 依赖。这样 PI、PM、模型网关和 worker 后续都可以按 OpenTelemetry trace/span 语义对齐；如果后续需要自动上下文传播、采样、Collector、metrics 或 logs，再引入标准 OpenTelemetry SDK 和 Collector 会更合适。
