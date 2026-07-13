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

### Task 1: Create the Exact Agent v2 Schema and Immutable Validation Attempts

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-store.ts`, `agent-v2-runtime-store.ts`, `runtime-store.ts`, `runtime-db.ts`, `postgres-runtime-store.ts`, `agent-v2-types.ts`, `agent-v2-validation-gate.ts`, `agent-v2-execution-core.ts`, `agent-v2-reset.ts`, `agent-v2-maintenance.ts`, `index.ts` plus every same-name JavaScript/source-map mirror
- Create: `packages/web-workspace/test/agent-v2-schema-v2.test.ts`
- Create: `packages/web-workspace/test/agent-v2-postgres-schema.integration.test.ts`
- Create: `packages/web-workspace/test/helpers/postgres-test-schema.ts`
- Modify tests: `agent-v2-store.test.ts`, `agent-v2-validation-store.test.ts`, `agent-v2-quality-regression.test.ts`, `agent-v2-reset.test.ts`, `agent-v2-maintenance.test.ts`, `postgres-runtime-store.test.ts`, `runtime-store-contract.test.ts`, `runtime-store-factory.test.ts`, `agent-v2-validation-gate.test.ts`, `agent-v2-execution-core.test.ts`

**Interfaces and schema contract:**

```ts
export const AGENT_V2_SCHEMA_VERSION = 2;

export interface AppendAgentV2ValidationAttemptInput {
	clientId: string;
	runId: string;
	validationId: string;
	attempt: number;
	// Existing validation fields remain, with attempt required and positive.
}

export interface AgentV2ValidationRecord {
	// Existing validation fields remain.
	attempt: number;
}

export interface AgentV2ExecutionStore extends AgentV2RuntimeSnapshotStore {
	upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	appendAgentV2ValidationAttempt(
		input: AppendAgentV2ValidationAttemptInput,
	): AgentV2StoreResult<AgentV2ValidationRecord>;
}

export interface AgentV2ResetStoreOptions {
	now?: () => string;
}

