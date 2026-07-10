# Phase 10 Preflight 02: Real v2 Production Chain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让生产 startRun 原子创建完整 v2 planning graph，并让 worker 使用真实模型生成和修复 artifacts，而不是 deterministic HTML。

**Architecture:** 一个 durable commit Module 隐藏 SQLite/PostgreSQL 的事务差异并写 canonical rows + outbox intents。web-workspace 定义 `AgentV2ModelExecution` Interface、结构化响应 parser 和 task orchestration；pi-coding-web worker 提供 PI AI Adapter，unit tests 使用 fake Adapter。

**Tech Stack:** TypeScript、SQLite/PostgreSQL transactions、PI AI `completeSimple`、Vitest、v2 task/artifact/validation Modules。

## Global Constraints

- 继承 master plan 全部约束。
- create run、planning bootstrap、两个 durable events 和 outbox intents 必须是单一数据库事务。
- production worker 必须注入真实 `AgentV2ModelExecution` Adapter；测试 fake 不能证明 production path。
- 模型输出必须经严格 schema parser 后才能进入 file Adapter。
- 不复用旧 browser Agent、旧 coding prompt、旧 context orchestrator 或 remote resume。
- phase 是持久化唯一事实源；task/artifact/validation/phase 更新必须原子且有 CAS。

**Mandatory commit gate:** 每个 Task 在 `git commit` 前都必须从仓库根目录运行 `npm run check` 与 `git diff --check`；任一失败即不得提交。

---

### Task 1: Add Durable Commit and Outbox Store

**Files:**
- Create: `packages/web-workspace/src/agent-v2-outbox.ts` plus mirrors
- Create: `packages/web-workspace/src/agent-v2-durable-store.ts` plus mirrors
- Modify: `packages/web-workspace/src/agent-v2-runtime-store.ts`, `runtime-db.ts`, `postgres-runtime-store.ts`, `runtime-store-factory.ts`, `agent-v2-types.ts`, `agent-v2-runtime.ts`, `index.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-outbox-store.test.ts`
- Create: `packages/web-workspace/test/agent-v2-postgres-durable.integration.test.ts`
- Modify tests: `postgres-runtime-store.test.ts`, `runtime-store-contract.test.ts`, `runtime-store-factory.test.ts`, `agent-v2-reset.test.ts`

**Interfaces:**

