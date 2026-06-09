# PI-mono 本地改造说明

本文档用于记录本仓库基于上游 PI-mono 项目的本地改造方向、当前目录整理结果，以及后续开发建议。原始 `README.md` 尽量保留上游项目说明，本文件专门描述我们自己的产品化改造内容。

## 1. 改造背景

当前 `pi-mono-0.73.0` 仍以 PI-mono 的 monorepo 为基础，核心包包括：

- `packages/ai`：多模型、多 provider 的 LLM API 封装。
- `packages/agent`：Agent 运行时、工具调用和状态管理。
- `packages/coding-agent`：命令行编码 Agent。
- `packages/tui`：终端 UI 组件。
- `packages/web-ui`：浏览器端聊天 UI 组件库。

本地改造的主要目标不是继续维护一个简单 demo，而是把 PI Web UI 扩展成可被 PM 平台调用的产品化编码 Web 应用。它需要支持：

- PM 平台通过 handoff token 打开 PI。
- 自动读取 PM 传入的 PRD、设计文档和实现提示词。
- 在服务端固定 workspace 中生成项目文件。
- 通过受控任务做静态应用验证、构建和预览。
- 发布 `/preview/<project-id>/` 静态预览地址。
- 持久化会话、模型选择和生成项目文件。
- 支持 Docker 部署和数据目录挂载。

因此，原来放在 `packages/web-ui/example` 下的代码已经不再是“示例”，而是一个产品应用。目录整理的核心思路是：保留上游核心包边界，把本地产品化代码移动到独立应用和内部支撑包中。

## 2. 当前目录整理结果

### `apps/pi-coding-web`

这是当前产品化 PI Web 应用的位置。它替代了原来的 `packages/web-ui/example`。

主要职责：

- 初始化浏览器端 PI Chat 应用。
- 管理 IndexedDB 与服务端 JSON 镜像存储。
- 处理 PM handoff 流程。
- 注册 `skill_load`、`skill_resource`、`project_file`、`project_task` 工具。
- 提供 Dockerfile、Vite 配置和产品应用 README。

关键子目录：

- `src/app/`：应用启动、模型选择、会话标题等应用层逻辑。
- `src/integrations/`：外部系统接入，目前主要是 PM handoff。
- `src/prompts/`：PI 编码应用系统提示词和平台执行说明。
- `src/project-tools/`：浏览器端 project 工具 schema、API client、AgentTool 创建和工具卡渲染。
- `src/skill-tools/`：浏览器端全局 skill 工具 schema、API client、AgentTool 创建、工具卡渲染、`/skill` 下拉和 `/skill:name` 展开。
- `src/storage/`：浏览器端调用服务端 storage API 的封装。

### `packages/web-workspace`

这是新增的内部支撑包，用于承载原 `storage-server.ts` 中的服务端能力。

主要职责：

- 读取 `.env`。
- 解析 session、settings、projects 等数据目录。
- 提供会话 JSON 存储。
- 提供服务端 project 文件操作。
- 提供服务端全局 skill 发现、加载和受限资源读取。
- 提供受控 project task 能力。
- 构建静态前端产物并发布静态 preview。
- 暴露 Vite plugin：`configuredStoragePlugin()`。

公开入口：

- `loadStorageConfig`
- `WorkspaceSessionService`
- `WorkspaceFileService`
- `WorkspaceTaskService`
- `WorkspaceCommandService`
- `WorkspacePreviewService`
- `WorkspaceSkillService`
- `configuredStoragePlugin`

说明：

- 当前 Agent 对外暴露 `skill_load`、`skill_resource`、`project_file` 和 `project_task`。
- `skill_load`、`skill_resource` 只读取服务端配置的全局 skill 目录，不提供通用文件读取能力，也不执行 skill 中的脚本。
- `WorkspaceCommandService` 仍保留在包内，主要用于历史兼容和内部构建执行支撑，不应理解为 AI 可以直接运行任意 shell 命令。
- `WorkspacePreviewService` 当前只负责静态预览，不启动 Node HTTP 服务。
- Agent 工具到服务端 API 的主要映射是：
  - `project_file` -> `POST /api/pi-projects/workspace/file`
  - `project_task` -> `POST /api/pi-projects/workspace/task`
  - `skill_load` -> `POST /api/pi-skills/load`
  - `skill_resource` -> `POST /api/pi-skills/resource`