export interface AgentV2ResetStoreResult {
	agentV2RowsDeleted: Record<string, number>;
	schemaVersion: 2;
}
```

`AGENT_V2_SCHEMA_VERSION=2` is an exact version, not a lower bound. Task 1 owns the complete v2 DDL below; later tasks may only read/write it and must not add a table, column, constraint or index while retaining schema version 2. SQLite uses `TEXT` for logical JSON and timestamps plus `BLOB` for logical bytes; PostgreSQL uses `JSONB`, `TEXT` timestamps and `BYTEA`. Columns are `NOT NULL` unless the manifest explicitly marks them `NULL`, and both dialects expose the same logical shape and constraints. Every listed FK is `ON UPDATE NO ACTION ON DELETE NO ACTION NOT DEFERRABLE`.

**Exact v2 schema manifest:**

| Table | Required columns and constraints | Required indexes |
|---|---|---|
| `agent_v2_schema_metadata` | `singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1)`, `schema_version INTEGER NOT NULL CHECK(schema_version=2)`, `applied_at TEXT NOT NULL`; exactly one row with `singleton_id=1` | none |
| `agent_v2_runs` | `client_id TEXT NOT NULL`, `run_id TEXT NOT NULL`, `status TEXT NOT NULL`, `phase TEXT NOT NULL`, `attempt INTEGER NOT NULL CHECK(attempt>=0)`, `input_json JSON NOT NULL`, `model_json JSON NOT NULL`, `worker_id TEXT NULL`, `created_at TEXT NOT NULL`, `updated_at TEXT NOT NULL`, `started_at TEXT NULL`, `ended_at TEXT NULL`, `error_json JSON NULL`; PK `(client_id,run_id)`; status/phase CHECKs use only exported v2 values; no FK to shared `clients` | `idx_agent_v2_runs_status(status,updated_at)`; `idx_agent_v2_runs_worker_active(worker_id,updated_at)` filtered to active owned runs |
| `agent_v2_run_events` | `client_id TEXT NOT NULL`, `run_id TEXT NOT NULL`, `seq INTEGER NOT NULL CHECK(seq>0)`, `event_type TEXT NOT NULL`, `payload_json JSON NOT NULL`, `created_at TEXT NOT NULL`; PK `(client_id,run_id,seq)`; FK `(client_id,run_id)` → v2 runs | PK supplies run/sequence lookup; no duplicate secondary index |
| `agent_v2_tasks` | `client_id/run_id/task_id/kind/title/status TEXT NOT NULL`, `parent_task_id TEXT NULL`, `depends_on_json/acceptance_criteria_json/input_json/output_json JSON NOT NULL`, `created_at/updated_at TEXT NOT NULL`, `started_at/ended_at TEXT NULL`, `error_json JSON NULL`; PK `(client_id,run_id,task_id)`; FK to v2 runs; status CHECK uses exported v2 task values | `idx_agent_v2_tasks_run_updated(client_id,run_id,updated_at DESC)` |
| `agent_v2_artifacts` | `client_id/run_id/artifact_id/kind/path/media_type/checksum/version/validation_status TEXT NOT NULL`, `source_task_id TEXT NULL`, `metadata_json JSON NOT NULL`, `created_at/updated_at TEXT NOT NULL`; PK `(client_id,run_id,artifact_id)`; FK to v2 runs | `idx_agent_v2_artifacts_run_updated(client_id,run_id,updated_at DESC)` |
| `agent_v2_documents` | `client_id/run_id/document_id/kind/version/content_markdown TEXT NOT NULL`, `content_json JSON NOT NULL`, `source_task_id TEXT NULL`, `created_at/updated_at TEXT NOT NULL`; PK `(client_id,run_id,document_id)`; FK to v2 runs | `idx_agent_v2_documents_run_updated(client_id,run_id,updated_at DESC)` |
| `agent_v2_diagnostics` | `client_id/run_id/diagnostic_id/severity/category/code/message TEXT NOT NULL`, `phase/task_id/artifact_id/trace_id TEXT NULL`, `data_json JSON NOT NULL`, `created_at TEXT NOT NULL`; PK `(client_id,run_id,diagnostic_id)`; FK to v2 runs | `idx_agent_v2_diagnostics_run_created(client_id,run_id,created_at,diagnostic_id)` |
| `agent_v2_validation_attempts` | `client_id/run_id/validation_id TEXT NOT NULL`, `attempt INTEGER NOT NULL CHECK(attempt>0)`, `task_id/artifact_id TEXT NULL`, `status/summary TEXT NOT NULL`, `details_json JSON NOT NULL`, `created_at/updated_at TEXT NOT NULL`; PK `(client_id,run_id,validation_id,attempt)`; FK to v2 runs; status CHECK uses exported validation values; no mutable validation table | `idx_agent_v2_validation_attempts_run_created(client_id,run_id,created_at,validation_id,attempt)` |
| `agent_v2_input_blobs` | `client_id/run_id/input_id/logical_path/media_type TEXT NOT NULL`, `encoding TEXT NOT NULL CHECK IN ('utf8','binary')`, `bytes BYTES NOT NULL`, `byte_length INTEGER NOT NULL CHECK(byte_length>=0)`, `checksum/created_at TEXT NOT NULL`; PK `(client_id,run_id,input_id)`; FK to v2 runs; checksum is metadata, not globally unique | unique `uq_agent_v2_input_blobs_logical_path(client_id,run_id,logical_path)` |
| `agent_v2_input_references` | `client_id/run_id/input_id/logical_path/media_type/checksum TEXT NOT NULL`, `kind TEXT NOT NULL CHECK IN ('attachment','project_file')`, `ordinal INTEGER NOT NULL CHECK(ordinal>=0)`, `display_name TEXT NULL`, `byte_length INTEGER NOT NULL CHECK(byte_length>=0)`; PK `(client_id,run_id,kind,ordinal)`; FK `(client_id,run_id,input_id)` → blobs and FK to v2 runs | PK supplies ordered kind lookup; no duplicate secondary index |
| `agent_v2_bootstraps` | `client_id/run_id/bootstrap_version/bootstrap_checksum/created_at TEXT NOT NULL`; PK `(client_id,run_id)`; FK to v2 runs | none |
| `agent_v2_outbox` | `intent_id/dedupe_key/client_id/run_id/kind/status/available_at/created_at/updated_at TEXT NOT NULL`, `reference_json JSON NOT NULL`, `attempt_count INTEGER NOT NULL CHECK(attempt_count>=0)`, `lease_owner/lease_expires_at/last_error_code/last_error_message/delivered_at TEXT NULL`; PK `(intent_id)`; `kind CHECK IN ('run_enqueue','run_cancel','live_event','workspace_diagnostic','langfuse_diagnostic')`; `status CHECK IN ('pending','leased','delivered','dead_letter')`; FK to v2 runs | unique `uq_agent_v2_outbox_dedupe(dedupe_key)`; `idx_agent_v2_outbox_dispatch(status,available_at,created_at,intent_id)`; `idx_agent_v2_outbox_lease(status,lease_expires_at,intent_id)`; `idx_agent_v2_outbox_run(client_id,run_id,created_at,intent_id)` |

Every listed FK targets only another `agent_v2_*` table. `ensureAgentV2Schema()` and v2 run creation must not call `ensureClientIdentitySchema()`/`upsertClient()`, must not read or write `clients`, and must not create a v2 FK to `clients`.

`ensureAgentV2Schema()` must inspect both metadata and the actual table/column/index/constraint shape before any v2 DDL or data write. A genuinely fresh database gets exact v2. Any existing version other than 2—including an empty v1—an unknown/newer version, or any metadata/table-shape mismatch must perform zero writes/DDL and throw one stable reset-required error; there is no migration or legacy compatibility path.

Confirmed destructive reset must not call ordinary `ensureAgentV2Schema()` first. It opens one transaction, counts then drops every `agent_v2_*` table in foreign-key-safe order—including the pre-v2-shape `agent_v2_validations` table—recreates exact v2, and commits; any count/drop/create failure rolls back the whole reset. SQLite and PostgreSQL must implement the same state machine. Remove `LEGACY_RESET_TABLES`, `includeClients` and `legacyRowsDeleted` from the v2 reset/maintenance contracts and implementations. Reset never reads, deletes or changes `clients`, `sessions`, `messages`, `runs`, `run_events`, or app-preview-goal tables; seeded legacy/client rows must remain byte-for-byte/logically unchanged.

`UpsertAgentV2ValidationInput` and `upsertAgentV2Validation()` are removed and replaced destructively by `AppendAgentV2ValidationAttemptInput` and `appendAgentV2ValidationAttempt()`. Record types, SQL row types, selected columns, builders and mappers all carry a positive `attempt`. Append is immutable: an identical same-PK byte/field replay returns the existing record, a same-PK different-content replay is a stable conflict, and no path issues `UPDATE`. The validation gate may make its input default explicit as attempt 1; execution call sites must still pass `attempt: 1` explicitly so repair can add later attempts.

- [ ] **Step 1: Write SQLite schema/reset RED tests.** Cover every table/column/nullability/PK/FK/CHECK/unique/index in the exact manifest; fresh exact-v2 creation; non-empty v1, empty v1, unknown/newer metadata and metadata/table mismatch; prove incompatible states throw the stable reset-required error with zero DDL/writes. Cover reset success, pre-v2-shape `agent_v2_validations` removal, FK-safe order and injected reset failure rolling the entire count/drop/recreate back. Seed legacy runtime plus `clients` and prove ensure, create-run and reset leave every legacy/client row unchanged. Update maintenance and factory capability tests for the destructive reset/validation interface changes.
- [ ] **Step 2: Write immutable validation RED tests.** Update store, gate, execution and quality-regression tests for required positive `attempt`, identical replay, conflicting replay, no update SQL, attempt-1 gate default and explicit execution `attempt: 1`.
- [ ] **Step 3: Write real PostgreSQL schema RED tests using `test/helpers/postgres-test-schema.ts`.** `PI_TEST_POSTGRES_URL` missing must fail rather than skip. Each test creates a UUID-named temporary schema; every pool connection fixes `search_path`, asserts `current_schema()`, and two concurrent connections must resolve to the same temporary schema. After store close, an admin connection drops only that schema with `CASCADE`; tests must never reset/clean `public` or load `.env`. Repeat the fresh/incompatible/reset/rollback/legacy-table assertions against real PostgreSQL.
- [ ] **Step 4: Run the Task 1 focused RED set** for `agent-v2-schema-v2`, the real PostgreSQL schema integration, store/validation/quality/reset/maintenance, PostgreSQL store/contract/factory, validation gate and execution core; confirm failures correspond to the missing exact-v2/append-only/v2-only-reset behavior and do not skip PostgreSQL.
- [ ] **Step 5: Implement exact schema-v2 inspection and destructive reset.** Centralize the complete table-shape manifest, enforce the pre-DDL compatibility read, make SQLite/PostgreSQL reset transactional, remove shared-client/legacy-table coupling from v2 schema/run/reset/maintenance, export the version/reset-required/reset-result contracts, and keep all legacy migration/compatibility branches absent.
- [ ] **Step 6: Implement immutable validation-attempt append.** Replace the mutable API through interfaces, concrete stores, builders/mappers, gate and execution call sites; make identical replay idempotent and different-content replay conflicting without an update path.
- [ ] **Step 7: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-store.ts agent-v2-runtime-store.ts runtime-store.ts runtime-db.ts postgres-runtime-store.ts agent-v2-types.ts agent-v2-validation-gate.ts agent-v2-execution-core.ts agent-v2-reset.ts agent-v2-maintenance.ts index.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-store.ts agent-v2-runtime-store.ts runtime-store.ts runtime-db.ts postgres-runtime-store.ts agent-v2-types.ts agent-v2-validation-gate.ts agent-v2-execution-core.ts agent-v2-reset.ts agent-v2-maintenance.ts index.ts`; fail on any omitted/drifting JS/map. Run all Task 1 focused tests including reset/maintenance/factory and the required real PostgreSQL integration, then from repository root run `npm run check` and `git diff --check`; commit only those files as `feat(web-workspace): create exact agent v2 schema`.