```ts
export type AgentV2OutboxKind = "run_enqueue" | "run_cancel" | "live_event" | "workspace_diagnostic" | "langfuse_diagnostic";
export type AgentV2OutboxStatus = "pending" | "leased" | "delivered" | "dead_letter";
export interface AgentV2OutboxRecord {
	intentId: string; dedupeKey: string; clientId: string; runId: string;
	reference:
		| { kind: "run_enqueue"; queueName: string }
		| { kind: "run_cancel"; queueName: string; cancelToken: string }
		| { kind: "live_event"; eventSeq: number }
		| { kind: "workspace_diagnostic"; diagnosticId: string }
		| { kind: "langfuse_diagnostic"; diagnosticId: string };
	status: AgentV2OutboxStatus; attemptCount: number; availableAt: string;
	leaseOwner?: string; leaseExpiresAt?: string; lastErrorCode?: string; lastErrorMessage?: string;
	createdAt: string; updatedAt: string; deliveredAt?: string;
}
export interface AgentV2InputBlobRecord {
	clientId: string; runId: string; inputId: string; logicalPath: string;
	mediaType: string; encoding: "utf8" | "binary"; bytes: Uint8Array;
	byteLength: number; checksum: string; createdAt: string;
}
export interface AgentV2InputReferenceRecord {
	clientId: string; runId: string; kind: "attachment" | "project_file";
	ordinal: number; inputId: string; logicalPath: string; displayName?: string;
	mediaType: string; byteLength: number; checksum: string;
}

export interface AgentV2StartRunCommitInput {
	run: CreateAgentV2RunInput; bootstrapVersion: string; bootstrapChecksum: string;
	inputBlobs: readonly AgentV2InputBlobRecord[];
	inputReferences: readonly AgentV2InputReferenceRecord[];
	readyPhase: AgentV2Phase; documents: readonly UpsertAgentV2DocumentInput[];
	tasks: readonly UpsertAgentV2TaskInput[]; artifacts: readonly UpsertAgentV2ArtifactInput[];
	diagnostics: readonly AgentV2DiagnosticEvent[]; queueName: string; createdAt: string;
}
export interface AgentV2StartRunCommitResult {
	run: AgentV2RunSnapshot; runCreatedEvent: AgentV2RunEventRecord;
	planningReadyEvent: AgentV2RunEventRecord; outboxIntentIds: readonly string[]; replayed: boolean;
}
export interface AgentV2RunTransitionCommitInput {
	update: UpdateAgentV2RunInput;
	event: Omit<AppendAgentV2RunEventInput, "clientId" | "runId" | "seq">;
	diagnostic?: AgentV2DiagnosticEvent;
}
export interface AgentV2RunTransitionCommitResult {
	update: AgentV2RunUpdateResult; event?: AgentV2RunEventRecord; outboxIntentIds: readonly string[];
}
export interface AgentV2CancelRunCommitInput {
	clientId: string; runId: string; expectedStatuses: readonly ("queued" | "running")[]; queueName: string;
	cancelToken: string; cancelledAt: string; reason?: string;
}
export interface AgentV2CancelRunCommitResult {
	run: AgentV2RunSnapshot; cancelEvent: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[]; replayed: boolean;
}
export interface AgentV2ExecutionMutationInput {
	clientId: string; runId: string; expectedRunPhase: AgentV2Phase;
	expectedTasks: readonly { taskId: string; status: AgentV2TaskStatus }[];
	nextRunPhase?: AgentV2Phase; tasks: readonly UpsertAgentV2TaskInput[];
	artifacts?: readonly UpsertAgentV2ArtifactInput[]; validation?: UpsertAgentV2ValidationInput;
	diagnostics?: readonly AgentV2DiagnosticEvent[];
	events: readonly Omit<AppendAgentV2RunEventInput, "clientId" | "runId" | "seq">[];
}
export interface AgentV2ExecutionMutationResult {
	applied: boolean; run: AgentV2RunSnapshot; tasks: readonly AgentV2TaskNode[];
	artifacts: readonly AgentV2ArtifactRecord[]; validation?: AgentV2ValidationRecord;
	events: readonly AgentV2RunEventRecord[]; outboxIntentIds: readonly string[];
}
export interface AgentV2DiagnosticCommitInput { diagnostic: AgentV2DiagnosticEvent; emitRunEvent: boolean; }
export interface AgentV2DiagnosticCommitResult {
	diagnostic: AgentV2DiagnosticEvent; event?: AgentV2RunEventRecord; outboxIntentIds: readonly string[];
}
export interface AgentV2OutboxLeaseInput {
	ownerId: string; kinds?: readonly AgentV2OutboxKind[]; limit: number; now: string; leaseTtlMs: number;
}
export interface AgentV2OutboxDeliveryInput { intentId: string; ownerId: string; deliveredAt: string; }
export interface AgentV2OutboxRescheduleInput {
	intentId: string; ownerId: string; availableAt: string; errorCode: string;
	errorMessage: string; maxAttempts: number; updatedAt: string;
}

export interface AgentV2DurableCommitStore {
	commitAgentV2RunStart(input: AgentV2StartRunCommitInput): AgentV2StoreResult<AgentV2StartRunCommitResult>;
	commitAgentV2RunCancel(input: AgentV2CancelRunCommitInput): AgentV2StoreResult<AgentV2CancelRunCommitResult>;
	commitAgentV2RunTransition(input: AgentV2RunTransitionCommitInput): AgentV2StoreResult<AgentV2RunTransitionCommitResult>;
	commitAgentV2ExecutionMutation(input: AgentV2ExecutionMutationInput): AgentV2StoreResult<AgentV2ExecutionMutationResult>;
	commitAgentV2Diagnostic(input: AgentV2DiagnosticCommitInput): AgentV2StoreResult<AgentV2DiagnosticCommitResult>;
	listAgentV2InputReferences(clientId: string, runId: string): AgentV2StoreResult<AgentV2InputReferenceRecord[]>;
	readAgentV2InputBlob(clientId: string, runId: string, inputId: string): AgentV2StoreResult<AgentV2InputBlobRecord | undefined>;
}

export interface AgentV2OutboxStore {
	leaseAgentV2Outbox(input: AgentV2OutboxLeaseInput): AgentV2StoreResult<AgentV2OutboxRecord[]>;
	markAgentV2OutboxDelivered(input: AgentV2OutboxDeliveryInput): AgentV2StoreResult<boolean>;
	rescheduleAgentV2Outbox(input: AgentV2OutboxRescheduleInput): AgentV2StoreResult<"pending" | "dead_letter" | "lease_lost">;
}
```

