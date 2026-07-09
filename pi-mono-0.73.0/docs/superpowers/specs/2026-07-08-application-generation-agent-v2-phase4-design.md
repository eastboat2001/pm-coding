# Application Generation Agent v2 Phase 4 Design

## 目标

Phase 4 建立 Application Generation Agent v2 的工具治理、验证 gate、repair action 模型和 task execution facade。它的目标不是把旧 application generation agent 包一层继续使用，而是让 v2 task graph 能通过一组受控、可诊断、可测试的 v2 adapter 执行和验证。

Phase 4 仍不接管生产 worker 主路径。worker cutover 放到 Phase 5。Phase 4 必须产出可以被 Phase 5 worker adapter 调用的 v2-native execution boundary。

## Reset Procedure

1. Stop v2 workers.
2. Run the Agent v2 reset maintenance operation with confirmation token application-generation-agent-v2.
3. Start v2 workers.
4. Verify /api/agent-v2/runs/start and event replay.

Rollback: redeploy the previous code version and restore from backup if required.

## 关键结论

当前旧 worker 入口 `apps/pi-coding-web/src/worker/main.ts:createRunAgent` 仍然构造旧 `Agent`，并调用旧 capability planner、旧 spec artifact、旧 context orchestrator 和旧 prompt/tool flow。Phase 4 不在这个入口上继续补丁。

现有 `WorkspaceRunWorkerService` 可以保留为 worker 生命周期基础设施，因为它只依赖 `WorkerAgent` 契约，负责 queue claim、cancel、heartbeat、event persistence 和 run guard，不包含应用生成语义。

Phase 3 的 `agent-v2-runtime-core.ts` 已经提供 v2 runtime snapshot 和 task transition。Phase 4 在此之上新增 execution/gate/repair primitives，而不是读取旧 sessions/messages/runs/app preview goal 作为 v2 状态。

## 非兼容约束

- 不兼容旧 agent 内部模块接口、旧 prompt 流程、旧 spec/plan/tasks 文件生成逻辑。
- 不复用旧 preview goal continuation repair 逻辑。
- 不迁移旧 run/session/message/app preview goal/diagnostic 测试数据。
- 正式产品路径不存在运行时版本开关；Application Generation Agent v2 是唯一支持的运行时目标。
- v2 correctness、diagnosability、task state machine、validation/repair loop 优先于旧路径兼容。
- 旧模块如果不适合作为 infra adapter，Phase 4 应重构或新增 v2 adapter，而不是迁就复用。

## 旧模块复用评审门槛

任何候选旧模块进入 Phase 4 前必须通过 adapter review。评审结果写入测试或模块注释，不允许默认复用。

一个旧模块只有同时满足以下条件才可直接复用：

1. 职责是基础设施或低层 IO，不包含旧 agent 的 planning/prompt/context/repair 决策。
2. 输入输出可被 v2 schema 明确包裹，并能映射到 v2 task、artifact、validation、diagnostic。
3. 失败类型可结构化分类，不能只返回自由文本。
4. 不读取旧 sessions/messages/runs/app preview goal 作为 v2 agent state。
5. 不隐式启动旧 continuation、旧 preview goal repair、旧 skill 自动选择。
6. 可以通过单元或集成测试证明 v2 调用路径下行为稳定。

若不满足以上条件，处理顺序为：

1. 提取合理的 infra primitive。
2. 新增 v2 adapter。
3. 必要时重构原模块，使旧 agent 语义留在旧路径，基础设施能力独立。
4. 如果重构成本高于收益，直接新增 v2 实现。

## 候选模块评审

### 可保留为基础设施

`WorkspaceRunWorkerService`

- 评审结果：可保留。
- 理由：它只管理队列、取消、heartbeat、run guard、event persistence；应用生成行为由 `createAgent(input): WorkerAgent` 注入。
- Phase 4 动作：不修改主逻辑，仅在测试中继续把它视为 Phase 5 worker adapter 的 infra boundary。

