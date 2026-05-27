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

- 读取 `pi-storage.config.json`。
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

```bash
cd apps/pi-coding-web
npm run dev
```

默认 Vite 地址通常是：

```text
http://localhost:5173
```

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

## 5. 配置文件说明

产品应用使用：

```text
apps/pi-coding-web/pi-storage.config.json
```

主要字段：

- `sessionsDir`：会话 JSON 存储目录。
- `settingsFile`：服务端镜像设置文件。
- `projectsRootDir`：生成项目根目录。
- `skillsDir`：服务端全局 skill 目录，默认 `./data/skills`。
- `previewBaseUrl`：对浏览器可访问的 PI 公开地址。
- `projectInstallCommand`：`project_task build_static` 执行时使用的安装命令，默认 `npm install`。
- `projectBuildCommand`：`project_task build_static` 执行时使用的构建命令，默认 `npm run build`。
- `projectInstallTimeoutMs`：安装超时时间。
- `projectBuildTimeoutMs`：构建超时时间。

相对路径基于 `apps/pi-coding-web/` 解析。

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

## 6. PM Handoff 流程

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

## 7. 后续建议

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

## 8. 当前验证状态

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

## 9. 维护原则

- 原 `README.md` 尽量保持上游 PI-mono 项目说明，不承载大量本地产品说明。
- 本地改造说明优先更新本文档。
- 目录结构调整应先保持行为不变，再逐步增强功能。
- 产品应用代码放 `apps/pi-coding-web`。
- 可复用服务端 workspace 能力放 `packages/web-workspace`。
- 通用浏览器 UI 能力才放 `packages/web-ui`。