`AgentV2ExecutionMutationInput` contains expected run phase/task statuses, one or more task upserts, optional next run phase, artifacts, validation attempt, diagnostics and event descriptors; the store performs all-or-nothing CAS and returns `applied:false` without writing dependent rows when expectations fail.

- [ ] **Step 1: Write SQLite RED tests** for full rollback on any input-blob/reference/bootstrap child insert failure, immutable input reads, outbox dedupe, expired lease recovery, non-owner ack/fail and execution CAS failure producing no event/outbox.
- [ ] **Step 2: Write PostgreSQL contract RED tests** requiring `FOR UPDATE SKIP LOCKED`, owner/status CAS and the same transaction shape. Create `agent-v2-postgres-durable.integration.test.ts`; when `PI_TEST_POSTGRES_URL` is required it proves a real transaction rolls back every input blob/reference/bootstrap/outbox row on failure and concurrent lease owners never receive the same intent.
- [ ] **Step 3: Verify RED** with `agent-v2-outbox-store`, `postgres-runtime-store`, `runtime-store-contract`, `agent-v2-reset`.
- [ ] **Step 4: Implement schema version 2 once** with immutable `agent_v2_input_blobs` (PK `(client_id,run_id,input_id)`, BLOB/BYTEA content, unique logical path/checksum metadata), immutable `agent_v2_input_references` (PK `(client_id,run_id,kind,ordinal)`, FK to blob), `agent_v2_bootstraps`, `agent_v2_outbox`, and immutable `agent_v2_validation_attempts` whose primary key is `(client_id, run_id, validation_id, attempt)`; add dispatch/run indexes and reset deletion order. Existing non-empty v1 v2 schema fails with explicit reset-required error; no migration.
- [ ] **Step 5: Implement SQLite `*WithDatabase` and PostgreSQL `*WithQueryable` helpers** so composite commits never call public methods that open nested transactions.
- [ ] **Step 6: Sync mirrors, run focused tests, `npm run check`, and commit `feat(web-workspace): add agent v2 durable commit store`.**

### Task 2: Atomically Bootstrap startRun and Persist Cancel Intent

**Files:**
- Create: `packages/web-workspace/src/agent-v2-start-input.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-start-input.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-api-service.ts`, `agent-v2-planning-bootstrap.ts`, `agent-v2-types.ts`, `vite-plugin.ts` plus mirrors
- Modify tests: `agent-v2-run-api-service.test.ts`, `agent-v2-planning-bootstrap.test.ts`, `agent-v2-production-chain.test.ts`, `agent-v2-vite-plugin-routes.test.ts`

**Interfaces:**

```ts
export interface AgentV2ModelReference { provider: string; id: string; }
export interface AgentV2InputLimits {
	maxEntries: 64; maxTextBytes: 1_048_576; maxImageBytes: 2_097_152; maxTotalBytes: 8_388_608;
}
export const AGENT_V2_INPUT_LIMITS: AgentV2InputLimits;
export interface AgentV2NormalizedStartInput {
	runInput: AgentV2RunInput; model: AgentV2ModelReference;
	inputBlobs: readonly AgentV2InputBlobRecord[];
	inputReferences: readonly AgentV2InputReferenceRecord[];
}
export function normalizeAgentV2StartInput(value: unknown, identity: { clientId: string; runId: string; createdAt: string }): AgentV2NormalizedStartInput;
export interface AgentV2PlanningCommitInput {
	bootstrapVersion: "agent-v2-planning-v1";
	bootstrapChecksum: string;
	documents: readonly UpsertAgentV2DocumentInput[];
	tasks: readonly UpsertAgentV2TaskInput[];
	artifacts: readonly UpsertAgentV2ArtifactInput[];
	diagnostics: readonly AgentV2DiagnosticEvent[];
}

export function toAgentV2PlanningCommit(bootstrap: AgentV2PlanningBootstrap): AgentV2PlanningCommitInput;
```

Add event type `agent_v2.planning_ready`. `AgentV2RunApiService` receives durable commit store, configured queue name and optional dispatcher wake callback; it no longer calls `queue.enqueue()` or `eventLog.append()` directly.

