# App Preview Goal 设计

## 背景

当前 Pi Coding Web 的核心流程是 PM -> PI：PM 侧交付产品需求与附件，PI 侧生成一个可预览的静态 App。这个场景的完成边界比通用目标模式更清晰：最终是否生成一个通过最低质量检查的 `previewUrl`。

因此第一版不做通用 Codex Goal Mode，而是做特化的 App Preview Goal。系统负责判断预览是否真的可用，模型只负责继续开发、修复项目、调用现有项目工具生成预览。

## 目标

- PM -> PI 流程默认开启 App Preview Goal。
- 普通聊天默认不开启，用户可从输入框扩展按钮手动开启或关闭。
- 自动继续直到生成合格预览，或进入明确停止状态。
- 自动重试只处理环境、网络、provider 短暂失败，最多 5 次。
- 预览完成判定使用 metadata + 静态产物 + HTTP 最低质量检查。
- 代码结构清晰，便于后续调试、扩展、更换策略。
- 前端新增文案必须走现有 i18n，不硬编码展示文本。

## 非目标

- 不做通用多目标管理。
- 不把 CLI extension runtime 引入 Web worker。
- 不直接依赖外部 goal/retry 扩展包。
- 第一版不强依赖 Playwright 或浏览器截图级 smoke check。
- 第一版不让模型自述成为完成依据。

## 参考包结论

源码审计后，外部包主要提供设计参考，不适合作为 Web runtime dependency：

- `pi-codex-goal`：参考 continuation scheduler、recovery machine、stale queued work guard、goal tools 边界。
- `pi-goal-x`：参考 lifecycle gates、completion audit、empty-turn guard、目标生命周期可见性。
- `pi-until-done`：参考 turn budget、spin guard、evidence-based completion。
- `@narumitw/pi-retry`：参考 retry ergonomics，但 Web 端重写 retry policy。

这些包大多依赖 Pi CLI extension API、session custom entries、TUI/widget/hook 能力。Web 侧应基于 `packages/web-workspace` 的 SQLite、Redis run queue、worker service 重新实现。

## 架构

新增能力集中在 `packages/web-workspace`：

- `AppPreviewGoalService`
  - 创建、开启、关闭、读取 goal。
  - 负责 session 级 goal 状态持久化。

- `AppPreviewGoalSupervisor`
  - 在 run 结束后执行目标判定。
  - 根据 preview readiness、预算、run 状态决定停止或创建 continuation run。

- `PreviewReadinessChecker`
  - 检查当前 session/project 是否已有合格 `previewUrl`。
  - 不依赖模型输出。
  - worker 侧没有浏览器请求上下文时，应优先使用 metadata 中的 `previewUrl`；若该 URL 不适合从 worker 访问，则基于 `StorageConfig` 的本地服务地址和 `projectId` 构造内部预览 URL，再执行 HTTP 检查。

- `RetryPolicy`
  - 判断 provider/network 错误是否可重试。
  - 计算指数退避和 jitter。
  - 限制最多 5 次。

- `RunRetryController`
  - 包裹 worker 内的 agent 执行。
  - 只处理同一个 run 内的 retry，不做 goal continuation。

- `GoalEventLog`
  - 记录 goal 和 retry 决策。
  - 用于前端状态、诊断日志和后续排错。

前端集成：

- `apps/pi-coding-web` 负责 PM -> PI 默认启用、普通会话手动开关、状态拉取与展示。
- `packages/web-ui` 只提供输入框扩展按钮承载点，不包含业务判断。

## 状态模型

App Preview Goal 状态：

- `off`：未开启或无 goal。
- `active`：目标运行中。
- `preview_ready`：预览通过最低质量检查。
- `disabled`：用户关闭自动继续。
- `blocked`：系统判断继续已无有效进展，需要用户介入。
- `failed`：不可恢复错误。
- `cancelled`：用户取消。
- `budget_limited`：自动继续预算耗尽。

