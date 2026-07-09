# Application Generation Agent v2 Phase 7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining v1 generation public surface and make the v2 runtime, queue, worker, and diagnostic contracts stand on v2-specific interfaces.

**Architecture:** Phase 7 keeps useful infrastructure only behind explicit v2 adapter names. v2 production modules must not import old run API, old worker, app preview goal, or `RuntimeStore` as their contract. The package root barrel becomes a v2/runtime utility surface instead of a compatibility layer for old generation agent types.

**Tech Stack:** TypeScript, Vitest, tsgo, Redis queue adapter, PostgreSQL runtime store, Vite worker/plugin entrypoints.

## Global Constraints

- Do not preserve v1 generation agent compatibility paths.
- Do not use `PI_APP_AGENT_VERSION` as a formal architecture path.
- v2 correctness, diagnosability, task state machine, and validation/repair loop quality take priority over v1 interface compatibility.
- Old v1 run/session/message/app preview goal/diagnostic test data does not need migration.
- Old v1 service code may be deleted when it conflicts with the v2 design.
- Reusable infrastructure is allowed only after review and only behind v2 or infrastructure adapter boundaries: PostgreSQL connection/schema management, Redis run queue/cancel key/live event stream, worker lifecycle, run event persistence and SSE replay, diagnostic log sink/Langfuse export, static build/validate/preview, Docker/Podman deployment config.
- Rollback is code redeploy or restoring a previous branch version, not in-runtime v1/v2 dual path.
- Do not push the branch. Finish local development and verification first.
- Use codegraph first for project structure and code lookup. If codegraph fails, repair it before falling back to other search methods.

---

## File Structure

- `packages/web-workspace/src/index.ts`: root package barrel. It must export v2 contracts, workspace utilities, diagnostics, and infrastructure factories only. It must stop exporting old v1 run/app-preview/session/message types and old queue/event bus classes.
- `packages/web-workspace/src/runtime-infra.ts`: infrastructure subpath for worker/runtime bootstrap. It must expose storage config, diagnostics, `createRuntimeStore`, and v2-named queue/store contracts. It must not expose `RedisRunQueue` or `RuntimeStore`.
- `packages/web-workspace/src/agent-v2-run-queue.ts`: v2 queue contract and adapter boundary. It may wrap the existing Redis queue implementation internally because Redis queue/cancel key behavior is explicitly retained infrastructure, but it must expose v2-named types and factories.
- `packages/web-workspace/src/agent-v2-runtime-store.ts`: new v2 store contract file. It defines narrow interfaces consumed by v2 services instead of `Pick<RuntimeStore, ...>` aliases scattered through v2 files.
- `packages/web-workspace/src/agent-v2-run-api-service.ts`: consumes a v2 run API store contract.
- `packages/web-workspace/src/agent-v2-runtime-core.ts`: consumes a v2 runtime snapshot/task store contract.
- `packages/web-workspace/src/agent-v2-execution-core.ts`: consumes a v2 execution store contract.
- `packages/web-workspace/src/agent-v2-planning-bootstrap.ts`: consumes a v2 planning persistence store contract.
- `packages/web-workspace/src/agent-v2-run-event-log.ts`: consumes a v2 run-event log store contract.
- `packages/web-workspace/src/agent-v2-worker-service.ts`: consumes a v2 worker store contract.
- `packages/web-workspace/src/agent-v2-maintenance.ts`: consumes v2 reset and queue contracts.
- `packages/web-workspace/src/agent-v2-reset.ts`: consumes v2 reset store contracts.
- `packages/web-workspace/src/diagnostic-export-service.ts`: consumes a v2 diagnostic export store contract for v2 run data.
- `packages/web-workspace/src/vite-plugin.ts`: constructs v2 run API, queue, event bus, and diagnostic export services. It must not import deleted v1 service errors.
- `apps/pi-coding-web/src/worker/main.ts`: worker process bootstrap. It must import v2 runtime contracts from `agent-v2-runtime` and infrastructure from `runtime-infra`, without root barrel imports or old `RuntimeStore`.
- `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`: primary boundary test for root exports, v2 imports, deleted v1 files, and worker import paths.
- `packages/web-workspace/test/agent-v2-run-queue.test.ts`: v2 queue adapter tests. It should use v2 names at the test boundary.
- `packages/web-workspace/test/*agent-v2*.test.ts`: update type imports from `RuntimeStore` to new v2 store interfaces where the tests are validating v2 behavior.
- Delete old v1 source/tests that only validate removed product behavior:
  - `packages/web-workspace/src/run-api-service.ts`
  - `packages/web-workspace/src/run-api-service.js`
  - `packages/web-workspace/src/run-api-service.js.map`
  - `packages/web-workspace/src/run-worker-service.ts`
  - `packages/web-workspace/src/run-worker-service.js`
  - `packages/web-workspace/src/run-worker-service.js.map`
  - `packages/web-workspace/src/app-preview-goal-service.ts`
  - `packages/web-workspace/src/app-preview-goal-service.js`
  - `packages/web-workspace/src/app-preview-goal-service.js.map`
  - `packages/web-workspace/src/app-preview-goal-supervisor.ts`
  - `packages/web-workspace/src/app-preview-goal-supervisor.js`
  - `packages/web-workspace/src/app-preview-goal-supervisor.js.map`
  - `packages/web-workspace/test/run-api-service.test.ts`
  - `packages/web-workspace/test/run-worker-service.test.ts`
  - `packages/web-workspace/test/app-preview-goal-service.test.ts`
  - `packages/web-workspace/test/app-preview-goal-supervisor.test.ts`