`RunEventSink` / SSE replay

- 评审结果：可保留。
- 理由：持久化和回放 run event，不解释旧 agent 语义。
- Phase 4 动作：v2 execution events 必须通过 `agent_v2.*` event type 写入，不能伪装成旧 assistant/tool message events。

`WorkspaceDiagnosticLogService` / Langfuse export

- 评审结果：可保留但需 v2 taxonomy wrapper。
- 理由：日志 sink 本身合理，但旧 eventType 分类不足以表达 v2 task/gate/repair。
- Phase 4 动作：新增 v2 diagnostic helper，统一写 `agent_v2.tool.*`、`agent_v2.validation.*`、`agent_v2.repair.*`。

`PostgreSQL/SQLite RuntimeStore` v2 methods

- 评审结果：可保留。
- 理由：Phase 1-3 已新增独立 v2 tables 和 `createAgentV2Run`、`updateAgentV2Run`、task/artifact/document/diagnostic methods。
- Phase 4 动作：只使用 v2 methods。新增 validation persistence 如缺失必须同步补 SQLite/PostgreSQL。

### 可复用但必须包裹

`WorkspaceFileService`

- 评审结果：可作为文件 IO adapter，但不能直接暴露旧 `project_file` tool contract 给 v2 executor。
- 理由：路径安全、大小限制、create/rewrite/update/list 基础能力有价值；但旧 tool contract 过宽，输出不是 v2 artifact-aware。
- Phase 4 动作：新增 `agent-v2-file-adapter.ts`，提供 `readFile`、`writeFile`、`patchFile`、`listFiles`，每次写入生成 artifact record 和 diagnostic。

`WorkspaceTaskService`

- 评审结果：只可复用 static build/validate/preview primitives，不复用旧 `project_task` tool contract。
- 理由：`build_static`、`validate`、`preview` 已包含 static preview quality/smoke gates；但旧工具是面向模型的自由任务工具，输出文本化。
- Phase 4 动作：新增 `agent-v2-validation-gate.ts` 包裹 build/validate/preview，将结果映射为 structured validation result、task transition、repair action。

`static-preview-quality-gate.ts` 和 `static-preview-smoke-gate.ts`

- 评审结果：可保留但需加强结果 taxonomy。
- 理由：它们已经能检测 loading、placeholder、外部资源、本地脚本运行错误等静态质量问题。
- Phase 4 动作：v2 validation gate 统一转换为 validation failure code，例如 `static.loading_visible`、`static.metric_placeholder`、`static.script_error`、`static.preview_missing_entry`。

### 禁止复用为 v2 依赖

`apps/pi-coding-web/src/runtime/capability-planner.ts`

- 原因：旧 capability planner 属于旧 prompt/runtime 决策层，不是 v2 capability router。

`apps/pi-coding-web/src/runtime/spec-artifact.ts`

- 原因：旧 spec artifact 文件流程不是 v2 task state source of truth。

`apps/pi-coding-web/src/runtime/context-orchestrator.ts`

- 原因：旧 context packing 基于旧消息流和旧 prompt 语义，不能作为 v2 context model。

旧 app preview goal continuation repair

- 原因：旧 repair 闭环以 continuation run 为核心，不能把 validation failure 结构化回写到 v2 task graph。

## Phase 4 范围

### 包含

1. v2 tool registry 和 tool governance 类型。
2. v2 file adapter，负责受控文件 IO 和 artifact indexing。
3. v2 validation gate，负责 build_static、static validate、preview readiness、quality/smoke gate 的结构化结果。
4. v2 repair action model，负责把 validation failure 转成 task-scoped repair action。
5. v2 execution core facade，负责执行一个 active task，并通过 Phase 3 runtime core 更新 task state。
6. import-boundary tests，禁止 Phase 4 新模块引用旧 agent internals。
7. adapter review tests，证明复用模块只通过 v2 adapter 被调用。

