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
- 注册 `project_file`、`project_task` 工具。
- 提供 Dockerfile、Vite 配置和产品应用 README。

关键子目录：

- `src/app/`：应用启动、模型选择、会话标题等应用层逻辑。
- `src/integrations/`：外部系统接入，目前主要是 PM handoff。
- `src/prompts/`：PI 编码应用系统提示词和平台执行说明。
- `src/project-tools/`：浏览器端 project 工具 schema、API client、AgentTool 创建和工具卡渲染。
- `src/storage/`：浏览器端调用服务端 storage API 的封装。

### `packages/web-workspace`

这是新增的内部支撑包，用于承载原 `storage-server.ts` 中的服务端能力。

主要职责：

- 读取 `pi-storage.config.json`。
- 解析 session、settings、projects 等数据目录。
- 提供会话 JSON 存储。
- 提供服务端 project 文件操作。
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
- `configuredStoragePlugin`

说明：

- 当前 Agent 对外只暴露 `project_file` 和 `project_task`。
- `WorkspaceCommandService` 仍保留在包内，主要用于历史兼容和内部构建执行支撑，不应理解为 AI 可以直接运行任意 shell 命令。
- `WorkspacePreviewService` 当前只负责静态预览，不启动 Node HTTP 服务。
- Agent 工具到服务端 API 的主要映射是：
  - `project_file` -> `POST /api/pi-projects/workspace/file`
  - `project_task` -> `POST /api/pi-projects/workspace/task`
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
- `project_task` 只支持受控任务：`inspect`、`validate`、`build_static`、`preview`、`logs`。
- `project_task` 不接收原始 shell 命令；只有 `build_static` 会运行服务端配置的安装/构建命令。
- preview 改为静态预览模式，只服务 `index.html` 或 `dist/`、`build/`、`public/` 等静态产物，不再启动 Node 服务。
- Vite watcher 已忽略 sessions、projects、settings 等运行数据路径，避免 Agent 写文件时触发 Web 应用刷新。
- Agent 初始化时直接注入模型 API key 读取函数，避免页面刷新后恢复会话时出现 `No API key for provider`。
- Dockerfile 和 compose 挂载路径改为 `apps/pi-coding-web/data`。
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
- `previewBaseUrl`：对浏览器可访问的 PI 公开地址。
- `projectInstallCommand`：`project_task build_static` 执行时使用的安装命令，默认 `npm install`。
- `projectBuildCommand`：`project_task build_static` 执行时使用的构建命令，默认 `npm run build`。
- `projectInstallTimeoutMs`：安装超时时间。
- `projectBuildTimeoutMs`：构建超时时间。

相对路径基于 `apps/pi-coding-web/` 解析。

注意：

- `project_task preview` 不会运行 `npm install`、`npm run build`、`npm run dev` 或 Node 服务。
- 构建型静态前端必须先通过 `project_task build_static` 生成 `dist/` 或 `build/` 等浏览器可直接运行的静态产物。
- 如果项目根目录的 `index.html` 仍引用 `src/main.tsx`、`src/main.jsx` 等构建源码，`preview` 会返回错误和日志，不应返回一个看似可点击但实际空白的 URL。
- 当前实现没有沙箱隔离；`build_static` 的风险由固定命令、超时和部分危险命令检查降低，但仍不等同于生产级安全隔离。

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
5. 用户发送后，Agent 使用 project 工具在服务端 workspace 生成项目。
6. 如果是构建型静态前端，Agent 先调用 `project_task build_static`。
7. Agent 调用 `project_task validate` 检查静态预览条件。
8. 修复验证发现的问题后，Agent 调用 `project_task preview` 返回预览地址。

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