---

### Task 1: Root and Queue Public Surface Contraction

**Files:**
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-queue.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify: `packages/web-workspace/src/runtime-infra.ts`
- Modify: `packages/web-workspace/src/agent-v2-runtime.ts`
- Test: `packages/web-workspace/test/agent-v2-run-queue.test.ts`

**Interfaces:**
- Consumes: existing `RunQueue` and `RedisRunQueue` implementation as a reviewed infrastructure adapter inside `agent-v2-run-queue.ts`.
- Produces:
  - `AgentV2RunQueueClearResult`
  - `RedisAgentV2RunQueueOptions`
  - `createRedisAgentV2RunQueue(options: RedisAgentV2RunQueueOptions): AgentV2RunQueue`
  - root barrel no longer exports legacy run queue/event bus/retry/app-preview/run/session/message types.

- [ ] **Step 1: Write the failing boundary assertions**

In `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`, replace the root barrel legacy export loop with named arrays:

```ts
const legacyRootServiceExports = [
	"AppPreviewGoalService",
	"AppPreviewGoalSupervisor",
	"WorkspaceRunApiService",
	"WorkspaceRunWorkerService",
	"RunApiError",
	"budgetForSource",
	"WorkerAgent",
	"WorkerAgentEvent",
	"WorkspaceRunWorkerServiceOptions",
	"RunWorkerDiagnostics",
];

const legacyRootRuntimeExports = [
	"AppendAppPreviewGoalEventInput",
	"AppPreviewGoalEventRecord",
	"AppPreviewGoalEventType",
	"AppPreviewGoalRecord",
	"AppPreviewGoalSource",
	"AppPreviewGoalStartRequest",
	"AppPreviewGoalStatus",
	"ClaimedRun",
	"CreateRunInput",
	"CreateSessionInput",
	"DeleteSessionResult",
	"InMemoryRunEventBus",
	"InMemoryRunQueue",
	"LiveRunEvent",
	"RedisRunEventBus",
	"RedisRunQueue",
	"RunEventBus",
	"RunEventIdentity",
	"RunEventReadRequest",
	"RunEventSink",
	"RunEventSinkAgentEvent",
	"RunEventSinkOptions",
	"RunEventSinkStore",
	"RunQueue",
	"RunQueueClearResult",
	"RunQueueIdentity",
	"RunQueueItem",
	"RunRetryController",
	"RunRetryControllerDiagnostics",
	"RunRetryControllerOptions",
	"RunRetryExecutionInput",
	"RunStatus",
	"RunStatusPatch",
	"RuntimeActiveRunRestore",
	"RuntimeMessageRecord",
	"RuntimeRunEventListResult",
	"RuntimeRunEventRecord",
	"RuntimeRunListResult",
	"RuntimeRunRecord",
	"RuntimeSessionDetail",
	"RuntimeSessionListResult",
	"RuntimeSessionRecord",
	"RuntimeStore",
	"StartRunProjectFile",
	"StartRunRequest",
	"StartRunResult",
	"UpdateAppPreviewGoalInput",
	"UpsertAppPreviewGoalInput",
	"WorkerAgentInput",
];
```

Then update the test body:

```ts
it("does not expose legacy v1 product services through the root package barrel", () => {
	const rootExports = readRootBarrelExportNames();
	for (const legacyExport of [...legacyRootServiceExports, ...legacyRootRuntimeExports]) {
		expect(rootExports, `root barrel must not export ${legacyExport}`).not.toContain(legacyExport);
	}
});
```

- [ ] **Step 2: Run the focused boundary test and verify it fails**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL with root barrel export violations for `RedisRunQueue`, `RuntimeStore`, `StartRunRequest`, and other legacy names.

- [ ] **Step 3: Add v2-named queue clear result and Redis queue factory**

In `packages/web-workspace/src/agent-v2-run-queue.ts`, change the first import and add explicit v2 queue types:

```ts
import { RedisRunQueue, type ActiveRunClaim, type ClaimedRun, type RunQueue } from "./run-queue.js";

export interface AgentV2RunQueueClearResult {
	queueItemsDeleted: number;
	activeClaimsDeleted: number;
	cancelKeysDeleted: number;
}

export interface RedisAgentV2RunQueueOptions {
	redisUrl: string;
	queueName: string;
	claimLeaseTtlMs?: number;
	cancelTtlSeconds?: number;
}
```

Update `AgentV2RunQueue.clear()` to return `Promise<AgentV2RunQueueClearResult>`, and add this factory below the interface:

```ts
export function createRedisAgentV2RunQueue(options: RedisAgentV2RunQueueOptions): AgentV2RunQueue {
	return createAgentV2RunQueue(new RedisRunQueue(options));
}
```

- [ ] **Step 4: Update queue tests to consume v2 names**

In `packages/web-workspace/test/agent-v2-run-queue.test.ts`, stop importing `RunQueueClearResult` at the test boundary. Use:

```ts
import {
	type AgentV2RunQueueClearResult,
	type AgentV2RunQueueIdentity,
	createAgentV2RunQueue,
} from "../src/agent-v2-run-queue.js";
import type { RunQueue } from "../src/run-queue.js";
```