### 不包含

1. 不替换 `createRunAgent`。
2. 不改前端 run UI 状态模型。
3. 不实现完整 LLM code generation worker。
4. 不做 Redis/workspace 运维级 reset 命令。
5. 不删除旧 agent 代码。

这些留给 Phase 5/6。Phase 4 的结果必须让 Phase 5 能直接接入，而不需要回到旧 agent 上打补丁。

## 新增模块

### `packages/web-workspace/src/agent-v2-tool-governance.ts`

职责：

- 定义 v2 tool name、phase allowlist、input/output schema contract、failure taxonomy。
- 提供 `createAgentV2ToolRegistry` 和 `resolveAgentV2Tool`.
- 阻止 task 在错误 phase 调用工具。

核心类型：

```ts
export type AgentV2ToolName =
	| "file.list"
	| "file.read"
	| "file.write"
	| "file.patch"
	| "validation.static_build"
	| "validation.static_quality"
	| "validation.static_smoke"
	| "preview.publish";

export interface AgentV2ToolContract {
	name: AgentV2ToolName;
	allowedPhases: AgentV2Phase[];
	inputSchemaId: string;
	outputSchemaId: string;
	sideEffects: "none" | "workspace_files" | "validation_records" | "preview_metadata";
}
```

### `packages/web-workspace/src/agent-v2-file-adapter.ts`

职责：

- 包裹 `WorkspaceFileService` 的合理 IO 能力。
- 不暴露旧 `project_file` command union。
- 每次写入返回 artifact candidate：path、checksum、mediaType、sourceTaskId。
- 失败映射为 `AgentV2ToolFailure`。

### `packages/web-workspace/src/agent-v2-validation-gate.ts`

职责：

- 包裹 static build/validate/preview primitives。
- 生成 `AgentV2ValidationResult`。
- 失败结果关联 taskId、artifactId、file path、failure code、repairable。
- gate 失败不写聊天历史，必须写 v2 validation、diagnostic，并推动 task failed/blocked 或 repair action。

### `packages/web-workspace/src/agent-v2-repair-engine.ts`

职责：

- 从 validation failure 生成 repair action。
- 限制最大 repair attempts。
- 识别不可修复能力错配，例如 full-stack/backend/database/auth 被 static 平台降级。
- 输出 task-scoped repair plan，而不是 continuation prompt。

### `packages/web-workspace/src/agent-v2-execution-core.ts`

职责：

- 面向 Phase 5 worker adapter 的稳定 facade。
- 输入 v2 runtime snapshot + active task + adapters。
- 执行当前 task 的最小工作：
  - planning/bootstrap tasks 可标记已完成。
  - implementation task 通过 file adapter 产出文件 artifact。
  - validation task 通过 validation gate 写 validation records。
  - repair task 通过 repair engine 生成后续 task updates。
  - delivery task 汇总 artifacts 和 preview metadata。

Phase 4 允许 execution core 的 implementation executor 是 deterministic/static MVP，但接口必须为后续 LLM task executor 留出边界。

## 数据流

1. Phase 5 worker 将 queued runtime run claim 为 running。
2. worker 确保存在 `agent_v2_runs` 和 planning bootstrap。
3. worker 调用 Phase 4 `executeAgentV2NextTask`.
4. execution core 加载 v2 snapshot。
5. task engine 选择 active task。
6. tool governance 校验当前 phase/task 允许的 adapter。
7. adapter 执行文件、build、validate、preview。
8. artifact/validation/diagnostic 写入 v2 tables。
9. task transition 写入 v2 task graph。
10. run event sink 持久化 `agent_v2.task_updated`、`agent_v2.validation_recorded`、`agent_v2.artifact_indexed`、`agent_v2.diagnostic_recorded`。

Phase 4 测试可直接调用 execution core，不需要真正接 Redis worker。

## 错误处理