### Task 2: Add the Durable Commit and Outbox Store

**Files:**
- Create: `packages/web-workspace/src/agent-v2-outbox.ts` plus mirrors
- Create: `packages/web-workspace/src/agent-v2-durable-store.ts` plus mirrors
- Modify: `packages/web-workspace/src/agent-v2-runtime-store.ts`, `runtime-db.ts`, `postgres-runtime-store.ts`, `runtime-store-factory.ts`, `agent-v2-runtime.ts`, `runtime-infra.ts`, `index.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-outbox-store.test.ts`
- Create: `packages/web-workspace/test/agent-v2-postgres-durable.integration.test.ts`
- Modify tests: `postgres-runtime-store.test.ts`, `runtime-store-contract.test.ts`, `runtime-store-factory.test.ts`, `agent-v2-reset.test.ts`, `agent-v2-production-path-import-boundary.test.ts`

**Interfaces:** Preserve the durable/outbox records and operations below, using Task 1's append-only validation input.

Task 2 consumes Task 1's exact schema as-is. It must not execute `CREATE`, `ALTER`, `DROP`, add an index/constraint, or otherwise change schema shape/version; any missing Task 1 object is a reset-required/schema defect, not an invitation to repair schema lazily.

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
	inputBlobs: readonly AgentV2InputBlobRecord[]; inputReferences: readonly AgentV2InputReferenceRecord[];
	readyPhase: AgentV2Phase; documents: readonly UpsertAgentV2DocumentInput[];
	tasks: readonly UpsertAgentV2TaskInput[]; artifacts: readonly UpsertAgentV2ArtifactInput[];
	diagnostics: readonly AgentV2DiagnosticEvent[]; queueName: string; createdAt: string;
}
export interface AgentV2StartRunCommitResult {
	run: AgentV2RunSnapshot; runCreatedEvent: AgentV2RunEventRecord;
	planningReadyEvent: AgentV2RunEventRecord; outboxIntentIds: readonly string[]; replayed: boolean;
}
export interface AgentV2ExpectedRunState {
	status: AgentV2RunStatus; phase: AgentV2Phase; attempt: number;
	workerId: string | null; updatedAt: string;
}
export interface AgentV2RunTransitionCommitInput {
	update: UpdateAgentV2RunInput;
	expectedRun: AgentV2ExpectedRunState;
	event: Omit<AppendAgentV2RunEventInput, "clientId" | "runId" | "seq">;
	diagnostic?: AgentV2DiagnosticEvent;
}
export interface AgentV2RunTransitionCommitResult {
	update: AgentV2RunUpdateResult; event?: AgentV2RunEventRecord; outboxIntentIds: readonly string[];
}
export interface AgentV2CancelRunCommitInput {
	clientId: string; runId: string; expectedStatuses: readonly ("queued" | "running")[];
	expectedRun: AgentV2ExpectedRunState; queueName: string; cancelToken: string; cancelledAt: string; reason?: string;
}
export interface AgentV2CancelRunCommitResult {
	run: AgentV2RunSnapshot; cancelEvent: AgentV2RunEventRecord;
	outboxIntentIds: readonly string[]; replayed: boolean;
}
export interface AgentV2ExecutionMutationInput {
	clientId: string; runId: string; expectedRun: AgentV2ExpectedRunState;
	expectedTasks: readonly { taskId: string; status: AgentV2TaskStatus; updatedAt: string }[];
	nextRunPhase?: AgentV2Phase; tasks: readonly UpsertAgentV2TaskInput[];
	artifacts?: readonly UpsertAgentV2ArtifactInput[]; validation?: AppendAgentV2ValidationAttemptInput;
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
	markAgentV2OutboxDelivered(input: AgentV2OutboxDeliveryInput): AgentV2StoreResult<"delivered" | "lease_lost">;
	rescheduleAgentV2Outbox(input: AgentV2OutboxRescheduleInput): AgentV2StoreResult<"pending" | "dead_letter" | "lease_lost">;
}
export type AgentV2ProductionStore = AgentV2SchemaStore &
	AgentV2RunApiStore &
	AgentV2WorkerStore &
	AgentV2RunEventLogStore &
	AgentV2DiagnosticExportStore &
	AgentV2ExecutionStore &
	AgentV2ResetStore &
	AgentV2DurableCommitStore &
	AgentV2OutboxStore & {
		close(): void | Promise<void>;
	};