Replace test helper annotations from `RunQueueClearResult` to `AgentV2RunQueueClearResult`.

- [ ] **Step 5: Replace direct RedisRunQueue construction in production v2 setup**

In `packages/web-workspace/src/vite-plugin.ts`, change:

```ts
import { type AgentV2RunQueue, createAgentV2RunQueue } from "./agent-v2-run-queue.js";
import { RedisRunQueue } from "./run-queue.js";
```

to:

```ts
import { type AgentV2RunQueue, createRedisAgentV2RunQueue } from "./agent-v2-run-queue.js";
```

Then change:

```ts
agentV2RunQueue ?? createAgentV2RunQueue(new RedisRunQueue({
	redisUrl: config.redisUrl,
	queueName: config.runQueueName,
	claimLeaseTtlMs: config.agentV2WorkerLeaseMs,
	cancelTtlSeconds: config.runCancelTtlSeconds,
}));
```

to:

```ts
agentV2RunQueue ?? createRedisAgentV2RunQueue({
	redisUrl: config.redisUrl,
	queueName: config.runQueueName,
	claimLeaseTtlMs: config.agentV2WorkerLeaseMs,
	cancelTtlSeconds: config.runCancelTtlSeconds,
});
```

In `apps/pi-coding-web/src/worker/main.ts`, change the runtime import from `RedisRunQueue` and `createAgentV2RunQueue` usage to `createRedisAgentV2RunQueue`.

- [ ] **Step 6: Export v2 queue names through the v2/runtime subpaths**

In `packages/web-workspace/src/agent-v2-runtime.ts`, export the new queue factory and types:

```ts
export {
	type AgentV2ClaimedRun,
	type AgentV2RunQueue,
	type AgentV2RunQueueClearResult,
	type AgentV2RunQueueIdentity,
	type RedisAgentV2RunQueueOptions,
	createAgentV2RunQueue,
	createRedisAgentV2RunQueue,
} from "./agent-v2-run-queue.js";
```

In `packages/web-workspace/src/runtime-infra.ts`, replace the `RedisRunQueue` export with:

```ts
export {
	type AgentV2RunQueue,
	type AgentV2RunQueueClearResult,
	type RedisAgentV2RunQueueOptions,
	createRedisAgentV2RunQueue,
} from "./agent-v2-run-queue.js";
```

- [ ] **Step 7: Remove legacy exports from the root barrel**

In `packages/web-workspace/src/index.ts`, delete these root exports:

```ts
export {
	InMemoryRunEventBus,
	type LiveRunEvent,
	RedisRunEventBus,
	type RedisRunEventBusClient,
	type RedisRunEventBusOptions,
	type RunEventBus,
	type RunEventIdentity,
	type RunEventReadRequest,
	runEventStreamKey,
} from "./run-event-bus.js";
export {
	RunEventSink,
	type RunEventSinkAgentEvent,
	type RunEventSinkOptions,
	type RunEventSinkStore,
} from "./run-event-sink.js";
export type { ClaimedRun, RunQueue, RunQueueClearResult, RunQueueIdentity, RunQueueItem } from "./run-queue.js";
export { InMemoryRunQueue, RedisRunQueue } from "./run-queue.js";
export {
	RunRetryController,
	type RunRetryControllerDiagnostics,
	type RunRetryControllerOptions,
	type RunRetryExecutionInput,
} from "./run-retry-controller.js";
export type { RuntimeStore } from "./runtime-store.js";
```

Also remove the following names from the `./types.js` export block:

```ts
AppendAppPreviewGoalEventInput,
AppPreviewGoalEventRecord,
AppPreviewGoalEventType,
AppPreviewGoalRecord,
AppPreviewGoalSource,
AppPreviewGoalStartRequest,
AppPreviewGoalStatus,
CreateRunInput,
CreateSessionInput,
DeleteSessionResult,
RunStatus,
RunStatusPatch,
RuntimeActiveRunRestore,
RuntimeMessageRecord,
RuntimeRunEventListResult,
RuntimeRunEventRecord,
RuntimeRunListResult,
RuntimeRunRecord,
RuntimeSessionDetail,
RuntimeSessionListResult,
RuntimeSessionRecord,
StartRunProjectFile,
StartRunRequest,
StartRunResult,
UpdateAppPreviewGoalInput,
UpsertAppPreviewGoalInput,
WorkerAgentInput,
```