所有 adapter failure 必须映射为结构化错误：

```ts
export interface AgentV2ToolFailure {
	code: string;
	message: string;
	retryable: boolean;
	phase?: AgentV2Phase;
	taskId?: string;
	artifactId?: string;
	path?: string;
	data: Record<string, unknown>;
}
```

错误分类至少包含：

- `tool.not_allowed_in_phase`
- `tool.input_invalid`
- `file.not_found`
- `file.conflict`
- `file.too_large`
- `validation.build_failed`
- `validation.static_quality_failed`
- `validation.static_smoke_failed`
- `validation.preview_missing_entry`
- `repair.max_attempts_exceeded`
- `platform.capability_unsupported`

## Validation / Repair 规则

validation gate 是强 gate：

- validation failed 时不能进入 delivery。
- failure 必须写入 validation table、diagnostic table，并关联 source task。
- repairable failure 生成 repair action。
- non-repairable failure 将 task 标记 blocked 或 run failed。
- repair attempts 必须计数，超过上限后退出。

必须覆盖的质量问题：

- 首屏 loading 默认可见。
- KPI/metric 仍显示 `--`。
- 图表、表格或关键容器无数据且无 empty state。
- script evaluation 抛错。
- `index.html` 缺失。
- package source 存在但未 build 出 static output。
- spec/plan/delivery 声称 backend/database/API，但 static artifact 无对应能力说明。

## 测试策略

单元测试：

- `agent-v2-tool-governance.test.ts`
  - phase allowlist 生效。
  - 未注册工具失败。
  - tool failure taxonomy 稳定。
- `agent-v2-file-adapter.test.ts`
  - list/read/write/patch 通过 v2 adapter。
  - 写入生成 artifact candidate。
  - 冲突、越界路径、大文件映射为结构化 failure。
- `agent-v2-validation-gate.test.ts`
  - static quality/smoke/build/preview 结果映射为 validation result。
  - loading、`--`、script error 被分类。
  - failed gate 生成 diagnostic 和 repair action input。
- `agent-v2-repair-engine.test.ts`
  - repairable failure 生成 task-scoped repair action。
  - non-repairable capability mismatch blocked。
  - max attempts 生效。
- `agent-v2-execution-core.test.ts`
  - 执行当前 ready task 并更新 v2 task state。
  - validation failed 不进入 delivery。
  - validation passed 后 artifact/validation/diagnostic/context packet 一致。
- `agent-v2-phase4-import-boundary.test.ts`
  - 新模块不引用旧 capability planner、spec artifact、context orchestrator、preview goal continuation、createRunAgent。

集成测试：

- 创建 v2 run + planning bootstrap。
- 执行 implementation task 生成静态文件 artifact。
- 执行 validation task，失败时写 validation/diagnostic/repair action。
- 修复后重新 validation passed。
- 发布 preview metadata，并写 delivery artifact。
- 使用 proxy store 禁止 legacy reads，证明 Phase 4 不读旧 sessions/messages/runs/app preview goal 作为 v2 state。

## 完成标准

- Phase 4 新模块没有旧 agent internal imports。
- 所有复用旧模块都通过 v2 adapter review，禁止直接暴露旧 tool contract。
- v2 validation gate 可结构化阻断 delivery。
- repair action 可从 validation failure 生成，并有 retry/exit 条件。
- artifact、validation、diagnostic、task state 在 v2 store 中一致。
- focused tests、package check、package build、root check 通过。

## 后续阶段

Phase 5：

- 新增 v2 worker adapter，实现 `WorkerAgent` 契约。
- 替换 `createRunAgent` 默认路径。
- 旧 v1 入口默认禁用，只允许极短期开发开关。

Phase 6：

- 运维级 reset 命令。
- Redis queue/cancel/live stream 清理。
- generated project workspaces 清理。
- quality regression suite。
- 默认切换和旧 agent 代码删除/隔离。