```

Extend the existing `AgentV2ProductionStore` intersection with both new production interfaces; do not replace or drop its schema/run/worker/event/diagnostic/execution/reset/close boundaries. Export the new production interfaces and records from `runtime-infra.ts` and the main `index.ts`; do not add them to legacy `RuntimeStore`.

Transition CAS includes `update.expectedStatuses` plus exact expected run `status`, `phase`, `attempt`, `workerId` (where `null` means expect SQL `NULL`) and `updatedAt`. Execution mutation uses that complete `expectedRun` and exact `{taskId,status,updatedAt}` expectations. Any missing or duplicate expectation, missing target, or mismatch—including ABA back to the same status—returns `applied:false`; event/outbox/diagnostic/artifact/validation/task and all other dependent writes remain zero.

Canonical outbox dedupe keys are exactly `run_enqueue:${clientId}:${runId}:${queueName}`, `run_cancel:${clientId}:${runId}:${queueName}:${cancelToken}`, `live_event:${clientId}:${runId}:${eventSeq}`, `workspace_diagnostic:${clientId}:${runId}:${diagnosticId}` and `langfuse_diagnostic:${clientId}:${runId}:${diagnosticId}`. `intentId` is `"outbox:" + sha256(dedupeKey)` and the database has a unique `dedupe_key`. Identical replay creates no duplicate; the same key with a different reference is a conflict. Every durable event maps to one live intent, every diagnostic to one workspace plus one Langfuse intent, start additionally maps to enqueue, and cancel additionally maps to cancel. Event sequence allocation is inside the same transaction and continuous; start reserves seq 1 `run_created` and seq 2 `planning_ready`.

Lease ordering is `(available_at,created_at,intent_id)`. A lease atomically selects pending or expired-leased rows and CASes owner/status/expiry, incrementing `attemptCount` on every successful lease. Reschedule returns `dead_letter` when `attemptCount >= maxAttempts`, otherwise pending; non-owner or non-leased delivery/reschedule returns `lease_lost`. Validate owner, positive limit/TTL/maxAttempts and timestamps.

Composite commits may call only transaction-handle `*WithDatabase`/`*WithQueryable` helpers and may not call public methods that start nested transactions. Recording-store tests assert exactly one `BEGIN` followed by one `COMMIT`, or exactly one `BEGIN` followed by one `ROLLBACK` on injected failure.

- [ ] **Step 1: Write SQLite RED tests** for full rollback on any blob/reference/bootstrap child failure, immutable input reads, canonical dedupe/reference conflict, contiguous event allocation and intent mapping, lease ordering/recovery/validation/dead-letter, non-owner loss, full run/task ABA CAS and zero dependent writes.
- [ ] **Step 2: Write factory/contract/reset/boundary and transaction-shape RED tests.** Prove concrete production stores and factory outputs satisfy `AgentV2DurableCommitStore & AgentV2OutboxStore`, `runtime-infra`/root exports are available without widening `RuntimeStore`, reset covers outbox/input/bootstrap tables, and success/fault paths record exactly one transaction boundary with no nested public transaction.
- [ ] **Step 3: Write required real PostgreSQL durable integration RED tests** reusing Task 1's temporary-schema helper; missing `PI_TEST_POSTGRES_URL` fails, never skips. Use two real fixed-search-path connections and a barrier: while owner A holds an uncommitted lease, owner B must obtain a different intent before the timeout via `FOR UPDATE SKIP LOCKED`; leases never overlap. Inject a composite-start fault and prove blob/reference/bootstrap/run/event/outbox counts all remain zero. Close stores before the admin-only temporary-schema drop and never touch `public` or `.env`.
- [ ] **Step 4: Run the complete Task 2 RED set** including outbox, real PostgreSQL durable integration, concrete PostgreSQL store, contract, factory, reset and boundary tests; confirm the PostgreSQL integration ran rather than skipped.
- [ ] **Step 5: Implement durable commits and canonical intent mapping** through only `*WithDatabase`/`*WithQueryable` helpers, transactional contiguous event allocation, complete ABA-safe CAS and Task 1's append-only validation API.
- [ ] **Step 6: Implement outbox dedupe and leasing** with the exact IDs/keys, replay/conflict rules, ordering, expired-lease takeover, per-lease attempt increments, owner/status checks and max-attempt rescheduling.
- [ ] **Step 7: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-outbox.ts agent-v2-durable-store.ts agent-v2-runtime-store.ts runtime-db.ts postgres-runtime-store.ts runtime-store-factory.ts agent-v2-runtime.ts runtime-infra.ts index.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-outbox.ts agent-v2-durable-store.ts agent-v2-runtime-store.ts runtime-db.ts postgres-runtime-store.ts runtime-store-factory.ts agent-v2-runtime.ts runtime-infra.ts index.ts`; fail on any omitted/drifting JS/map. Run the full Task 2 focused suite including required real PostgreSQL integration, then from repository root run `npm run check` and `git diff --check`; commit only Task 2 files as `feat(web-workspace): add agent v2 durable commit store`.