- `/api/pi-projects/workspace/preview` 仍存在于 middleware 中，用于兼容或内部调用，不应重新暴露为 Agent 工具。

该包使服务端 workspace 能力脱离具体 Web 应用，后续如果需要独立服务、权限隔离、多用户队列、沙箱或运行管理，可以继续在这里演进。

### `packages/web-ui`

该目录继续作为纯浏览器 UI 组件库，不再承担产品应用职责。

保留职责：

- `ChatPanel`
- 消息渲染
- 工具卡基础渲染能力
- 设置弹窗
- IndexedDB storage primitives
- i18n 基础能力
- 附件与 artifacts UI

不再放置：

- PM 平台接入逻辑
- 服务端本地文件写入
- 命令执行
- preview 发布
- Docker 部署配置
- 运行数据

## 3. 已完成的重要变更

- 根 workspace 从只包含 `packages/*`，扩展为同时包含 `apps/*`。
- `packages/web-ui/example` 被迁移为 `apps/pi-coding-web`。
- 新增 `packages/web-workspace`，拆分原服务端 middleware 的职责。
- `apps/pi-coding-web/src/main.ts` 缩减为应用入口。
- 浏览器应用逻辑拆分到 `app/`、`integrations/`、`prompts/`、`project-tools/`。
- Agent 工具从 `project_file`、`project_bash`、`project_preview` 收敛为 `project_file`、`project_task`。
- 新增全局 skill 工具：`skill_load` 用于加载 `SKILL.md`，`skill_resource` 用于读取该 skill 目录内的文本资源。
- 首版只支持服务端全局 skill，默认目录为 `apps/pi-coding-web/data/skills`；暂不支持项目级或会话级 skill。
- `project_task` 只支持受控任务：`inspect`、`validate`、`build_static`、`preview`、`logs`。
- `project_task` 不接收原始 shell 命令；只有 `build_static` 会运行服务端配置的安装/构建命令。
- preview 改为静态预览模式，只服务 `index.html` 或 `dist/`、`build/`、`public/` 等静态产物，不再启动 Node 服务。
- Vite watcher 已忽略 sessions、projects、settings 等运行数据路径，避免 Agent 写文件时触发 Web 应用刷新。
- Agent 初始化时直接注入模型 API key 读取函数，避免页面刷新后恢复会话时出现 `No API key for provider`。
- 自定义服务商存储改为服务端 JSON 与浏览器 IndexedDB 双层同步；当服务端 `customProviders` 为空数组但本地仍有服务商时，不再用空数组反向清空本地配置，而是优先把本地配置写回服务端。
- 小模型工具调用兼容增强：支持工具参数别名归一、缺参时报出更明确的工具调用格式提示，并增加手动可选的非流式工具调用兼容模式。
- 非流式工具调用兼容模式不是 vLLM 自动默认开启；需要在对应自定义服务商配置中手动开启，避免后续更强模型默认失去流式输出。
- Agent 发送上下文前会对旧的 `project_file.content` 做确定性裁剪，只保留最近一次完整工具调用，旧的大文件内容替换为 `[project_file content omitted: ...]` 占位符，减少多文件生成后的上下文污染。
- 系统提示词已要求：如果历史中出现 `project_file content omitted`，或需要修改已有文件但最新上下文没有完整当前内容，必须先调用 `project_file get` 读取文件。
- `project_file` 失败卡片渲染已调整：失败或中断时优先显示真实错误信息，不再展示模型尝试写入的完整文件正文，避免误判为“文件已成功创建”。
- Dockerfile 和 compose 挂载路径改为 `apps/pi-coding-web/data`。
- `.dockerignore` 已排除递归 `*.tar`、`*.tar.gz`，避免离线镜像包被再次加入 Docker build context。
- 原 `packages/web-ui/example/data/*` 运行数据从仓库结构中移除。
- 原生成项目 `packages/web-ui/example/kanban` 从产品代码路径中移除。

## 4. 当前开发与运行入口

### 安装依赖

```bash
npm install
```

### 构建关键包

