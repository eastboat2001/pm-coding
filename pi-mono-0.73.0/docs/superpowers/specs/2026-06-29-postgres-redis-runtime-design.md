# Postgres + Redis Runtime 设计

## 背景

PI Web 当前后台 run 链路把 sessions、runs、messages、run events 都写入 SQLite。Docker 部署中 `pi-coding-web` 和 `pi-worker` 是两个进程/容器，共享同一个 `data` volume。SQLite 使用 WAL 后可以改善读写并发，但仍然只有一个 writer；多人、多会话、worker 并发时会出现 `database is locked`、响应卡顿、切换会话慢、实时输出慢。

当前性能问题不只是数据库锁。worker 会把 token 级 `message_update` 写入 `run_events`，而这些 `message_update` 是完整 partial message 快照，不是小 delta。前端恢复 active run 时会 `listRunEvents(runId, 0)` 全量读取并 `hydrateRunEvents` 回放，导致历史事件越多，切会话和恢复越慢。SSE 入口也仍然每 100ms 轮询 durable DB，本质上把数据库当实时消息总线。

## 目标

- 用 PostgreSQL 替换 SQLite runtime 主库，支持多人和多 run 并发写入。
- Docker Compose 新增 PostgreSQL，并与 Redis、Web、Worker 一起编排，开发机和内网服务器都通过 Docker 启动依赖。
- Redis Stream 承担 live run event，总线不再依赖 durable DB 轮询。
- PostgreSQL 保存长期事实：sessions、runs、messages、最终 assistant message、关键 durable events、低频 streaming checkpoint。
- 前端恢复 active run 不再全量回放 run events。
- 降低 token 输出链路上的同步 I/O 和渲染压力，让“吐字”更快、更稳定。
- 保持 `X-PI-Client-ID` 隔离语义：PI runtime/project API 必须继续携带并校验该 header。

## 非目标

- 不迁移旧 SQLite runtime 数据。现有 SQLite 数据均视为测试数据。
- 不做用户账号、鉴权或跨浏览器共享会话。
- 不把 Redis 作为长期事实来源。
- 不把 run queue 和 run event bus 混成一个浅模块。
- 不在本阶段重写模型 provider、工具执行或 PM handoff 协议。

## 选择的架构

采用 Postgres durable state + Redis live event bus：

- `PostgresRuntimeStore`
  - 替代 `RuntimeDbStore` 成为生产 runtime store。
  - 负责 clients、sessions、messages、runs、durable run events、app preview goals。
  - 使用连接池，所有查询都按 `client_id` 隔离。

- `RedisRunQueue`
  - 继续负责 run queue、worker claim、cancel signal。
  - 仍使用现有 Redis 服务。

- `RedisRunEventBus`
  - 新增专用 live event bus。
  - 每个 run 一个 Redis Stream。
  - key 形如 `pi:runs:{clientId}:{sessionId}:{runId}:events`。
  - Stream ID 使用 `{seq}-0`，便于根据 `afterSeq` 去重和恢复。

- `RunEventSink`
  - worker 唯一写 run event 的入口。
  - 负责 seq 分配、Redis live publish、Postgres durable persistence、checkpoint policy。
  - 调用方不直接决定哪些事件 durable，避免策略散落。

## Docker 与配置

`docker/pi-coding-web/docker-compose.yaml` 新增 `postgres` 服务：

- image 使用稳定 PostgreSQL 版本。
- 持久化 volume：`pi-postgres-data`。
- `pi-coding-web` 和 `pi-worker` 通过 `PI_POSTGRES_URL` 连接。
- `postgres` 和 `redis` 都有 healthcheck；Web/Worker 等待两者 healthy。

新增配置：

- `PI_POSTGRES_URL`
  - 默认：`postgres://pi:pi@postgres:5432/pi_coding`
- `PI_RUNTIME_STORE`
  - 默认生产值：`postgres`
  - 测试可继续使用内存或临时 store。
- `PI_RUN_EVENT_STREAM_MAXLEN`
  - Redis Stream 近似最大长度。
- `PI_RUN_EVENT_STREAM_TTL_SECONDS`
  - terminal run 后 live stream 保留时间。
- `PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS`
  - streaming checkpoint 最小时间间隔。