`normalizeAgentV2StartInput()` is the only request boundary. It accepts strict `projectFiles` entries `{filename,content,encoding?:"base64"}` and strict attachment descriptors `{type,fileName,mimeType,projectFilePath}`. Every attachment must reference a matching project file; raw attachment binary/extracted text and message attachment payloads are removed from the durable `run.input`, which contains only text/objective plus canonical input reference metadata. The server validates normalized paths/media, decodes bytes, sniffs PNG/JPEG/WebP versus UTF-8 text, enforces `AGENT_V2_INPUT_LIMITS`, computes SHA-256, and creates deterministic input IDs from logical path + checksum. Same path/same bytes dedupes; same path/different bytes conflicts. The bootstrap checksum includes ordered canonical reference metadata and checksums.

- [ ] **Step 1: RED boundary tests** assert strict request normalization, attachment→project-file matching, server checksum/media sniff, limits, raw-content stripping, deterministic IDs, same-content dedupe and conflicting duplicate rejection. Browser start input persists only the stable model reference `{ provider, id }`; any client `api`, `baseUrl`, credential or transport field is rejected.
- [ ] **Step 2: RED transaction/crash tests** assert durable seq 1=`run_created`, seq 2=`planning_ready`; input blobs/references and complete docs/tasks exist before any dispatch; any blob/reference/bootstrap failure leaves no run or input row; dispatch wake failure does not fail durable start; identical runId/version/checksum replays without duplicates; changed input bytes conflict.
- [ ] **Step 3: Verify RED.**
- [ ] **Step 4: Make bootstrap builder pure and call one `commitAgentV2RunStart()`** with normalized run input, immutable blobs/references, checksum, all planning rows, events and three intents (queue + two live).
- [ ] **Step 5: Add cancel crash-point RED tests for queued and running runs:** durable commit before Redis delivery, Redis unavailable, delivery succeeds but outbox ack is lost, duplicate HTTP cancel and duplicate delivery. Implement `commitAgentV2RunCancel()` so run state + durable cancel event + `run_cancel`/live intents commit atomically; remove direct queue/event/cancel calls from HTTP paths. The server derives one deterministic cancel token from `(clientId,runId,"cancel")`; repeated HTTP cancel returns the existing canceled state/intent with `replayed:true`, and Redis delivery is idempotent by that token.
- [ ] **Step 6: Remove direct queue/event dependencies from start/cancel paths and update Vite composition.**
- [ ] **Step 7: Sync, focused tests, check and commit `fix(web-workspace): atomically bootstrap and cancel agent v2 runs`.**

### Task 3: Define the v2 ModelExecution Interface and Response Parser

**Files:**
- Create: `packages/web-workspace/src/agent-v2-model-execution.ts` plus mirrors
- Create: `packages/web-workspace/src/agent-v2-model-prompt.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-model-execution.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-runtime.ts`, `index.ts` plus mirrors

**Interfaces:**

```ts
export interface AgentV2GeneratedFile { path: string; content: string; }
export interface AgentV2AuthorizedInputReference {
	kind: "attachment" | "project_file"; inputId: string; logicalPath: string;
	mediaType: string; byteLength: number; checksum: string;
}
export interface AgentV2ImplementationResult {
	version: 1; taskId: string; summary: string; files: AgentV2GeneratedFile[];
}
export interface AgentV2RepairResult {
	version: 1; taskId: string; summary: string; files: AgentV2GeneratedFile[]; addressedDiagnosticIds: string[];
}
export interface AgentV2ModelUsageSummary { input: number; output: number; totalTokens: number; costTotal: number; }
export interface AgentV2ModelExecutionEnvelope<T> {
	result: T; provider: string; model: string; usage?: AgentV2ModelUsageSummary;
}
export type AgentV2MaterializedInput =
	| { kind: "text"; reference: AgentV2AuthorizedInputReference; text: string; checksum: string }
	| { kind: "image"; reference: AgentV2AuthorizedInputReference; data: Uint8Array; mediaType: "image/png" | "image/jpeg" | "image/webp"; checksum: string };
export interface AgentV2ModelExecutionInput {
	run: AgentV2RunSnapshot; contextPacket: AgentV2ContextPacket; task: AgentV2TaskNode;
	inputs: readonly AgentV2MaterializedInput[]; signal: AbortSignal;
}
export interface AgentV2ModelExecution {
	generateImplementation(input: AgentV2ModelExecutionInput): Promise<AgentV2ModelExecutionEnvelope<AgentV2ImplementationResult>>;
	generateRepair(input: AgentV2ModelExecutionInput & { diagnostics: readonly AgentV2DiagnosticEvent[] }): Promise<AgentV2ModelExecutionEnvelope<AgentV2RepairResult>>;
}
export function parseAgentV2ImplementationResult(text: string, expectedTaskId: string): AgentV2ImplementationResult;
export function parseAgentV2RepairResult(text: string, expectedTaskId: string): AgentV2RepairResult;
```