```bash
npm run build --workspace=@mariozechner/pi-web-workspace
npm run build --workspace=@mariozechner/pi-web-ui
npm run build --workspace=pi-coding-web
```

### 检查关键包

```bash
npm run check --workspace=@mariozechner/pi-web-workspace
npm run check --workspace=@mariozechner/pi-web-ui
npm run check --workspace=pi-coding-web
```

### 运行 PI Coding Web

当前后台任务能力默认开启。只启动 Vite Web 进程只能打开页面和 API 网关，但模型生成 run 会进入队列；如果没有 Redis 和 worker，发送消息后不会真正被后台执行。因此本地开发推荐同时启动三个进程：Redis、PI Web、PI worker。

第一次运行前复制本地配置：

```bash
copy apps\pi-coding-web\.env.example apps\pi-coding-web\.env
```

如果本机没有 Redis，可以用 Docker 启动一个本地 Redis：

```bash
docker run --name pi-coding-redis -p 6379:6379 -d redis:7-alpine
```

终端 1：启动 PI Web。

```bash
cd apps/pi-coding-web
npm run dev
```

终端 2：构建并启动 PI worker。

```bash
npm run build:worker --workspace=pi-coding-web
npm run worker --workspace=pi-coding-web
```

默认 Vite 地址通常是：

```text
http://localhost:5173
```

如果修改了 `apps/pi-coding-web/src/worker`、`apps/pi-coding-web/src/runtime` 或 worker 依赖的 `packages/web-workspace` 代码，需要重新执行 `npm run build:worker --workspace=pi-coding-web` 并重启 worker。

如果只是临时验证静态页面、不需要后台生成能力，可以在 `.env` 中将 `PI_RUNS_ENABLED=false` 后只启动 `npm run dev`。这种模式不具备刷新页面后继续执行、会话运行状态、后台取消等能力，不建议作为当前 PI 的正常开发/部署模式。

### Docker 构建

从 `pi-mono-0.73.0` 根目录执行：

```bash
docker build -t pi-coding-web:0.73.0 -f apps/pi-coding-web/Dockerfile .
```

生成离线部署包：

```bash
docker save -o docker/pi-coding-web/pi-coding-web-0.73.0.tar pi-coding-web:0.73.0
```

离线部署文件位于 `docker/pi-coding-web`。

注意：

- Docker 离线包 `*.tar`、`*.tar.gz` 不应提交到 GitHub。
- 这些离线包可以临时放在 `docker/pi-coding-web` 下，但必须被 `.dockerignore` 排除，否则下次 `docker build` 会把旧镜像包再次发送进 build context，导致 `transferring context` 接近 2GB。
- 如果 `docker build` 显示 build context 异常变大，优先检查仓库内是否有未排除的镜像 tar、运行数据目录或生成项目依赖目录。

运行时数据目录应挂载到：

```text
/app/apps/pi-coding-web/data
```

### 后台 worker、队列和会话隔离

PI 当前的代码生成执行路径已经从“浏览器页面内直接运行 Agent”改为“Web 进程创建 run，独立 worker 从 Redis 队列消费 run”。这样刷新页面、关闭页面、切换会话后，服务端 worker 仍可继续处理已经入队或正在运行的生成任务；前端重新打开会话时通过 run events 回放模型消息和工具事件。

部署形态：

- `pi-coding-web`：负责 Web UI、PI session/run API、项目文件 API 和运行事件查询。
- `pi-worker`：独立 Node 进程，执行真实 Agent run，写入 SQLite runtime DB，并通过 Redis 队列接收任务和取消信号。
- `redis`：run 队列和取消标记，不存储会话正文；会话、消息、run、run events 存在 `PI_DB_FILE` 指向的 SQLite 文件中。

PM handoff 仍保持 URL token 方式，PM 请求不需要携带 `X-PI-Client-ID`，也不需要修改 PM API。handoff 解析完成后，PI 浏览器端会生成并持久化 `PI_CLIENT_ID`，之后 PI 自己的 session、run、project API 都会带 `X-PI-Client-ID`。这个 client id 只用于会话/任务隔离，防止同一 PI 服务上的不同浏览器互相看到或操作 run；它不是认证机制，不能替代登录、权限校验或网络访问控制。