### Task 3: Atomically Bootstrap startRun and Persist Cancel Intent

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
- [ ] **Step 4: Make bootstrap builder pure and call one Task 2 `commitAgentV2RunStart()`** with normalized run input, immutable blobs/references, checksum and all planning rows. The commit creates the enqueue intent, one live intent for each of seq 1 `run_created` and seq 2 `planning_ready`, and two intents (workspace + Langfuse) for every diagnostic; it must not assume a fixed total of three intents.
- [ ] **Step 5: Add cancel crash-point RED tests for queued and running runs:** durable commit before Redis delivery, Redis unavailable, delivery succeeds but outbox ack is lost, duplicate HTTP cancel and duplicate delivery. Implement `commitAgentV2RunCancel()` so run state + durable cancel event + `run_cancel`/live intents commit atomically; remove direct queue/event/cancel calls from HTTP paths. The server derives one deterministic cancel token from `(clientId,runId,"cancel")`; repeated HTTP cancel returns the existing canceled state/intent with `replayed:true`, and Redis delivery is idempotent by that token.
- [ ] **Step 6: Remove direct queue/event dependencies from start/cancel paths and update Vite composition.**
- [ ] **Step 7: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-start-input.ts agent-v2-run-api-service.ts agent-v2-planning-bootstrap.ts agent-v2-types.ts vite-plugin.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-start-input.ts agent-v2-run-api-service.ts agent-v2-planning-bootstrap.ts agent-v2-types.ts vite-plugin.ts`. Run the complete Task 3 focused suite, then from repository root run `npm run check` and `git diff --check`; commit `fix(web-workspace): atomically bootstrap and cancel agent v2 runs` only after all gates pass.

### Task 4: Define the v2 ModelExecution Interface and Response Parser

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
- [ ] **Step 4: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-model-execution.ts agent-v2-model-prompt.ts agent-v2-runtime.ts index.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-model-execution.ts agent-v2-model-prompt.ts agent-v2-runtime.ts index.ts`. Run focused/boundary tests, then from repository root run `npm run check` and `git diff --check`; commit `feat(web-workspace): define agent v2 model execution` only after all gates pass.