Parser limits: JSON object only, exact version/taskId, 1-64 files, normalized unique relative paths, per-file and aggregate character limits, no metadata/internal paths, no unknown fields that change execution semantics. Prompt renderer includes objective, selected capability, spec/plan/task criteria, artifact index, open diagnostics and materialized authorized inputs; it never includes secrets or old message continuation instructions.

- [ ] **Step 1: RED parser/prompt tests** cover fenced JSON, malformed/extra data, duplicate/escaping/internal paths, size limits, wrong taskId, implementation/repair schema and absence of old prompt/continuation vocabulary.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement strict parser and v2-only prompt renderer.**
- [ ] **Step 4: Sync, focused tests, boundary tests and commit `feat(web-workspace): define agent v2 model execution`.**

### Task 4: Implement the PI AI Worker Adapter

**Files:**
- Create: `apps/pi-coding-web/src/worker/agent-v2-pi-model-execution.ts`
- Create: `apps/pi-coding-web/test/agent-v2-pi-model-execution.test.ts`
- Create: `apps/pi-coding-web/src/worker/global-provider-keys.ts`
- Create: `apps/pi-coding-web/test/global-provider-keys.test.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify: `docs/superpowers/reviews/2026-07-10-application-generation-agent-v2-phase10-preflight-review.md` to record the externally gated legacy key-file deletion

**Interfaces:**

```ts
export interface AgentV2PiModelExecutionOptions {
	modelRegistry: AgentV2ServerModelRegistry;
	resolveApiKey(provider: string): string | undefined;
	complete?: typeof completeSimple;
}
export class AgentV2PiModelExecution implements AgentV2ModelExecution {
	constructor(options: AgentV2PiModelExecutionOptions);
}
export interface AgentV2ServerModelRegistry {
	resolve(reference: { provider: string; id: string }): Model<Api> | undefined;
}
```

The browser/durable run contains only `{provider,id}`. Resolve that reference through the trusted server-side registry/settings into canonical `Model<Api>` including `api`, `baseUrl`, input modes and token limits; resolve the API key separately from server settings/env. An unknown reference fails closed, and no browser field can select or override a network target. Call `completeSimple(model,{systemPrompt,messages:[user]}, {apiKey,signal,maxTokens,sessionId,maxRetries:0})`, collect final text blocks plus usage/provider/model metadata into `AgentV2ModelExecutionEnvelope`, map stop/error/abort to stable v2 errors, then call the strict parser. Never persist or log keys or raw provider payloads.

- [ ] **Step 1: RED tests** with a faux completion function verify trusted registry resolution, rejection of unknown/client-overridden network targets, and that `resolveApiKey` is invoked with provider only (no `clientId` argument); also cover exact model/context, usage metadata, abort, missing key, malformed output, provider error taxonomy and secret non-observability.
- [ ] **Step 2: RED production-boundary test** proves `createAgentV2WorkerExecution()` constructs `AgentV2PiModelExecution`, and production does not inject `SequencedExecution`/deterministic generation.
- [ ] **Step 3: Implement Adapter using only `global-provider-keys.ts`, whose API has no `clientId` and reads trusted global settings/environment only.** Add a production-boundary test that worker composition cannot import/call the client-scoped fallback. Because remote deployment configuration is explicitly out of scope and its global-key cutover has not been externally confirmed, retain existing `provider-keys.ts` unchanged in this preflight and record its later deletion in the review document. Delete it only in a separate task after deployment owners provide configuration evidence; unit tests are not sufficient evidence.
- [ ] **Step 4: Run app focused tests and web boundary test; commit `feat(web): execute agent v2 tasks with PI AI`.**

### Task 5: Materialize Authorized v2 Run Inputs

**Files:**
- Create: `packages/web-workspace/src/agent-v2-input-materializer.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-input-materializer.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-model-execution.ts`, `agent-v2-types.ts`, `agent-v2-runtime.ts`, `index.ts` plus mirrors
- Modify: `packages/web-workspace/test/agent-v2-production-chain.test.ts`

**Interfaces:**

```ts
export interface AgentV2InputMaterializer {
	materialize(input: { run: AgentV2RunSnapshot; signal: AbortSignal }): Promise<readonly AgentV2MaterializedInput[]>;
}
```

The materializer is constructed with the durable store from Task 1. It lists immutable references, loads blobs only by `(clientId,runId,inputId)`, recomputes byte length/SHA-256/media sniff, and fails on a missing, changed or cross-run blob. It never reads request paths or the mutable project workspace. Project files accept UTF-8 text only; attachments accept UTF-8 text plus PNG/JPEG/WebP. The PI adapter converts only these verified values to model content.

- [ ] **Step 1: RED tests** cover missing/cross-run blobs, persisted media spoofing, invalid UTF-8, entry/per-file/aggregate limits, abort, checksum/length mismatch and deterministic reference ordering. Request path and mutable workspace changes must have no effect after start commit.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement the materializer and change model input from raw references to `readonly AgentV2MaterializedInput[]`.** Canonical references/checksums already committed atomically at start are the only source; retrying the same run is idempotent, while store corruption or changed bytes fail closed rather than silently altering model context.
- [ ] **Step 4: Add production-chain RED/GREEN proof** that objective/projectFiles/attachments are materialized before the model call and that rejected input produces a sanitized non-retryable diagnostic without calling the provider.
- [ ] **Step 5: Sync, focused tests, checks and commit `feat(web-workspace): materialize authorized agent v2 inputs`.**

### Task 6: Execute Real Implementation Tasks and Persist Phase/Artifacts Atomically

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-execution-core.ts`, `agent-v2-state-machine.ts`, `agent-v2-task-engine.ts`, `agent-v2-artifact-index.ts`, `agent-v2-types.ts` plus mirrors
- Modify tests: `agent-v2-execution-core.test.ts`, `agent-v2-state-machine.test.ts`, `agent-v2-task-engine.test.ts`, `agent-v2-artifact-index.test.ts`, `agent-v2-production-chain.test.ts`