Keep diagnostics, workspace file/preview/task/skill types, storage config, and v2 types exported.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-run-queue.test.ts
npm --workspace @mariozechner/pi-web-workspace run check
```

Expected: both commands PASS.

- [ ] **Step 9: Commit Task 1**

Run:

```bash
git add packages/web-workspace/src/agent-v2-run-queue.ts packages/web-workspace/src/agent-v2-runtime.ts packages/web-workspace/src/index.ts packages/web-workspace/src/runtime-infra.ts packages/web-workspace/src/vite-plugin.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts packages/web-workspace/test/agent-v2-run-queue.test.ts apps/pi-coding-web/src/worker/main.ts
git commit -m "refactor: contract v2 queue public surface"
```

---

### Task 2: v2 Runtime Store Contracts

**Files:**
- Create: `packages/web-workspace/src/agent-v2-runtime-store.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-api-service.ts`
- Modify: `packages/web-workspace/src/agent-v2-runtime-core.ts`
- Modify: `packages/web-workspace/src/agent-v2-execution-core.ts`
- Modify: `packages/web-workspace/src/agent-v2-planning-bootstrap.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-event-log.ts`
- Modify: `packages/web-workspace/src/agent-v2-worker-service.ts`
- Modify: `packages/web-workspace/src/agent-v2-maintenance.ts`
- Modify: `packages/web-workspace/src/agent-v2-reset.ts`
- Modify: `packages/web-workspace/src/diagnostic-export-service.ts`
- Modify: `packages/web-workspace/src/agent-v2-runtime.ts`
- Modify: `packages/web-workspace/src/runtime-infra.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify tests that import `RuntimeStore` only to model v2 behavior.
- Test: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:**
- Consumes: concrete `RuntimeDbStore` and `createRuntimeStore` keep implementing all required methods.
- Produces:
  - `AgentV2RunApiStore`
  - `AgentV2RuntimeSnapshotStore`
  - `AgentV2ExecutionStore`
  - `AgentV2PlanningStore`
  - `AgentV2RunEventLogStore`
  - `AgentV2WorkerStore`
  - `AgentV2ResetStore`
  - `AgentV2DiagnosticExportStore`
  - `AgentV2SchemaStore`
  - `AgentV2StoreResult<T> = T | Promise<T>`
  - `MaybeAsyncIterable<T> = AsyncIterable<T> | Iterable<T>`

- [ ] **Step 1: Write failing boundary assertions for direct `RuntimeStore` dependency**

In `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`, add:

```ts
const allowedRuntimeStoreImportFiles = new Set([
	"packages/web-workspace/src/runtime-db.ts",
	"packages/web-workspace/src/postgres-runtime-store.ts",
	"packages/web-workspace/src/runtime-store-factory.ts",
]);
```

Add this test:

```ts
it("keeps v2 production contracts independent from the legacy RuntimeStore interface", () => {
	const violations = productionV2Files()
		.map(toRepoPath)
		.filter((file) => !allowedRuntimeStoreImportFiles.has(file))
		.filter((file) => {
			const source = readFileSync(join(repoRoot, file), "utf8");
			return source.includes("./runtime-store.js") || source.includes("RuntimeStore");
		});

	expect(violations).toEqual([]);
});
```

- [ ] **Step 2: Run the focused boundary test and verify it fails**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL listing `agent-v2-run-api-service.ts`, `agent-v2-runtime-core.ts`, `agent-v2-worker-service.ts`, and other v2 files that still import `RuntimeStore`.

- [ ] **Step 3: Create v2 store contract file**

Create `packages/web-workspace/src/agent-v2-runtime-store.ts` with:

```ts
import type {
	AgentV2ArtifactRecord,
	AgentV2DiagnosticEvent,
	AgentV2DocumentRecord,
	AgentV2RunEventRecord,
	AgentV2RunSnapshot,
	AgentV2RunUpdateResult,
	AgentV2TaskNode,
	AgentV2ValidationRecord,
} from "./agent-v2-types.js";
import type {
	CreateAgentV2RunInput,
	UpdateAgentV2RunInput,
	UpsertAgentV2ArtifactInput,
	UpsertAgentV2DocumentInput,
	UpsertAgentV2TaskInput,
	UpsertAgentV2ValidationInput,
} from "./agent-v2-store.js";

export type AgentV2StoreResult<T> = T | Promise<T>;
export type MaybeAsyncIterable<T> = AsyncIterable<T> | Iterable<T>;

export interface AgentV2SchemaStore {
	ensureAgentV2Schema(): AgentV2StoreResult<void>;
}

export interface AgentV2RunApiStore {
	createAgentV2Run(input: CreateAgentV2RunInput): AgentV2StoreResult<AgentV2RunSnapshot>;
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Runs(clientId: string, options?: { limit?: number; status?: string }): AgentV2StoreResult<AgentV2RunSnapshot[]>;
	updateAgentV2RunWithResult(
		clientId: string,
		runId: string,
		input: UpdateAgentV2RunInput,
	): AgentV2StoreResult<AgentV2RunUpdateResult>;
	upsertAgentV2Task(clientId: string, runId: string, task: UpsertAgentV2TaskInput): AgentV2StoreResult<AgentV2TaskNode>;
	upsertAgentV2Document(clientId: string, runId: string, document: UpsertAgentV2DocumentInput): AgentV2StoreResult<AgentV2DocumentRecord>;
	upsertAgentV2Artifact(clientId: string, runId: string, artifact: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	appendAgentV2Diagnostic(clientId: string, runId: string, diagnostic: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
}

export interface AgentV2RuntimeSnapshotStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Tasks(clientId: string, runId: string): AgentV2StoreResult<AgentV2TaskNode[]>;
	listAgentV2Artifacts(clientId: string, runId: string): AgentV2StoreResult<AgentV2ArtifactRecord[]>;
	listAgentV2Documents(clientId: string, runId: string): AgentV2StoreResult<AgentV2DocumentRecord[]>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
	upsertAgentV2Task(clientId: string, runId: string, task: UpsertAgentV2TaskInput): AgentV2StoreResult<AgentV2TaskNode>;
	appendAgentV2Diagnostic(clientId: string, runId: string, diagnostic: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
}

export interface AgentV2ExecutionStore extends AgentV2RuntimeSnapshotStore {
	updateAgentV2RunWithResult(
		clientId: string,
		runId: string,
		input: UpdateAgentV2RunInput,
	): AgentV2StoreResult<AgentV2RunUpdateResult>;
	upsertAgentV2Artifact(clientId: string, runId: string, artifact: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	upsertAgentV2Document(clientId: string, runId: string, document: UpsertAgentV2DocumentInput): AgentV2StoreResult<AgentV2DocumentRecord>;
	upsertAgentV2Validation(clientId: string, runId: string, validation: UpsertAgentV2ValidationInput): AgentV2StoreResult<AgentV2ValidationRecord>;
}

export interface AgentV2PlanningStore {
	upsertAgentV2Document(clientId: string, runId: string, document: UpsertAgentV2DocumentInput): AgentV2StoreResult<AgentV2DocumentRecord>;
	upsertAgentV2Task(clientId: string, runId: string, task: UpsertAgentV2TaskInput): AgentV2StoreResult<AgentV2TaskNode>;
	upsertAgentV2Artifact(clientId: string, runId: string, artifact: UpsertAgentV2ArtifactInput): AgentV2StoreResult<AgentV2ArtifactRecord>;
	appendAgentV2Diagnostic(clientId: string, runId: string, diagnostic: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
}

export interface AgentV2RunEventLogStore {
	appendAgentV2RunEvent(event: AgentV2RunEventRecord): AgentV2StoreResult<AgentV2RunEventRecord>;
	listAgentV2RunEvents(clientId: string, runId: string, options?: { limit?: number }): AgentV2StoreResult<AgentV2RunEventRecord[]>;
}

export interface AgentV2WorkerStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	updateAgentV2Run(clientId: string, runId: string, input: UpdateAgentV2RunInput): AgentV2StoreResult<AgentV2RunSnapshot>;
	updateAgentV2RunWithResult(
		clientId: string,
		runId: string,
		input: UpdateAgentV2RunInput,
	): AgentV2StoreResult<AgentV2RunUpdateResult>;
	appendAgentV2Diagnostic(clientId: string, runId: string, diagnostic: AgentV2DiagnosticEvent): AgentV2StoreResult<AgentV2DiagnosticEvent>;
	listAgentV2RunsByWorker(workerId: string, options?: { statuses?: string[] }): AgentV2StoreResult<AgentV2RunSnapshot[]>;
}

export interface AgentV2ResetStore {
	resetAgentV2RuntimeData(options?: AgentV2ResetStoreOptions): AgentV2StoreResult<AgentV2ResetStoreResult>;
}

export interface AgentV2ResetStoreOptions {
	clientId?: string;
	beforeRunCreatedAt?: string;
	includeDiagnostics?: boolean;
	confirmation: string;
}

export interface AgentV2ResetStoreResult {
	runsDeleted: number;
	tasksDeleted: number;
	artifactsDeleted: number;
	documentsDeleted: number;
	validationsDeleted: number;
	diagnosticsDeleted: number;
	runEventsDeleted: number;
}

export interface AgentV2DiagnosticExportStore {
	getAgentV2Run(clientId: string, runId: string): AgentV2StoreResult<AgentV2RunSnapshot | undefined>;
	listAgentV2Runs(clientId: string, options?: { limit?: number; status?: string }): AgentV2StoreResult<AgentV2RunSnapshot[]>;
	listAgentV2RunEvents(clientId: string, runId: string, options?: { limit?: number }): AgentV2StoreResult<AgentV2RunEventRecord[]>;
	listAgentV2Diagnostics(clientId: string, runId: string): AgentV2StoreResult<AgentV2DiagnosticEvent[]>;
}
```

If any imported type names differ in the current source, use the current type names from `agent-v2-store.ts` and `agent-v2-types.ts` and keep the same method names.

- [ ] **Step 4: Replace v2 module `RuntimeStore` imports with v2 store contracts**

Update imports and exported type aliases:

```ts
// agent-v2-run-api-service.ts
import type { AgentV2RunApiStore } from "./agent-v2-runtime-store.js";
```

Use `AgentV2RunApiStore` directly for constructor/store options instead of the local `Pick<RuntimeStore, ...>` alias.

```ts
// agent-v2-runtime-core.ts
import type { AgentV2RuntimeSnapshotStore } from "./agent-v2-runtime-store.js";
export type AgentV2RuntimeStore = AgentV2RuntimeSnapshotStore;
```

```ts
// agent-v2-execution-core.ts
import type { AgentV2ExecutionStore } from "./agent-v2-runtime-store.js";
```

```ts
// agent-v2-planning-bootstrap.ts
import type { AgentV2PlanningStore } from "./agent-v2-runtime-store.js";
```

```ts
// agent-v2-run-event-log.ts
import type { AgentV2RunEventLogStore } from "./agent-v2-runtime-store.js";
```

```ts
// agent-v2-worker-service.ts
import type { AgentV2WorkerStore } from "./agent-v2-runtime-store.js";
export type { AgentV2WorkerStore } from "./agent-v2-runtime-store.js";
```

```ts
// agent-v2-maintenance.ts
import type { AgentV2ResetStore, AgentV2ResetStoreResult } from "./agent-v2-runtime-store.js";
```

```ts
// agent-v2-reset.ts
import type {
	AgentV2ResetStore,
	AgentV2ResetStoreOptions as RuntimeStoreResetOptions,
	AgentV2ResetStoreResult as RuntimeStoreResetResult,
	AgentV2StoreResult,
} from "./agent-v2-runtime-store.js";
```