Docker Compose 部署现在包含 Web、worker 和 Redis 三个服务。离线部署时仍使用同一个 `pi-coding-web:0.73.0` 镜像，`pi-worker` 通过 `npm run worker --workspace=pi-coding-web` 启动。生产环境至少应设置：

```env
PI_RUNS_ENABLED=true
PI_DB_FILE=./data/pi-runtime.sqlite
PI_REDIS_URL=redis://redis:6379
PI_WORKER_ID=pi-worker
PI_WORKER_CONCURRENCY=2
PI_RUN_QUEUE_NAME=pi:runs
PI_CLIENT_ID_REQUIRED=true
```

如果部署多个 worker，应给每个 worker 配置稳定且不同的 `PI_WORKER_ID`，用于重启后标记该 worker 遗留的 running/cancelling run。

## 5. 配置文件说明

产品应用使用：

```text
apps/pi-coding-web/.env
```

`.env.example` 已列出完整变量并按用途分组，包括：

- `PI_SESSIONS_DIR`、`PI_SETTINGS_FILE`、`PI_PROJECTS_ROOT_DIR`：会话、设置、生成项目目录。
- `PI_SKILLS_DIR`、`PI_DEFAULT_SKILLS_DIR`：服务端 skill 目录。
- `PI_PREVIEW_BASE_URL`：对浏览器可访问的 PI 公开地址。
- `PI_PROJECT_INSTALL_COMMAND`、`PI_PROJECT_BUILD_COMMAND`：生成项目安装和构建命令。
- `PI_SERVER_SESSION_SYNC_ENABLED`：是否启用服务端会话同步。
- `PI_RUNS_ENABLED`、`PI_DB_FILE`、`PI_REDIS_URL`、`PI_WORKER_*`、`PI_RUN_QUEUE_NAME`：后台 worker run、SQLite runtime DB 和 Redis 队列配置。
- `PI_CLIENT_ID_REQUIRED`：是否强制 PI-owned API 携带 `X-PI-Client-ID`。
- `PI_LOG_*`：诊断日志、深度调试、保留周期和 SQLite 清理策略。
- `PI_LANGFUSE_*`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`：Langfuse/OTEL 配置和密钥。
- `PI_OTEL_SERVICE_NAME`、`PI_OTEL_DEPLOYMENT_ENVIRONMENT`：OTEL 标识。

`.env` 中的相对路径基于 `apps/pi-coding-web/` 解析。真实 `.env` 已被 `.gitignore` 忽略，不应提交到 Git。配置加载优先级为：系统环境变量 > `.env` > 代码内默认值。

### PI 诊断日志系统

当前 PI 已增加后台诊断日志系统，用于排查模型连接、流式输出、thinking/text 分布、工具调用、PM handoff、skill 加载、project task、preview 和服务端存储等问题。日志不会暴露到前端界面，配置统一写入 `apps/pi-coding-web/.env`。

默认写入：

```text
apps/pi-coding-web/data/logs/pi-diagnostics.sqlite
```

常用查看命令：

```bash
cd apps/pi-coding-web
npm run logs -- --level error --limit 50
npm run logs -- --event model.stream.summary --limit 50
npm run logs -- --event provider.raw_chunk --limit 100
npm run logs -- --event model.stream.raw_event --limit 100
npm run logs -- --event provider.payload.snapshot --limit 20
npm run logs -- --session <sessionId>
```

环境变量：

- `PI_LOG_ENABLED=false`：关闭日志。
- `PI_LOG_DB=/path/to/pi-diagnostics.sqlite`：覆盖 SQLite 日志库路径。
- `PI_STORAGE_ENV_FILE=/path/to/.env`：覆盖默认 `.env` 文件路径。
- `PI_LOG_STDOUT=true`：把 warn/error 摘要输出到服务端 stdout。
- `PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true`：记录模型输出快照。
- `PI_LOG_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS=20000`：覆盖单次模型输出快照字符预算。
- `PI_LANGFUSE_ENABLED=true`：启用 Langfuse 导出。
- `PI_LANGFUSE_HOST=http://localhost:3000`：覆盖 Langfuse 地址。
- `PI_LANGFUSE_OTEL_ENDPOINT=http://otel-collector:4318/v1/traces`：覆盖最终 OTLP trace endpoint。
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`：Langfuse API key。
- `PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=true`：允许上传 prompt/payload 快照。
- `PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=true`：允许上传模型输出快照。
- `PI_LANGFUSE_EXPORT_RAW_CHUNKS=true`：允许上传 raw chunk/raw event。
- `PI_OTEL_SERVICE_NAME=pi-coding-web`：覆盖 OTEL service name。
- `PI_OTEL_DEPLOYMENT_ENVIRONMENT=production`：覆盖部署环境标识。

本地开发时推荐复制 `apps/pi-coding-web/.env.example` 为 `apps/pi-coding-web/.env`，然后在其中填写：

```env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