### Task 5: Implement the PI AI Worker Adapter

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
- [ ] **Step 4: Verify mirrors/gates and commit.** This task changes no mirror-eligible `packages/web-workspace/src/*.ts`; explicitly audit the diff to confirm every changed source TS is confined to `apps/pi-coding-web` and therefore has no same-name web-workspace JS/map. Run app focused tests and the web boundary test, then from repository root run `npm run check` and `git diff --check`; commit `feat(web): execute agent v2 tasks with PI AI` only after all gates pass.

### Task 6: Materialize Authorized v2 Run Inputs

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

The materializer is constructed with the durable store from Task 2. It lists immutable references, loads blobs only by `(clientId,runId,inputId)`, recomputes byte length/SHA-256/media sniff, and fails on a missing, changed or cross-run blob. It never reads request paths or the mutable project workspace. Project files accept UTF-8 text only; attachments accept UTF-8 text plus PNG/JPEG/WebP. The PI adapter converts only these verified values to model content.

- [ ] **Step 1: RED tests** cover missing/cross-run blobs, persisted media spoofing, invalid UTF-8, entry/per-file/aggregate limits, abort, checksum/length mismatch and deterministic reference ordering. Request path and mutable workspace changes must have no effect after start commit.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement the materializer and change model input from raw references to `readonly AgentV2MaterializedInput[]`.** Canonical references/checksums already committed atomically at start are the only source; retrying the same run is idempotent, while store corruption or changed bytes fail closed rather than silently altering model context.
- [ ] **Step 4: Add production-chain RED/GREEN proof** that objective/projectFiles/attachments are materialized before the model call and that rejected input produces a sanitized non-retryable diagnostic without calling the provider.
- [ ] **Step 5: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-input-materializer.ts agent-v2-model-execution.ts agent-v2-types.ts agent-v2-runtime.ts index.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-input-materializer.ts agent-v2-model-execution.ts agent-v2-types.ts agent-v2-runtime.ts index.ts`. Run focused/production-chain tests, then from repository root run `npm run check` and `git diff --check`; commit `feat(web-workspace): materialize authorized agent v2 inputs` only after all gates pass.

### Task 7: Execute Real Implementation Tasks and Persist Phase/Artifacts Atomically

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

- [ ] **Step 1: RED tests** prove implementation calls model with objective, trusted resolved model metadata, materialized attachments/projectFiles and context; writes every parsed file via authorized Adapter; no deterministic source remains; artifact revisions are pending; task+phase+artifact+event/outbox commit atomically through Task 2's full expected run/task `updatedAt` CAS; missing, duplicate, ABA-stale or mismatched expectations write nothing.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Replace `deterministicImplementationSource()`** with `modelExecution.generateImplementation()`, apply files, compute artifacts, and call one execution mutation commit.
- [ ] **Step 4: Add production producers for `task_updated`, `artifact_indexed` and `output_recorded` events with sanitized summaries/usage only.**
- [ ] **Step 5: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-execution-core.ts agent-v2-state-machine.ts agent-v2-task-engine.ts agent-v2-artifact-index.ts agent-v2-types.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-execution-core.ts agent-v2-state-machine.ts agent-v2-task-engine.ts agent-v2-artifact-index.ts agent-v2-types.ts`. Run focused/production-chain tests, then from repository root run `npm run check` and `git diff --check`; commit `feat(web-workspace): execute real agent v2 implementation tasks` only after all gates pass.