```ts
// diagnostic-export-service.ts
import type { AgentV2DiagnosticExportStore, MaybeAsyncIterable } from "./agent-v2-runtime-store.js";
```

- [ ] **Step 5: Update worker bootstrap type imports**

In `apps/pi-coding-web/src/worker/main.ts`, remove `RuntimeStore` from `runtime-infra` imports. Import v2 store types:

```ts
import type { AgentV2SchemaStore, AgentV2WorkerStore } from "@mariozechner/pi-web-workspace/runtime-infra";
```

Change:

```ts
runtimeDb: Pick<RuntimeStore, "ensureAgentV2Schema">,
```

to:

```ts
runtimeDb: AgentV2SchemaStore,
```

Change runtimeDb fields from `RuntimeStore` to `AgentV2SchemaStore & AgentV2WorkerStore`.

- [ ] **Step 6: Export v2 store contracts from v2 subpaths**

In `packages/web-workspace/src/agent-v2-runtime.ts`, add:

```ts
export type {
	AgentV2DiagnosticExportStore,
	AgentV2ExecutionStore,
	AgentV2PlanningStore,
	AgentV2ResetStore,
	AgentV2ResetStoreOptions,
	AgentV2ResetStoreResult,
	AgentV2RunApiStore,
	AgentV2RunEventLogStore,
	AgentV2RuntimeSnapshotStore,
	AgentV2SchemaStore,
	AgentV2StoreResult,
	AgentV2WorkerStore,
	MaybeAsyncIterable,
} from "./agent-v2-runtime-store.js";
```

In `packages/web-workspace/src/runtime-infra.ts`, replace `export type { RuntimeStore } from "./runtime-store.js";` with:

```ts
export type {
	AgentV2DiagnosticExportStore,
	AgentV2ResetStore,
	AgentV2RunApiStore,
	AgentV2RunEventLogStore,
	AgentV2SchemaStore,
	AgentV2WorkerStore,
} from "./agent-v2-runtime-store.js";
```

- [ ] **Step 7: Update v2 tests that use RuntimeStore only as a v2 test shape**

For tests such as `agent-v2-runtime-core.test.ts`, `agent-v2-execution-core.test.ts`, `agent-v2-maintenance.test.ts`, and `diagnostic-export-service.test.ts`, replace `import type { RuntimeStore } from "../src/runtime-store.js";` with the narrow v2 store interface that matches the tested module.

Example for runtime core:

```ts
import type { AgentV2RuntimeSnapshotStore } from "../src/agent-v2-runtime-store.js";
```