推荐数据库表：

### `app_preview_goals`

- `goal_id`
- `client_id`
- `session_id`
- `source`: `pm_handoff | manual`
- `status`
- `max_continuation_runs`
- `continuation_runs_used`
- `retry_attempts_used`
- `last_run_id`
- `last_preview_url`
- `last_failure_reason`
- `created_at`
- `updated_at`
- `completed_at`

### `app_preview_goal_events`

- `id`
- `goal_id`
- `client_id`
- `session_id`
- `run_id`
- `event_type`
- `reason_code`
- `payload_json`
- `created_at`

典型事件：

- `goal_started`
- `goal_disabled`
- `retry_scheduled`
- `retry_exhausted`
- `continuation_scheduled`
- `preview_check_failed`
- `preview_ready`
- `budget_limited`
- `blocked`
- `queue_unavailable`

## 自动继续策略

预算：

- PM -> PI 默认 `8` 轮。
- 手动开启默认 `5` 轮。

规则：

1. run 结束后，supervisor 检查当前 goal 是否为 `active`。
2. 若存在 active run 或 queued run，不创建新的 continuation。
3. 调用 `PreviewReadinessChecker`。
4. 若预览合格，goal -> `preview_ready`，记录 `lastPreviewUrl`。
5. 若预览不合格且预算未耗尽，写入 goal event，创建 continuation run。
6. continuation run 的模型提示应短而明确：继续修复当前项目，目标是生成通过最低质量检查的预览 URL。
7. 若预算耗尽，goal -> `budget_limited`。
8. 用户关闭后，goal -> `disabled`，不取消当前正在运行的 run，但不再创建后续 continuation。

## 自动重试策略

自动重试层不参与任务完成判断，只处理临时环境或 provider 问题。

可重试：

- 网络断开、连接重置、timeout。
- 429、rate limit。
- 500、502、503、504。
- service unavailable、overloaded。
- stream 中断、fetch failed、socket hang up。

不可重试：

- 用户取消。
- 权限、配置、认证错误。
- prompt 或参数非法。
- context overflow。
- preview 质量检查失败。

策略：

- 最多 `5` 次。
- 指数退避 + jitter。
- 每次 retry 写入 run event 和 diagnostic log。
- retry 成功后继续同一个 run。
- retry 耗尽后 run 标记 `failed`，再由 goal supervisor 判断是否需要 continuation。
- 最终错误必须保留给前端和日志。

## 预览最低质量检查

采用方案 B：metadata + 静态产物 + HTTP 检查。

检查项：

- project metadata 存在。
- metadata `status === "running"`。
- `previewUrl` 非空。
- `serveRoot` 存在。
- `index.html` 存在。
- `index.html` 非空。
- HTTP GET `previewUrl` 返回 2xx。
- HTML 不包含明显错误页文本。
- HTML 至少满足一个基本页面信号：
  - 有 `<title>`；
  - 有 `<body>`；
  - 有入口脚本；
  - 有可见文本。

结构化失败原因：

- `missing_project_metadata`
- `preview_url_missing`
- `serve_root_missing`
- `index_html_missing`
- `index_html_empty`
- `http_not_ok`
- `html_error_page`
- `html_no_basic_content`

第一版不做浏览器级 smoke check。后续可以增加 Playwright 检查 body 尺寸、控制台错误和截图非空。

HTTP 检查地址来源：

- 优先使用 project metadata 的 `previewUrl`。
- 如果 metadata URL 缺失 host、host 不可达，或是只能给浏览器访问的外部地址，checker 可以用当前 server 配置构造内部 URL。
- 文件系统检查和 HTTP 检查都应返回结构化 `reasonCode`，不能只返回布尔值。

## API 设计

新增 goal API，建议挂在 runtime/run API 旁边：

- `GET /api/pi-runs/goals/app-preview?sessionId=...`
  - 读取当前 session 的 App Preview Goal 状态。