**Interfaces:** `ExecuteAgentV2NextTaskInput` requires `modelExecution`. Add centralized task transition matrix and `phaseForAgentV2Task(task, outcome)`. Artifact status stays `not_started | pending | passed | failed | accepted`.

Event payloads produced here are discriminated and exported for the browser plan:

```ts
export type AgentV2ArtifactValidationStatus = "not_started" | "pending" | "passed" | "failed" | "accepted";
export interface AgentV2TaskUpdatedPayload { type: "agent_v2.task_updated"; taskId: string; kind: AgentV2TaskKind; status: AgentV2TaskStatus; phase: AgentV2Phase; at: string; }
export interface AgentV2ArtifactIndexedPayload { type: "agent_v2.artifact_indexed"; artifactId: string; path: string; validationStatus: AgentV2ArtifactValidationStatus; revision: string; at: string; }
export interface AgentV2ValidationRecordedPayload { type: "agent_v2.validation_recorded"; validationId: string; taskId: string; attempt: number; status: AgentV2ValidationStatus; summary: string; at: string; }
export interface AgentV2OutputRecordedPayload { type: "agent_v2.output_recorded"; taskId: string; summary: string; provider: string; model: string; usage?: AgentV2ModelUsageSummary; at: string; }
export interface AgentV2DiagnosticRecordedPayload { type: "agent_v2.diagnostic_recorded"; diagnosticId: string; severity: AgentV2DiagnosticSeverity; code: string; message: string; at: string; }
```

- [ ] **Step 1: RED tests** prove implementation calls model with objective, trusted resolved model metadata, materialized attachments/projectFiles and context; writes every parsed file via authorized Adapter; no deterministic source remains; artifact revisions are pending; task+phase+artifact+event/outbox commit atomically; CAS conflict writes nothing.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Replace `deterministicImplementationSource()`** with `modelExecution.generateImplementation()`, apply files, compute artifacts, and call one execution mutation commit.
- [ ] **Step 4: Add production producers for `task_updated`, `artifact_indexed` and `output_recorded` events with sanitized summaries/usage only.**
- [ ] **Step 5: Sync, focused tests, check and commit `feat(web-workspace): execute real agent v2 implementation tasks`.**