Then change helper returns from `RuntimeStore` to `AgentV2RuntimeSnapshotStore`.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-runtime-core.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-worker-service.test.ts test/diagnostic-export-service.test.ts
npm --workspace @mariozechner/pi-web-workspace run check
```

Expected: both commands PASS.

- [ ] **Step 9: Commit Task 2**

Run:

```bash
git add packages/web-workspace/src/agent-v2-runtime-store.ts packages/web-workspace/src/agent-v2-run-api-service.ts packages/web-workspace/src/agent-v2-runtime-core.ts packages/web-workspace/src/agent-v2-execution-core.ts packages/web-workspace/src/agent-v2-planning-bootstrap.ts packages/web-workspace/src/agent-v2-run-event-log.ts packages/web-workspace/src/agent-v2-worker-service.ts packages/web-workspace/src/agent-v2-maintenance.ts packages/web-workspace/src/agent-v2-reset.ts packages/web-workspace/src/diagnostic-export-service.ts packages/web-workspace/src/agent-v2-runtime.ts packages/web-workspace/src/runtime-infra.ts apps/pi-coding-web/src/worker/main.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts packages/web-workspace/test/*agent-v2*.test.ts packages/web-workspace/test/diagnostic-export-service.test.ts
git commit -m "refactor: isolate v2 runtime store contracts"
```

---

### Task 3: Delete Legacy v1 Generation Services and Tests

**Files:**
- Delete: `packages/web-workspace/src/run-api-service.ts`
- Delete: `packages/web-workspace/src/run-api-service.js`
- Delete: `packages/web-workspace/src/run-api-service.js.map`
- Delete: `packages/web-workspace/src/run-worker-service.ts`
- Delete: `packages/web-workspace/src/run-worker-service.js`
- Delete: `packages/web-workspace/src/run-worker-service.js.map`
- Delete: `packages/web-workspace/src/app-preview-goal-service.ts`
- Delete: `packages/web-workspace/src/app-preview-goal-service.js`
- Delete: `packages/web-workspace/src/app-preview-goal-service.js.map`
- Delete: `packages/web-workspace/src/app-preview-goal-supervisor.ts`
- Delete: `packages/web-workspace/src/app-preview-goal-supervisor.js`
- Delete: `packages/web-workspace/src/app-preview-goal-supervisor.js.map`
- Delete: `packages/web-workspace/test/run-api-service.test.ts`
- Delete: `packages/web-workspace/test/run-worker-service.test.ts`
- Delete: `packages/web-workspace/test/app-preview-goal-service.test.ts`
- Delete: `packages/web-workspace/test/app-preview-goal-supervisor.test.ts`
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify tests that import deleted services.

**Interfaces:**
- Consumes: v2 run API and static legacy route responses already present in `vite-plugin.ts`.
- Produces: deleted v1 service files and deleted v1 service test suite. No runtime fallback remains in this branch.

- [ ] **Step 1: Add deleted-file boundary assertions**

In `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`, add:

```ts
const deletedLegacyGenerationFiles = [
	"packages/web-workspace/src/app-preview-goal-service.ts",
	"packages/web-workspace/src/app-preview-goal-supervisor.ts",
	"packages/web-workspace/src/run-api-service.ts",
	"packages/web-workspace/src/run-worker-service.ts",
	"packages/web-workspace/test/app-preview-goal-service.test.ts",
	"packages/web-workspace/test/app-preview-goal-supervisor.test.ts",
	"packages/web-workspace/test/run-api-service.test.ts",
	"packages/web-workspace/test/run-worker-service.test.ts",
];
```

Add:

```ts
it("removes legacy v1 generation services and their dedicated tests", () => {
	for (const file of deletedLegacyGenerationFiles) {
		expect(existsSync(join(repoRoot, file)), `${file} must be deleted`).toBe(false);
	}
});
```

- [ ] **Step 2: Run the focused boundary test and verify it fails**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL because the old source/test files still exist.

- [ ] **Step 3: Remove old RunApiError handling from configured plugin**

In `packages/web-workspace/src/vite-plugin.ts`, remove:

```ts
import { RunApiError } from "./run-api-service.js";
```

In `sendRuntimeApiError`, delete the branch:

```ts
if (error instanceof RunApiError) {
	sendJson(res, error.status, { error: error.message });
	return;
}
```

Keep the `AgentV2RunApiError` handling branch.

- [ ] **Step 4: Delete old source and generated source files**

Delete the source and mirror JavaScript files listed in this task. Use `git rm` or the platform edit tool for deletions. The final `git status --short` must show these paths as deleted.

- [ ] **Step 5: Delete old v1 service tests**

Delete the four old test files listed in this task. If another test imports `WorkspaceRunApiService`, `WorkspaceRunWorkerService`, `AppPreviewGoalService`, `AppPreviewGoalSupervisor`, or `RunApiError`, replace that test with a v2 assertion or delete it when it only covered removed v1 behavior.

- [ ] **Step 6: Run import search for deleted symbols**

Run:

```bash
rg "WorkspaceRunApiService|WorkspaceRunWorkerService|AppPreviewGoalService|AppPreviewGoalSupervisor|RunApiError|run-api-service|run-worker-service|app-preview-goal-service|app-preview-goal-supervisor" packages apps
```

Expected: only boundary deny strings, deleted-file assertion strings, or documentation references remain. No production import may remain.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
npm --workspace @mariozechner/pi-web-workspace run check
```

Expected: both commands PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add packages/web-workspace/src/vite-plugin.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts
git add -u packages/web-workspace/src packages/web-workspace/test apps/pi-coding-web/test
git commit -m "refactor: remove legacy generation services"
```

---

### Task 4: Worker and Test Suite v2 Boundary Cleanup

**Files:**
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify: `apps/pi-coding-web/test/worker-attachment-runtime.test.ts`
- Modify: `packages/web-workspace/test/run-queue-redis.integration.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify package tests that still import old queue or runtime contracts at their public boundary.

**Interfaces:**
- Consumes: `createRedisAgentV2RunQueue`, `AgentV2SchemaStore`, `AgentV2WorkerStore`, and v2 runtime exports from Tasks 1 and 2.
- Produces: worker tests that verify the real worker path is v2-only, while Redis queue/cancel-key infrastructure remains covered through v2 adapter names.

- [ ] **Step 1: Add worker/import boundary assertions**

In `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`, extend the worker import test:

```ts
expect(source).not.toContain("RedisRunQueue");
expect(source).not.toContain("RuntimeStore");
expect(source).toContain("createRedisAgentV2RunQueue");
expect(source).toContain("AgentV2SchemaStore");
expect(source).toContain("AgentV2WorkerStore");
```

- [ ] **Step 2: Run focused boundary test and verify it fails if worker still leaks old names**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL if `apps/pi-coding-web/src/worker/main.ts` still contains `RedisRunQueue` or `RuntimeStore`.

- [ ] **Step 3: Update worker bootstrap types**

In `apps/pi-coding-web/src/worker/main.ts`, make the top imports use:

```ts
import {
	AgentV2RunEventLog,
	AgentV2WorkerService,
	type AgentV2WorkerStore,
	RedisAgentV2RunEventBus,
	type AgentV2RunQueue,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import {
	createRedisAgentV2RunQueue,
	createRuntimeStore,
	type AgentV2SchemaStore,
	type DiagnosticLogEventInput,
	type JsonObject,
	loadStorageConfig,
	type StorageConfig,
	WorkspaceDiagnosticLogService,
} from "@mariozechner/pi-web-workspace/runtime-infra";
```

Then ensure the runtime bootstrap values use:

```ts
const runtimeDb = createRuntimeStore(config) as AgentV2SchemaStore & AgentV2WorkerStore;
const runQueue: AgentV2RunQueue = createRedisAgentV2RunQueue({
	redisUrl: config.redisUrl,
	queueName: config.runQueueName,
	claimLeaseTtlMs: config.agentV2WorkerLeaseMs,
	cancelTtlSeconds: config.runCancelTtlSeconds,
});
```

- [ ] **Step 4: Update Redis queue integration tests to v2 adapter names**

In `packages/web-workspace/test/run-queue-redis.integration.test.ts`, if the test still constructs `new RedisRunQueue(...)` to prove worker-facing behavior, change the public tested object to:

```ts
import { createRedisAgentV2RunQueue } from "../src/agent-v2-run-queue.js";
```

Construct:

```ts
const queue = createRedisAgentV2RunQueue({
	redisUrl,
	queueName,
	claimLeaseTtlMs: 50,
	cancelTtlSeconds: 1,
});
```

Keep direct `RedisRunQueue` tests only if the file is explicitly validating adapter internals. If it imports deleted worker services, remove those cases and replace with v2 worker service coverage.

- [ ] **Step 5: Update app worker tests**

In `apps/pi-coding-web/test/worker-attachment-runtime.test.ts`, remove old `WorkspaceRunApiService` imports or assertions. Replace them with assertions that worker runtime wiring imports `@mariozechner/pi-web-workspace/agent-v2-runtime` and `@mariozechner/pi-web-workspace/runtime-infra`, and does not import `@mariozechner/pi-web-workspace` root.

- [ ] **Step 6: Run worker and queue focused tests**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts test/run-queue-redis.integration.test.ts
npm --workspace @mariozechner/pi-coding-web exec vitest --run test/worker-attachment-runtime.test.ts
```

Expected: commands PASS. If the Redis integration test skips because Redis is unavailable, the skip must be the test's existing environment guard and not a TypeScript/import failure.

- [ ] **Step 7: Run package checks**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
npm --workspace @mariozechner/pi-coding-web run build:worker
```

Expected: both commands PASS.

- [ ] **Step 8: Commit Task 4**

Run:

```bash
git add apps/pi-coding-web/src/worker/main.ts apps/pi-coding-web/test/worker-attachment-runtime.test.ts packages/web-workspace/test/run-queue-redis.integration.test.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts
git commit -m "refactor: keep worker runtime on v2 contracts"
```

---

### Task 5: Final Verification and Legacy Surface Audit

**Files:**
- Modify only if verification reveals a concrete remaining legacy import or stale generated source.
- Test: package-level test/check/build commands.

**Interfaces:**
- Consumes: all previous task commits.
- Produces: a verified Phase 7 branch ready for final review and eventual merge decision.

- [ ] **Step 1: Run legacy string audit**

Run:

```bash
rg "PI_APP_AGENT_VERSION|WorkspaceRunApiService|WorkspaceRunWorkerService|AppPreviewGoalService|AppPreviewGoalSupervisor|RunApiError|StartRunRequest|StartRunResult|WorkerAgentInput|RuntimeStore|RedisRunQueue|run-api-service|run-worker-service|app-preview-goal-service|app-preview-goal-supervisor" packages/web-workspace/src apps/pi-coding-web/src packages/web-workspace/test apps/pi-coding-web/test
```

Expected:
- `RuntimeStore` may remain only in concrete persistence implementation files such as `runtime-store.ts`, `runtime-db.ts`, `postgres-runtime-store.ts`, `runtime-store-factory.ts`, and tests that explicitly validate concrete persistence contracts.
- `RedisRunQueue` may remain only inside `agent-v2-run-queue.ts`, `run-queue.ts`, and tests that explicitly validate the adapter implementation.
- Deleted v1 service names may remain only inside boundary deny strings or docs.

- [ ] **Step 2: Run web-workspace full test suite**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace test
```

Expected: PASS.

- [ ] **Step 3: Run app package focused test suite**

Run:

```bash
npm --workspace @mariozechner/pi-coding-web exec vitest --run
```

Expected: PASS.

- [ ] **Step 4: Run build checks**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace @mariozechner/pi-coding-web run build:worker
```

Expected: all commands PASS.

- [ ] **Step 5: Run whitespace diff check**

Run:

```bash
git diff --check
```

Expected: no output and exit code 0.

- [ ] **Step 6: Commit verification-only fixes if needed**

If a command reveals a concrete issue, fix the smallest affected files, rerun the failing command plus `git diff --check`, and commit:

```bash
git add <affected files>
git commit -m "fix: complete agent v2 phase 7 verification"
```

- [ ] **Step 7: Prepare final review package**

Run:

```bash
git merge-base vibecoding-platform HEAD
```

Use the printed SHA as `MERGE_BASE`, then run the subagent-driven review package script:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\admin\.codex\plugins\cache\openai-curated-remote\superpowers\6.1.1\skills\subagent-driven-development\scripts\review-package.ps1 MERGE_BASE HEAD
```

If the PowerShell script does not exist, use the shell script from the same directory through the available shell. The review package must include the full branch diff from Phase 7 base to `HEAD`.

- [ ] **Step 8: Commit Task 5 only when verification changed files**

If no files changed during final verification, do not create an empty commit. Record the verified commands in the subagent report and controller final summary.

---

## Self-Review

**Spec coverage:** The plan removes v1 compatibility goals, deletes old generation services/tests, replaces legacy public exports, and adds v2-specific store/queue interfaces while preserving approved infrastructure adapters.

**Placeholder scan:** The plan contains exact file paths, exact names, concrete test commands, and commit commands. It contains no placeholder tasks.

**Type consistency:** Queue contracts use `AgentV2RunQueue*` names. Store contracts use `AgentV2*Store` names and match existing v2 method names discovered from the codebase.