- `POST /api/pi-runs/goals/app-preview`
  - 开启或更新当前 session 的 goal。
  - 请求体包含 `sessionId`、`source: "pm_handoff" | "manual"`、`enabled`。

- `POST /api/pi-runs/goals/app-preview/disable`
  - 关闭当前 session 的自动继续。

- `POST /api/pi-runs/goals/app-preview/reset`
  - 可后续开放，用于重新开始预算。第一版可不暴露 UI。

`StartRunRequest` 增加可选字段：

```ts
appPreviewGoal?: {
  enabled: boolean;
  source: "pm_handoff" | "manual";
}
```

服务端决定预算，不信任前端传入预算。

## PM -> PI 流程

PM handoff 创建远端 run 时默认传：

```ts
appPreviewGoal: {
  enabled: true,
  source: "pm_handoff",
}
```

服务端创建或恢复 `active` goal，预算为 `8`。

## 手动开启流程

普通会话默认不开 goal。用户从输入框扩展按钮开启后：

- 前端调用 goal API 开启当前 session 的 goal。
- 后续 run 携带 `source: "manual"`。
- 服务端预算为 `5`。
- 用户关闭时只停止后续自动 continuation，不取消当前 run。

## UI 与多语言

新增 UI 文案全部走现有 `i18n`：

- 输入框扩展按钮标签。
- tooltip。
- goal 状态展示。
- run event 展示。
- 错误提示。
- 预算耗尽提示。

后端事件存稳定 code，例如 `eventType`、`reasonCode`、`status`。前端根据 code 映射本地化文案，避免后端写死展示语言。

i18n 要求：

- 前端新增展示文案必须使用稳定 i18n key。
- 后端 payload 只传状态码、原因码、数字预算、URL 等数据。
- run event renderer 负责把 code 映射为当前语言文案。

按钮状态：

- `off`：可开启。
- `active`：可关闭。
- `preview_ready`：展示预览已就绪和链接。
- `budget_limited`：提示达到预算，可手动继续或重新开启。
- `blocked` / `failed`：提示需要用户介入。

建议用户可见名称使用“自动生成预览”或“预览目标”，不直接暴露“目标模式”。

## 错误处理

- 当前有 active run：不创建新 continuation。
- Redis/queue 不可用：goal event 记录 `queue_unavailable`。
- session 删除：goal 查询返回空，后续可做级联清理。
- 用户取消 run：goal 进入 `cancelled` 或 `disabled`，不自动恢复。
- preview 检查失败：不算 retry，只算 goal continuation。
- retry 耗尽：记录 retry failure，run failed，然后交给 supervisor。
- continuation 创建失败：记录 event，不吞掉错误。

## 测试策略

### `PreviewReadinessChecker`

- metadata 缺失。
- previewUrl 缺失。
- serveRoot 缺失。
- index.html 缺失。
- index.html 空。
- HTTP 非 2xx。
- error page。
- HTML 有最低可用内容。

### `RetryPolicy`

- 429/5xx/timeout 可重试。
- context overflow 不重试。
- 用户取消不重试。
- 最多 5 次。
- delay 计算可控且可测。

### `AppPreviewGoalSupervisor`

- PM -> PI 默认 8。
- manual 默认 5。
- preview ready 后停止。
- preview not ready 时创建 continuation。
- active run 存在时不重复 enqueue。
- budget exhausted 进入 `budget_limited`。
- disabled 后不继续。

### API/UI

- 开启和关闭 goal。
- PM handoff startRun 自动带 goal。
- 普通会话默认不开。
- 新增前端文案走 i18n key。

## 后续增强

- Playwright 浏览器级 smoke check。
- 页面截图非空检测。
- console error 收集。
- 独立 judge model 审计产品需求覆盖度。
- goal 预算可配置。
- 按失败原因生成更精确的 continuation prompt。
- 目标事件可视化时间线。