`apps/pi-coding-web/.env` 已被 `.gitignore` 忽略。

Docker 部署时应挂载 `apps/pi-coding-web/data`，否则默认日志库会随容器重建丢失。深度 raw/prompt/output 日志默认关闭，排查模型问题时可临时开启；raw 模式会记录 OpenAI-compatible provider 的结构化 stream chunk 和 PI 解析后的 stream event，但不是 HTTP SSE 字节级原文。长期运行依赖 `logRetentionDays`、`logMaxEvents` 和 SQLite `VACUUM` 控制磁盘增长。完整使用说明见：

```text
docs/pi-diagnostic-logging-zh.md
```

### Langfuse 观测集成

当前 PI 诊断日志已支持通过 OTLP/HTTP JSON 异步导出到 Langfuse。SQLite 本地日志仍保留为兜底排障数据；Langfuse 用于集中查看模型请求、generation 生命周期和关键异常事件。

启用时优先修改配置文件：

```env
PI_LANGFUSE_ENABLED=true
PI_LANGFUSE_HOST=http://localhost:3000
PI_LANGFUSE_OTEL_ENDPOINT=
PI_OTEL_SERVICE_NAME=pi-coding-web
PI_OTEL_DEPLOYMENT_ENVIRONMENT=development
```

`PI_LANGFUSE_OTEL_ENDPOINT` 为空时会自动使用：

```text
<langfuseHost>/api/public/otel/v1/traces
```

如果后续统一接入 OpenTelemetry Collector，可以把它改成 Collector 的 trace endpoint，例如：

```env
PI_LANGFUSE_OTEL_ENDPOINT=http://otel-collector:4318/v1/traces
```