### Task 8: Execute Repair and Preserve Validation History

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-execution-core.ts`, `agent-v2-repair-engine.ts`, `agent-v2-validation-gate.ts`, `agent-v2-store.ts`, `agent-v2-types.ts` plus mirrors
- Modify: concrete validation-attempt append/query/row mapping created in Task 1
- Modify tests: `agent-v2-execution-core.test.ts`, `agent-v2-repair-engine.test.ts`, `agent-v2-validation-gate.test.ts`, `agent-v2-validation-store.test.ts`, `agent-v2-production-chain.test.ts`

**Interfaces:** validation records are immutable attempts identified by `validationId + attempt`. On a repairable failure below the attempt limit, the completed validation task is marked `succeeded` (the validation action completed, though its result failed), then create deterministic `repair:<baseValidationTaskId>:<attempt>` with `dependsOn=[failedValidationTaskId]` and `revalidate:<baseValidationTaskId>:<attempt+1>` with `dependsOn=[repairTaskId]`; rewire delivery to depend on the newest revalidate task. Creation uses CAS on expected run phase, validation task status and attempt, and deterministic IDs provide dedupe after retry/ack loss. Revalidation failure repeats the same graph expansion. At the configured maximum attempt, mark the current validation task `failed`, leave delivery `blocked`, emit the terminal diagnostic/event, and create no further tasks.

- [ ] **Step 1: RED tests** assert first validation record remains after repair; exact deterministic repair/revalidate IDs, dependencies and delivery rewiring; duplicate/CAS-lost expansion writes nothing; repair calls `generateRepair`; no-change output fails/blocks; changed file returns artifact failed→pending; second validation passes latest revision; attempt limit terminates without loop.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Make repair an explicit task transition** and apply model files through the same safe file Adapter; never set validation ready without a persisted change.
- [ ] **Step 4: Atomically append the Task 1 immutable validation attempt, diagnostic, repair/revalidate/delivery task upserts, artifact revision, run phase and durable events/outbox through Task 2's full ABA-safe multi-task execution mutation.**
- [ ] **Step 5: Sync, audit, verify and commit.** From `packages/web-workspace`, explicitly run `node scripts/source-mirrors.mjs sync agent-v2-execution-core.ts agent-v2-repair-engine.ts agent-v2-validation-gate.ts agent-v2-store.ts agent-v2-types.ts`, then `node scripts/source-mirrors.mjs audit agent-v2-execution-core.ts agent-v2-repair-engine.ts agent-v2-validation-gate.ts agent-v2-store.ts agent-v2-types.ts`. Run focused/production-chain tests, then from repository root run `npm run check` and `git diff --check`; commit `feat(web-workspace): execute agent v2 repair and revalidation` only after all gates pass.

### Task 9: Prove the Production v2 Chain Without Real Provider Calls

**Files:**
- Modify: `packages/web-workspace/test/agent-v2-production-chain.test.ts`
- Create: `apps/pi-coding-web/test/agent-v2-worker-production-composition.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