### Task 7: Execute Repair and Preserve Validation History

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-execution-core.ts`, `agent-v2-repair-engine.ts`, `agent-v2-validation-gate.ts`, `agent-v2-store.ts`, `agent-v2-types.ts` plus mirrors
- Modify: concrete validation-attempt query/row mapping created in Task 1
- Modify tests: `agent-v2-execution-core.test.ts`, `agent-v2-repair-engine.test.ts`, `agent-v2-validation-gate.test.ts`, `agent-v2-validation-store.test.ts`, `agent-v2-production-chain.test.ts`

**Interfaces:** validation records are immutable attempts identified by `validationId + attempt`. On a repairable failure below the attempt limit, the completed validation task is marked `succeeded` (the validation action completed, though its result failed), then create deterministic `repair:<baseValidationTaskId>:<attempt>` with `dependsOn=[failedValidationTaskId]` and `revalidate:<baseValidationTaskId>:<attempt+1>` with `dependsOn=[repairTaskId]`; rewire delivery to depend on the newest revalidate task. Creation uses CAS on expected run phase, validation task status and attempt, and deterministic IDs provide dedupe after retry/ack loss. Revalidation failure repeats the same graph expansion. At the configured maximum attempt, mark the current validation task `failed`, leave delivery `blocked`, emit the terminal diagnostic/event, and create no further tasks.

- [ ] **Step 1: RED tests** assert first validation record remains after repair; exact deterministic repair/revalidate IDs, dependencies and delivery rewiring; duplicate/CAS-lost expansion writes nothing; repair calls `generateRepair`; no-change output fails/blocks; changed file returns artifact failed→pending; second validation passes latest revision; attempt limit terminates without loop.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Make repair an explicit task transition** and apply model files through the same safe file Adapter; never set validation ready without a persisted change.
- [ ] **Step 4: Atomically record validation attempt, diagnostic, repair/revalidate/delivery task upserts, artifact revision, run phase and durable events/outbox through the multi-task execution mutation.**
- [ ] **Step 5: Sync, focused tests, check and commit `feat(web-workspace): execute agent v2 repair and revalidation`.**

### Task 8: Prove the Production v2 Chain Without Real Provider Calls

**Files:**
- Modify: `packages/web-workspace/test/agent-v2-production-chain.test.ts`
- Create: `apps/pi-coding-web/test/agent-v2-worker-production-composition.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

- [ ] **Step 1: Replace the old SequencedExecution chain** with a fake `AgentV2ModelExecution` crossing the real start/bootstrap/execution/validation/repair store Interfaces. Assert task graph, artifacts, immutable validation attempts, output events and terminal phase.
- [ ] **Step 2: Add composition test** that stubs `completeSimple` at the PI AI Adapter seam and proves production worker resolves the run's stable `{provider,id}` via the trusted server registry and consumes objective/materialized projectFiles, not a test execution Module or a client-chosen base URL.
- [ ] **Step 3: Run both package focused suites, checks, mirror audits and `git diff --check`.**
- [ ] **Step 4: Commit `test(agent-v2): prove the real production generation chain`.**

## Plan 02 Verification

```powershell
Set-Location packages/web-workspace
if (-not $env:PI_TEST_POSTGRES_URL) { throw "PI_TEST_POSTGRES_URL is required for Phase 10 preflight" }
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/agent-v2-outbox-store.test.ts test/agent-v2-postgres-durable.integration.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-planning-bootstrap.test.ts test/agent-v2-model-execution.test.ts test/agent-v2-input-materializer.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-state-machine.test.ts test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-repair-engine.test.ts test/agent-v2-validation-gate.test.ts test/agent-v2-validation-store.test.ts test/agent-v2-production-chain.test.ts test/agent-v2-production-path-import-boundary.test.ts
npm run check
Set-Location ../../apps/pi-coding-web
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run --config vitest.config.ts test/agent-v2-pi-model-execution.test.ts test/agent-v2-worker-production-composition.test.ts test/global-provider-keys.test.ts test/worker-runtime-diagnostics.test.ts
npm run check
git diff --check
```

Expected: focused tests/checks pass; no production deterministic implementation, old prompt or continuation import remains in worker generation path.