密钥写在 `.env` 或系统环境变量中：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
```

本地默认配置已指向 `./.env`，该文件不提交到 Git；系统环境变量仍可覆盖文件中的值。

测试是否正常：

```bash
cd apps/pi-coding-web
npm run dev
# 发起一次模型对话后检查：
# GET http://127.0.0.1:5173/api/pi-logs/status
```

状态里重点看 `langfuseEnabled`、`langfuseConfigured`、`langfuseOtelEndpoint`、`otelServiceName`、`langfuseQueuedEvents`、`langfuseLastFlushAt` 和 `langfuseLastError`。默认不会上传完整 prompt/payload、模型输出快照或 raw chunk；如确需在 Langfuse 里分析 prompt 拼接、模型输出或流式协议细节，必须在 `.env` 中显式开启 `PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS`、`PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS` 或 `PI_LANGFUSE_EXPORT_RAW_CHUNKS`，并确认 Langfuse 的访问权限和数据保留策略。

要让 Langfuse generation observation 的 Input / Output 显示可读内容，需要同时开启本地采集和上传：

```env
PI_LOG_PROMPT_SNAPSHOT_ENABLED=true
PI_LOG_MODEL_OUTPUT_SNAPSHOT_ENABLED=true
PI_LANGFUSE_EXPORT_PROMPT_SNAPSHOTS=true
PI_LANGFUSE_EXPORT_MODEL_OUTPUT_SNAPSHOTS=true
```

`agent.*` observation 是 PI 生命周期事件，不是模型请求；这些事件没有 LLM input/output，Langfuse 显示 `null` 或 `undefined` 属于正常表现。模型输入输出应查看带 generation 图标的 `model.stream.summary`、`provider.response` 或 `provider.request.error` observation。

导出路径：

```text
PI diagnostic event -> OTEL resourceSpans/scopeSpans/spans -> Langfuse /api/public/otel/v1/traces
```

每个 PI trace 会生成一个 root span；模型 summary、provider response 和 provider error 会生成 `langfuse.observation.type=generation` 的 span；普通诊断事件会生成 `langfuse.observation.type=event` 的 span。这样后续 PM、PI、模型网关和 worker 都可以用 `service.name`、trace id 和 OTEL 属性做全链路观测。

全局 skill 使用目录形式：

```text
data/skills/<skill-name>/SKILL.md
```

`SKILL.md` 需要包含 `name` 和 `description` frontmatter。Agent 会在系统提示词里看到 skill 名称和描述，任务匹配时通过 `skill_load` 加载完整说明；用户也可以在聊天框输入 `/skill` 打开全局 skill 下拉列表，选择后会插入 `/skill:<name>` 并在发送前展开该 skill 的 `SKILL.md`。如果说明中引用 `references/*.md` 等相对资源，再通过 `skill_resource` 读取。

兼容范围：

- Anthropic/Agent Skills 风格的 `references/`、`assets/`、`scripts/` 等目录会作为只读文本资源处理，前提是文件扩展名在允许列表中。
- OpenAI/Codex 风格的 `agents/openai.yaml` 会被识别为界面元数据：`display_name`、`short_description` 用于 `/skill` 展示，`default_prompt` 进入系统提示词元数据，图标字段和 `brand_color` 会被解析并透传，便于后续 UI 使用。
- `agents/openai.yaml` 不会作为普通 agent 参考资源列出，避免模型浪费上下文读取产品配置。
- PI 不会执行 skill 脚本，也不会因为 skill 暴露通用 shell 或任意文件读取能力。

注意：

- `project_task preview` 不会运行 `npm install`、`npm run build`、`npm run dev` 或 Node 服务。
- 构建型静态前端必须先通过 `project_task build_static` 生成 `dist/` 或 `build/` 等浏览器可直接运行的静态产物。
- 如果项目根目录的 `index.html` 仍引用 `src/main.tsx`、`src/main.jsx` 等构建源码，`preview` 会返回错误和日志，不应返回一个看似可点击但实际空白的 URL。
- 当前实现没有沙箱隔离；`build_static` 的风险由固定命令、超时和部分危险命令检查降低，但仍不等同于生产级安全隔离。

### 模型与服务商配置

模型配置涉及三类数据，不应混为一谈：

- `customProviders`：自定义服务商定义，包含服务商名称、类型、base URL、可选 API key、模型列表，以及本地 OpenAI-compatible 服务商的兼容开关。
- `selectedModel`：最近选择的模型对象，只表示“上次选中了哪个模型”，不等同于完整服务商配置。
- `providerKeys`：按 provider 名称保存的 API key。

如果 `settings.json` 里只有 `selectedModel`，但 `customProviders` 是空数组或不存在，设置页不会显示自定义服务商。这不是 UI 没读到文件，而是服务商列表本身缺失。

当前同步策略：

- 新增或修改服务商时，优先写入服务端 `settings.json`，同时镜像到浏览器 IndexedDB。
- 读取服务商时，如果服务端存在非空 `customProviders`，以服务端为准并同步到本地。
- 如果服务端 `customProviders` 是空数组，但浏览器本地仍有服务商，会把本地服务商写回服务端，避免旧版本中“空数组反向清空本地配置”的问题。
- 如果服务端和浏览器本地都已经没有服务商定义，则无法只靠 `selectedModel` 自动恢复完整配置，需要重新添加服务商。

### 模型工具调用兼容

当前自定义服务商主要分为：

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `vllm`、`lmstudio`、`ollama`、`llama.cpp` 等本地 OpenAI-compatible 自动发现服务商

其中 `vllm`、`lmstudio` 等本地模型部署工具通常通过 OpenAI Chat Completions 兼容接口接入，因此在内部会走 `openai-completions` 兼容路径。

非流式工具调用兼容模式是手动开关，主要用于小模型或部分 vLLM 服务端在流式 tool call 参数输出不稳定时降级使用。它不是 vLLM 默认值，后续如果内网升级到更强模型，可以保持关闭以继续获得流式输出。

已知经验：

- `qwen3.5-27b` 在当前内网测试中可以正常创建文件。
- `qwen3.6-27b` 在旧版本和新版本 PI 中都出现工具调用不稳定，倾向于模型或 vLLM tool calling 兼容问题，不建议为此回退 PI 代码。
- 对小模型，应优先使用明确的工具 schema、参数别名兼容、缺参修复提示和必要时的非流式工具调用模式。

### Agent 上下文压缩

`compactProjectToolHistory` 只在发送给模型前处理上下文，不会修改磁盘 session 原文，也不会影响 UI 历史展示。

实现方式是纯代码规则，不调用当前配置的模型做总结：

- 默认只保留最近 1 次完整 `project_file` 工具调用内容。
- 更早的 `project_file.arguments.content` 如果超过默认长度，会替换为 `[project_file content omitted: <chars> chars, <lines> lines from <filename>]`。
- 这样可以避免多文件生成后，旧的大文件内容长期污染模型上下文。
- 代价是模型看不到很早之前写入文件的完整内容；因此系统提示词要求模型在需要修改旧文件时先调用 `project_file get`。

该机制是上下文裁剪，不是智能代码摘要。后续如果要进一步提升小模型稳定性，可以考虑把压缩占位符变得更强约束，或者在编辑已有文件前由工具层强制读取当前文件。

## 6. PI 扩展资源知识库

本仓库还包含一套本地 PI 扩展资源知识库：

```text
.packages/pi_extension_knowledge_base
```

该目录来自 `https://pi.dev/packages` 的目录元数据抓取结果，用于辅助 PI 二次开发时筛选值得研究的扩展包。它不是运行时资产，也不是源码审计结论；只能用于候选包选型和调研入口。

关键文件：

- `README.md`：知识库文件说明和推荐使用流程。
- `taxonomy.md`：20 个能力分类的定义、中文标签和关键词口径。
- `category_summaries.json`：每个分类的统计、关键词和推荐研究包。
- `packages_ai.jsonl`：一行一个包的主明细，适合按二次开发目标筛选候选包。
- `rag_chunks.jsonl`：面向检索/RAG 的分块数据。
- `categories/*.md`：按分类生成的 Markdown 导览。
- `study_candidates.md`：按二次开发主题整理的优先研究清单。

后续如果提出新的 PI 二次开发目标，应先按以下顺序使用这套资料：

1. 先阅读 `README.md`、`taxonomy.md`、`category_summaries.json`，把目标映射到一个或多个能力分类。
2. 再从 `packages_ai.jsonl`、`rag_chunks.jsonl` 或对应 `categories/*.md` 中筛选候选包。
3. 候选包优先选择 `repo_available=true`、`reference_score` 较高、描述与目标能力明确相关的包。
4. 目录元数据只能回答“哪些包值得进一步看”；源码级实现、API 形态、安全边界和可借鉴方案必须再查看 npm 包或 GitHub repo。
5. 如果候选包能力涉及安全、权限、文件系统、命令执行、浏览器自动化、外部账号或网络访问，必须把源码验证作为正式设计前置步骤。

当前知识库覆盖 3,523 条 pi.dev 目录记录，分类包括：

- `theme_prompt_skill`：Theme、Prompt 与 Skill 资产。
- `model_provider_runtime`：模型、Provider 与运行时。
- `browser_web_access`：浏览器、搜索与网页访问。
- `memory_context_knowledge`：上下文、记忆与知识检索。
- `agent_orchestration`：Agent 编排与多代理。
- `ui_human_interaction`：人机交互、确认与 UI。
- `security_guardrails`：安全、权限与 Guardrails。
- `mcp_integration`：MCP 与外部工具接入。
- `code_repo_git`、`code_intelligence_quality`、`planning_tdd_spec` 等工程辅助分类。

这套知识库的主要价值是减少 PI 扩展设计前的盲目搜索。它不应直接驱动产品代码，也不应替代对上游 PI 包边界、当前 `apps/pi-coding-web` 产品化约束和 `packages/web-workspace` 服务端安全边界的判断。

## 7. PM Handoff 流程

PM 平台可以通过以下 URL 打开 PI：

```text
/?handoff_token=<token>&pm_api_base_url=<pm-backend-base-url>
```

PI 会执行以下流程：

1. 使用 `handoff_token` 调用 PM 后端。
2. 读取 PM 返回的实现提示词和文档列表。
3. 下载 PRD、设计文档等附件。
4. 将 PM 实现提示词和 PI 平台执行说明合并后填入聊天输入框。
5. 用户发送后，如果任务匹配全局 skill，Agent 先通过 `skill_load` 加载说明，并按需用 `skill_resource` 读取 skill 内引用资源。
6. Agent 使用 project 工具在服务端 workspace 生成项目。
7. 如果是构建型静态前端，Agent 先调用 `project_task build_static`。
8. Agent 调用 `project_task validate` 检查静态预览条件。
9. 修复验证发现的问题后，Agent 调用 `project_task preview` 返回预览地址。

PM 文档是需求主依据；PI 自身提示词只补充执行方式，不应扩大或改写 PM 的产品范围。

当前 PI 只要求交付静态应用：

- 优先生成纯静态 HTML/CSS/JavaScript 应用。
- 也支持 Vite、React、Vue 等构建型静态前端，但最终必须通过 `build_static` 产出静态目录。
- PM 文档中出现的后端服务、数据库、认证、队列、第三方 API、部署拓扑等内容，应作为目标系统背景，在静态前端中用示例数据、本地状态、mock 响应和清晰 UI 状态模拟。
- 不支持由 Agent 生成并运行真实后端服务、数据库、Docker、多进程服务或长驻开发服务器。

## 8. 后续建议

### 运行安全隔离

当前已经不再向 Agent 暴露可执行任意命令的 `project_bash`。Agent 只能通过 `project_task` 触发固定任务，其中 `build_static` 会运行服务端配置的安装/构建命令。这个方案比开放 bash 风险更低，但仍不是完整安全边界。

后续生产化需要重点补齐：

- 构建任务沙箱隔离。
- 依赖安装和构建命令的策略限制。
- 单项目 CPU、内存、磁盘限制。
- 网络访问限制。
- 超时与日志截断策略。
- 每个用户或每个项目的隔离目录。
- 运行产物清理和可审计日志。

### 多用户与任务队列

当前实现更接近单实例或轻量多会话模式。后续如果支持多人同时生成项目，建议增加：

- workspace lease 或 lock。
- 构建任务队列。
- preview 生命周期管理。
- 项目清理策略。
- 用户、PM session 与 PI session 的映射表。

### 服务端能力独立化

`packages/web-workspace` 目前以 Vite middleware 方式接入。后续可以继续演进为：

- 独立 Node 服务。
- PM 后端直接调用的 workspace 服务。
- Docker sandbox runner。
- 支持多构建 worker 的任务管理器。

### 上游同步策略

为了降低后续同步上游 PI-mono 的冲突：

- 尽量不把产品逻辑放回 `packages/web-ui`。
- 上游 UI 组件能力的增强应保持通用。
- PM、handoff、server workspace、Docker 部署等本地产品逻辑优先放在 `apps/pi-coding-web` 或 `packages/web-workspace`。
- 修改上游核心包时，应单独记录原因和影响范围。

## 9. 当前验证状态

当前整理完成后，以下检查已经通过：

```bash
npm test
# 在 packages/web-workspace 下执行

npm run check --workspace=@mariozechner/pi-web-workspace
npm run check --workspace=@mariozechner/pi-web-ui
npm run check --workspace=pi-coding-web
```

根级：

```bash
npm run check
```

当前会被 `packages/ai/test/*` 中既有的 `claude-sonnet-4` 类型不匹配问题阻断。该问题不属于本次目录整理引入。

`check:browser-smoke` 在当前沙箱环境中由于 esbuild spawn 被拒绝而无法完成，需要在允许子进程执行的本地环境中复跑。

## 10. 维护原则

- 原 `README.md` 尽量保持上游 PI-mono 项目说明，不承载大量本地产品说明。
- 本地改造说明优先更新本文档。
- 目录结构调整应先保持行为不变，再逐步增强功能。
- 产品应用代码放 `apps/pi-coding-web`。
- 可复用服务端 workspace 能力放 `packages/web-workspace`。
- 通用浏览器 UI 能力才放 `packages/web-ui`。