- `PI_RUN_EVENT_CHECKPOINT_MIN_CHARS`
  - 累计文本变化超过该值可提前 checkpoint。

SQLite runtime 配置不再作为生产路径使用。旧 `PI_DB_FILE` 可以保留为兼容配置，但当 `PI_RUNTIME_STORE=postgres` 时不读取。

## Postgres 数据模型

Postgres 表沿用现有 runtime 语义，但使用 snake_case DB 字段和 camelCase API record 映射。

### clients

- `client_id` primary key
- `created_at`
- `last_seen_at`

### sessions

- `session_id`
- `client_id`
- `title`
- `model_json`
- `thinking_level`
- `created_at`
- `updated_at`
- `last_run_status`
- `last_run_id`

唯一约束：`(client_id, session_id)`。

### messages

- `message_id` generated primary key
- `session_id`
- `client_id`
- `role`
- `payload_json`
- `created_at`

Messages 是会话历史的长期事实来源。完成的 assistant message 必须来自 `message_end` 并写入该表。

### runs

- `run_id`
- `session_id`
- `client_id`
- `status`
- `worker_id`
- `model_json`
- `thinking_level`
- `started_at`
- `updated_at`
- `ended_at`
- `error`

同一 session 同一时间只允许一个 active run。Postgres 应通过事务和条件更新保证 `queued/running/cancelling` 状态互斥。

### run_events

该表只保存 durable events：

- `event_id` generated primary key
- `run_id`
- `session_id`
- `client_id`
- `seq`
- `event_type`
- `payload_json`
- `created_at`
- `durability`

`durability` 可取：

- `key`: agent_start、turn_start、tool_execution_start/end、turn_end、agent_end、retry/status/cancel 事件。
- `checkpoint`: 节流后的 message_update 快照。
- `final`: message_end 及需要长期保留的最终输出事件。

`message_update` 的 token 级 live 事件不进入该表，除非被 checkpoint policy 选中。

### app_preview_goals 与 app_preview_goal_events

迁移到 Postgres，字段语义保持现状。相关查询仍按 `client_id + session_id` 隔离。

## RunEventSink 策略

所有 Agent event 都获得 run 内单调 `seq`。

Live path：

- 所有事件写入 Redis Stream。
- Redis 写失败时，该 run 进入明确 degraded/fail-fast 状态；SSE 不静默卡住。
- terminal 后设置 stream TTL，避免 Redis 长期积累。

Durable path：

- `message_end` 完整写入 `messages`，同时写 durable event。
- `message_update` 仅在满足 checkpoint interval 或字符阈值时写 durable checkpoint。
- tool、retry、status、agent_end、cancel 相关事件写 durable event。
- 内部 continuation prompt 这类可重放控制事件不作为用户可见历史重复展示。

Checkpoint 内容用于恢复当前 streaming assistant message。它必须包含：

- `seq`
- `runId`
- `sessionId`
- `clientId`
- 当前 streaming message 快照
- 创建时间

## SSE 设计

`streamRunEvents` 改为异步 Redis Stream 消费：

1. 校验 `X-PI-Client-ID`。
2. 从 Postgres 查询 run/session 是否属于该 client。
3. 根据 `afterSeq` 发送 durable catch-up events 或 latest checkpoint。
4. 从 Redis Stream `XREAD` 读取 `seq > afterSeq` 的 live events。
5. 保留 heartbeat。
6. request close 时释放阻塞读取连接。
7. Redis 不可用时返回明确 SSE error event 或 HTTP 错误。

非 stream 的 `GET /api/pi-runs/:runId/events` 保留，但语义改为查询 durable events/checkpoints，不再承诺返回所有 token 级 live events。

## 前端恢复设计

`loadSession(active run)` 不再调用 `listRunEvents(activeRun.runId, 0)`。

Runtime session detail 或新增 restore API 返回：

- session
- messages
- runs
- active run restore 信息
  - latest checkpoint event
  - checkpoint seq
  - recommended afterSeq

恢复流程：

1. 用 `messages` 构建已完成历史。
2. 如果有 active run checkpoint，用 checkpoint 恢复 streaming message。
3. `RemoteAgentController` 从 checkpoint seq 初始化 `lastSeq`。
4. `connectRunEvents` 从 `afterSeq` 建立 SSE。
5. `applyRunEvent` 继续做 seq 去重，避免用户消息和 assistant final message 重复显示。