- [ ] **Step 1: Replace the old SequencedExecution chain** with a fake `AgentV2ModelExecution` crossing the real start/bootstrap/execution/validation/repair store Interfaces. Assert task graph, artifacts, immutable validation attempts, output events and terminal phase.
- [ ] **Step 2: Add composition test** that stubs `completeSimple` at the PI AI Adapter seam and proves production worker resolves the run's stable `{provider,id}` via the trusted server registry and consumes objective/materialized projectFiles, not a test execution Module or a client-chosen base URL.
- [ ] **Step 3: Run both package focused suites and all gates.** This task changes no mirror-eligible `packages/web-workspace/src/*.ts`; explicitly audit the diff to confirm only test TS changed and no JS/map mirror is required. From repository root run `npm run check` and `git diff --check` after both package suites pass.
- [ ] **Step 4: Commit `test(agent-v2): prove the real production generation chain`.**

## Plan 02 Verification

```powershell
Set-Location packages/web-workspace
if (-not $env:PI_TEST_POSTGRES_URL) { throw "PI_TEST_POSTGRES_URL is required for Phase 10 preflight" }
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/agent-v2-schema-v2.test.ts test/agent-v2-postgres-schema.integration.test.ts test/agent-v2-store.test.ts test/agent-v2-validation-store.test.ts test/agent-v2-quality-regression.test.ts test/agent-v2-reset.test.ts test/agent-v2-maintenance.test.ts test/postgres-runtime-store.test.ts test/runtime-store-contract.test.ts test/runtime-store-factory.test.ts test/agent-v2-validation-gate.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-outbox-store.test.ts test/agent-v2-postgres-durable.integration.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-planning-bootstrap.test.ts test/agent-v2-model-execution.test.ts test/agent-v2-input-materializer.test.ts test/agent-v2-state-machine.test.ts test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-repair-engine.test.ts test/agent-v2-production-chain.test.ts test/agent-v2-production-path-import-boundary.test.ts
npm run check
Set-Location ../../apps/pi-coding-web
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run --config vitest.config.ts test/agent-v2-pi-model-execution.test.ts test/agent-v2-worker-production-composition.test.ts test/global-provider-keys.test.ts test/worker-runtime-diagnostics.test.ts
npm run check
git diff --check
```

Expected: both `agent-v2-postgres-schema.integration.test.ts` and `agent-v2-postgres-durable.integration.test.ts` execute against real PostgreSQL and pass—neither may skip; all other focused tests/checks pass; no production deterministic implementation, old prompt or continuation import remains in worker generation path.