前端渲染还应对高频 message_update 做合并：事件可实时接收，但 UI render 应按 animation frame 或短时间窗口合并，避免每个 token 都触发完整应用重绘。

## App 面板性能

App 面板卡顿与 run event 问题相关，但还有独立 API 放大问题。保留旧方案中的 batch 优化：

- 新增 batch project summary API。
- 一次请求返回多个 session 的 project/file/preview summary。
- 每个请求继续校验 `X-PI-Client-ID`。
- 前端 `generated-apps-state` 使用短缓存和手动刷新。
- 点击单个卡片不阻塞整个面板刷新。

该优化可以和 Postgres/Redis runtime 同阶段实现，但应保持模块边界，不让 project API 直接耦合 run event bus。

## 降级与错误处理

- Postgres 不可用：start/list/session/run API 返回明确 503，worker 启动失败并记录诊断。
- Redis queue 不可用：run enqueue 返回明确 503。
- Redis event bus 不可用：active run 不进入静默执行。worker 应标记 run 失败或 interrupted，前端显示可重试错误。
- SSE 断开：前端按 lastSeq 重连。
- Redis stream 被 trim：前端从 Postgres latest checkpoint 恢复，再从该 seq 后继续；如果 run 已 terminal，则以 messages/runs 为准。

## 测试策略

`packages/web-workspace`：

- `RunEventSink`：高频 message_update 全部 live publish，但 durable checkpoint 被限流；message_end 完整写入 messages。
- `RedisRunEventBus`：stream ID 与 seq 对齐，afterSeq 去重，close 释放阻塞读取。
- `PostgresRuntimeStore`：clientId 隔离、active run 互斥、run status 更新、message append、durable events 查询。
- SSE：先 durable catch-up/checkpoint，再接 live stream；断线释放资源；Redis 不可用返回明确错误。
- App Preview Goal：transient provider failure without durable output 的判断改用 durable summary/checkpoint 后仍正确。
- Batch project summary API：clientId 隔离、缺失项目处理、previewUrl 和文件摘要正确。

`apps/pi-coding-web`：

- `RemoteAgentController`：从 checkpoint/initialSeq 恢复，不重复用户消息和 assistant final message。
- `run-client`：SSE afterSeq、重连、错误状态。
- `loadSession`：active run restore 不全量 replay。
- `generated-apps-state`：使用 batch API，携带 `X-PI-Client-ID`，缓存和刷新行为正确。

验证命令限定在相关包：

- `npm run check --workspace=@mariozechner/pi-web-workspace`
- `npm run check --workspace=pi-coding-web`
- 对修改过的 test files 运行对应 vitest 单文件命令。

## 实施阶段

1. Docker 和配置
   - 新增 Postgres compose 服务、volume、healthcheck。
   - 新增 Postgres URL 和 runtime store 配置。

2. Store 抽象与 Postgres 实现
   - 抽出 runtime store 接口。
   - 实现 Postgres schema 初始化和查询。
   - 生产路径切到 Postgres，不迁移旧 SQLite。

3. Run event bus 与 sink
   - 新增 RedisRunEventBus。
   - 新增 RunEventSink 和 checkpoint policy。
   - worker 改用 sink。

4. SSE 和 API
   - SSE 从 DB poll 改为 durable catch-up + Redis XREAD。
   - session detail 增加 active run restore 信息。

5. 前端恢复和渲染节流
   - `loadSession` 改为 checkpoint restore。
   - `RemoteAgentController` 支持 initial seq/checkpoint。
   - 合并高频 UI render。

6. App 面板 batch
   - 新增 batch summary API。
   - 前端改用 batch/cached state。

## 风险与边界

- 这是一次 runtime 架构迁移，不能与无关 UI 重构混做。
- Postgres schema 和 Redis stream 语义必须先通过单元测试锁定。
- 不迁移旧 SQLite 意味着升级后旧测试会话不可见，这是有意行为。
- Redis 只保存 live window；最终历史必须能从 Postgres messages/runs/checkpoints 恢复。
- 多 clientId、多浏览器、多 session 同时运行时，所有 API 和 stream key 都必须带 clientId 隔离。
