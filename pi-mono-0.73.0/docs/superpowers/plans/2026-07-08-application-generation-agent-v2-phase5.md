# Application Generation Agent v2 Phase 5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Application Generation Agent v2 to a real run API, Redis queue, worker lifecycle, cancel path, and SSE/live replay path without depending on v1 agent state, prompt flow, preview-goal repair, or legacy run/session/message semantics.

**Architecture:** Phase 5 creates a v2 production spine with its own run gateway, queue envelope, event log, live bus, and worker orchestrator. Existing infrastructure is reused only where the Module is deep and not semantically tied to v1: Redis queue primitives, PostgreSQL/SQLite schema management, worker process lifecycle hooks, diagnostics, and static validation/build adapters. v1 `WorkspaceRunApiService`, `WorkspaceRunWorkerService`, `RunEventSink` message side effects, `AppPreviewGoalService`, and `createRunAgent` are not the v2 Interface.

**Tech Stack:** TypeScript, Vitest, SQLite `node:sqlite`, PostgreSQL `pg`, Redis streams/lists via `redis`, Vite Connect middleware, existing `packages/web-workspace` runtime store patterns.

## Global Constraints

- Use codegraph before changing project code; if codegraph is unavailable in the worktree, initialize or repair it first.
- Use TDD for every production behavior change: write the failing test, run it and observe the expected failure, implement, then rerun.
- Do not make v2 depend on legacy agent prompt flow, legacy spec/plan/task file generation, app preview goal continuation repair, or legacy session/message replay.
- Do not migrate old run/session/message/app-preview-goal data into v2.
- v2 run data must live in `agent_v2_*` tables and must not read legacy `runs`, `run_events`, `sessions`, `messages`, `app_preview_goals`, or `app_preview_goal_events`.
- Reuse old infrastructure only after it passes the Module review in this plan.
- If `PI_APP_AGENT_VERSION=v1/v2` remains, it is a short-term development/debug switch only; default is v2 and the final plan is to remove v1.
- Do not run root dev/build/test commands that start long-lived servers. Package-level Vitest/check/build and root `npm run check` are allowed.
- Manual file edits use `apply_patch`; generated `.js`/`.map` files may be produced by the TypeScript build.

---

## Architecture Review: Existing Production Chain

### Run API

**Files reviewed:** `packages/web-workspace/src/run-api-service.ts`, `packages/web-workspace/src/vite-plugin.ts`.

**Judgment:** Do not reuse as v2 Interface.

`WorkspaceRunApiService` is a shallow Module for v2: its Interface exposes old session/message creation, continuation metadata, project-file seeding, app-preview-goal operations, stalled legacy run reconciliation, legacy cancellation, and old event listing. Deleting it would not make v2 complexity reappear in one place; it would remove unrelated v1 behavior that v2 must not inherit. Phase 5 adds `AgentV2RunApiService` and a separate HTTP route handler.

### Redis Run Queue And Cancel Key

**Files reviewed:** `packages/web-workspace/src/run-queue.ts`, `packages/web-workspace/test/run-queue.test.ts`.

**Judgment:** Reuse as a low-level Adapter behind a v2 queue envelope.

`RunQueue` is deep enough: `enqueue`, `claim`, `complete`, `requeueActive`, `requestCancel`, `isCancelRequested`, and `close` hide Redis list/hash/cancel-key implementation. The old leak is `RunQueueItem` accepting a raw string and sharing `runQueueName`. Phase 5 adds `AgentV2RunQueue` so v2 uses `{ clientId, runId }` only and a dedicated queue name, defaulting to `PI_AGENT_V2_RUN_QUEUE_NAME` or `pi:agent-v2:runs`.

### Worker Lifecycle

**Files reviewed:** `packages/web-workspace/src/run-worker-service.ts`, `apps/pi-coding-web/src/worker/main.ts`.

**Judgment:** Do not reuse as v2 Interface.

`WorkspaceRunWorkerService` has useful operational ideas, but its Interface is `WorkerAgent(prompt/continue/abort)`, plus retry logic built around replayable assistant messages and app-preview-goal terminal handling. That is a v1 shape. Phase 5 creates `AgentV2WorkerService` around `AgentV2ExecutionCore`, v2 task graph state, v2 validation/repair, and v2 diagnostics.

### SSE Live Event And Replay

**Files reviewed:** `packages/web-workspace/src/run-event-bus.ts`, `packages/web-workspace/src/run-event-sink.ts`, `packages/web-workspace/src/agent-v2-run-events.ts`, `packages/web-workspace/src/postgres-runtime-store.ts`.

**Judgment:** Reuse the Redis stream pattern, not the legacy event table or sink semantics.

`RunEventBus` is a good live-read idea, but its record shape includes `sessionId` and its stream key is legacy run/session scoped. `RunEventSink` persists to `run_events`, which has a foreign key to legacy `runs`, and appends legacy assistant messages on `message_end`. v2 must not create shadow legacy rows to satisfy that Interface. Phase 5 adds `agent_v2_run_events`, `AgentV2RunEventBus`, and `AgentV2RunEventLog`, using v2 record shape and v2 stream keys.

## File Structure

- Create `packages/web-workspace/src/agent-v2-run-queue.ts`: v2 queue envelope over `RunQueue`.
- Create `packages/web-workspace/test/agent-v2-run-queue.test.ts`: queue envelope tests.
- Modify `packages/web-workspace/src/config.ts`: add v2 agent version, v2 queue, v2 event stream config.
- Modify `packages/web-workspace/src/types.ts`: add config fields.
- Modify `packages/web-workspace/src/agent-v2-store.ts`: add v2 event row/record builders.
- Modify `packages/web-workspace/src/runtime-store.ts`: add v2 event store methods.
- Modify `packages/web-workspace/src/runtime-db.ts`: add SQLite `agent_v2_run_events` schema and methods.
- Modify `packages/web-workspace/src/postgres-runtime-store.ts`: add PostgreSQL `agent_v2_run_events` schema and methods.
- Create `packages/web-workspace/src/agent-v2-run-event-bus.ts`: v2 in-memory and Redis live event bus.
- Create `packages/web-workspace/src/agent-v2-run-event-log.ts`: append-once event log that persists to v2 store and publishes live events.
- Create `packages/web-workspace/test/agent-v2-run-events.test.ts`: event log, replay, Redis-key shape, and durability tests.
- Create `packages/web-workspace/src/agent-v2-run-api-service.ts`: v2 run gateway Module.
- Create `packages/web-workspace/test/agent-v2-run-api-service.test.ts`: v2 run API behavior tests.
- Create `packages/web-workspace/src/agent-v2-worker-service.ts`: v2 worker lifecycle Module.
- Create `packages/web-workspace/test/agent-v2-worker-service.test.ts`: worker lifecycle/cancel/recovery tests.
- Modify `packages/web-workspace/src/vite-plugin.ts`: add v2 HTTP route handler and legacy route disabling when v2 is default.
- Create `packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts`: route-level tests.
- Modify `apps/pi-coding-web/src/worker/main.ts`: bootstrap v2 worker by default; isolate v1 worker behind short-term dev flag.
- Modify `apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts`: update worker startup diagnostics expectations.
- Create `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`: prove Phase 5 production path does not import v1 agent Modules.

### Task 1: v2 Queue Envelope And Config

**Files:**
- Create: `packages/web-workspace/src/agent-v2-run-queue.ts`
- Create: `packages/web-workspace/test/agent-v2-run-queue.test.ts`
- Modify: `packages/web-workspace/src/config.ts`
- Modify: `packages/web-workspace/src/types.ts`

**Interfaces:**
- Consumes: `RunQueue`, `RunQueueItem`, `ClaimedRun` from `packages/web-workspace/src/run-queue.ts`.
- Produces:
  - `AgentV2RunQueueIdentity = { clientId: string; runId: string }`
  - `AgentV2ClaimedRun = AgentV2RunQueueIdentity`
  - `AgentV2RunQueue` with `enqueue`, `claim`, `complete`, `requeueActive`, `requestCancel`, `isCancelRequested`, `close`
  - `createAgentV2RunQueue(queue: RunQueue): AgentV2RunQueue`
  - config fields `appAgentVersion`, `agentV2RunQueueName`, `agentV2RunEventStreamMaxLen`, `agentV2RunEventStreamTtlSeconds`

- [ ] **Step 1: Write failing queue envelope tests**

Add `packages/web-workspace/test/agent-v2-run-queue.test.ts` with these test cases:

```typescript
import { describe, expect, test } from "vitest";
import { InMemoryRunQueue } from "../src/run-queue.js";
import { createAgentV2RunQueue } from "../src/agent-v2-run-queue.js";

describe("AgentV2RunQueue", () => {
	test("claims only structured v2 identities", async () => {
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		await queue.enqueue({ clientId: "client-a", runId: "run-1" });

		await expect(queue.claim("worker-a", 0)).resolves.toEqual({ clientId: "client-a", runId: "run-1" });
	});

	test("rejects legacy raw string queue claims", async () => {
		const base = new InMemoryRunQueue();
		await base.enqueue("legacy-run");
		const queue = createAgentV2RunQueue(base);

		await expect(queue.claim("worker-a", 0)).rejects.toThrow("Agent v2 queue claim is missing clientId");
	});

	test("uses cancel key through the wrapped queue", async () => {
		const queue = createAgentV2RunQueue(new InMemoryRunQueue());
		const run = { clientId: "client-a", runId: "run-1" };
		await queue.enqueue(run);
		await queue.requestCancel(run);

		await expect(queue.isCancelRequested(run)).resolves.toBe(true);
		await expect(queue.claim("worker-a", 0)).resolves.toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-queue.test.ts
```

Expected: FAIL because `agent-v2-run-queue.js` does not exist.

- [ ] **Step 3: Implement v2 queue envelope and config**

Create `agent-v2-run-queue.ts` with a thin but strict Adapter. It must never accept raw string v2 identities and must throw when a wrapped claim lacks `clientId`.

Update `config.ts`/`types.ts`:

```typescript
appAgentVersion: stringValue(env("PI_APP_AGENT_VERSION")) === "v1" ? "v1" : "v2",
agentV2RunQueueName: stringValue(env("PI_AGENT_V2_RUN_QUEUE_NAME")) || "pi:agent-v2:runs",
agentV2RunEventStreamMaxLen: positiveIntegerValue(env("PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN"), 5000),
agentV2RunEventStreamTtlSeconds: positiveIntegerValue(env("PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS"), 3600),
```

Add matching `StorageConfig` fields.

- [ ] **Step 4: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-queue.test.ts test/run-queue.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-workspace/src/agent-v2-run-queue.ts packages/web-workspace/test/agent-v2-run-queue.test.ts packages/web-workspace/src/config.ts packages/web-workspace/src/types.ts
git commit -m "feat: add agent v2 run queue envelope"
```

### Task 2: v2 Event Store And Runtime Schema

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-store.ts`
- Modify: `packages/web-workspace/src/runtime-store.ts`
- Modify: `packages/web-workspace/src/runtime-db.ts`
- Modify: `packages/web-workspace/src/postgres-runtime-store.ts`
- Create: `packages/web-workspace/test/agent-v2-run-event-store.test.ts`

**Interfaces:**
- Produces:
  - `AgentV2RunEventRecord`
  - `AppendAgentV2RunEventInput`
  - `listAgentV2RunEvents(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> | AgentV2RunEventRecord[]`
  - `appendAgentV2RunEvent(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> | AgentV2RunEventRecord`

- [ ] **Step 1: Write failing store tests**

Add tests that create a v2 run, append two v2 events, list with `afterSeq = 0`, list with `afterSeq = 1`, and assert that resetting v2 data removes v2 events without reading legacy `run_events`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-event-store.test.ts
```

Expected: FAIL because runtime store methods and schema do not exist.

- [ ] **Step 3: Add schema and mappers**

Add table `agent_v2_run_events` to SQLite and PostgreSQL schemas:

```sql
CREATE TABLE IF NOT EXISTS agent_v2_run_events (
	client_id TEXT NOT NULL,
	run_id TEXT NOT NULL,
	seq INTEGER NOT NULL,
	event_type TEXT NOT NULL,
	payload_json JSONB NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (client_id, run_id, seq),
	FOREIGN KEY (client_id, run_id) REFERENCES agent_v2_runs(client_id, run_id)
)
```

SQLite uses `TEXT NOT NULL` for `payload_json`. PostgreSQL uses `JSONB NOT NULL`.

Include `agent_v2_run_events` in reset table ordering before `agent_v2_runs`.

- [ ] **Step 4: Add append/list methods**

Use transaction semantics matching existing v2 store methods. If `seq` is omitted, compute `MAX(seq) + 1` scoped to `{ clientId, runId }`.

- [ ] **Step 5: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-event-store.test.ts test/agent-v2-validation-store.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/src/agent-v2-store.ts packages/web-workspace/src/runtime-store.ts packages/web-workspace/src/runtime-db.ts packages/web-workspace/src/postgres-runtime-store.ts packages/web-workspace/test/agent-v2-run-event-store.test.ts
git commit -m "feat: add agent v2 run event store"
```

### Task 3: v2 Live Event Bus And Event Log

**Files:**
- Create: `packages/web-workspace/src/agent-v2-run-event-bus.ts`
- Create: `packages/web-workspace/src/agent-v2-run-event-log.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-events.ts`
- Create: `packages/web-workspace/test/agent-v2-run-event-bus.test.ts`
- Create: `packages/web-workspace/test/agent-v2-run-event-log.test.ts`

**Interfaces:**
- Consumes: v2 event store methods from Task 2.
- Produces:
  - `AgentV2LiveRunEvent`
  - `AgentV2RunEventReadRequest`
  - `AgentV2RunEventBus`
  - `InMemoryAgentV2RunEventBus`
  - `RedisAgentV2RunEventBus`
  - `agentV2RunEventStreamKey({ clientId, runId })`
  - `AgentV2RunEventLog.append(input)`
  - `AgentV2RunEventLog.list(clientId, runId, afterSeq)`
  - `AgentV2RunEventLog.readLive(request)`

- [ ] **Step 1: Write failing bus tests**

Test that the in-memory bus reads only events with `seq > afterSeq`, Redis stream keys are `pi:agent-v2:runs:<clientId>:<runId>:events`, and `close()` prevents future reads/writes.

- [ ] **Step 2: Write failing event-log tests**

Test that appending through `AgentV2RunEventLog` persists to store and publishes to bus, replay reads durable store first, and live read does not require legacy `sessionId`.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-event-bus.test.ts test/agent-v2-run-event-log.test.ts
```

Expected: FAIL because new Modules do not exist.

- [ ] **Step 4: Implement bus and event log**

Use `run-event-bus.ts` as an implementation reference, but do not import `RuntimeRunEventRecord`, `RunEventBus`, `RunEventSink`, or legacy stream-key helpers. v2 event records must be independent of `sessionId`.

- [ ] **Step 5: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-event-bus.test.ts test/agent-v2-run-event-log.test.ts test/run-event-bus.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/src/agent-v2-run-event-bus.ts packages/web-workspace/src/agent-v2-run-event-log.ts packages/web-workspace/src/agent-v2-run-events.ts packages/web-workspace/test/agent-v2-run-event-bus.test.ts packages/web-workspace/test/agent-v2-run-event-log.test.ts
git commit -m "feat: add agent v2 live event log"
```

### Task 4: v2 Run Gateway

**Files:**
- Create: `packages/web-workspace/src/agent-v2-run-api-service.ts`
- Create: `packages/web-workspace/test/agent-v2-run-api-service.test.ts`

**Interfaces:**
- Consumes: v2 runtime store, `AgentV2RunQueue`, `AgentV2RunEventLog`.
- Produces:
  - `AgentV2StartRunRequest`
  - `AgentV2RunApiService.startRun(clientId, request)`
  - `AgentV2RunApiService.cancelRun(clientId, runId)`
  - `AgentV2RunApiService.getRun(clientId, runId)`
  - `AgentV2RunApiService.listRuns(clientId)`
  - `AgentV2RunApiService.listRunEvents(clientId, runId, afterSeq)`

- [ ] **Step 1: Write failing run gateway tests**

Test:
- start creates an `agent_v2_runs` row in `queued`;
- start enqueues exactly `{ clientId, runId }`;
- start emits `agent_v2.run_created`;
- cancel on queued run requests queue cancel, marks `cancelled`, and emits phase/status event;
- cancel on running run marks `cancelling`;
- list/get only read `agent_v2_runs`.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-api-service.test.ts
```

Expected: FAIL because `agent-v2-run-api-service.js` does not exist.

- [ ] **Step 3: Implement gateway**

The gateway must not import `WorkspaceRunApiService`, `AppPreviewGoalService`, `StartRunRequest`, or legacy session/message helpers. Use `randomUUID()` for run IDs unless request supplies a deterministic test ID.

- [ ] **Step 4: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-run-api-service.test.ts test/agent-v2-run-event-log.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-workspace/src/agent-v2-run-api-service.ts packages/web-workspace/test/agent-v2-run-api-service.test.ts
git commit -m "feat: add agent v2 run gateway"
```

### Task 5: v2 Worker Lifecycle

**Files:**
- Create: `packages/web-workspace/src/agent-v2-worker-service.ts`
- Create: `packages/web-workspace/test/agent-v2-worker-service.test.ts`

**Interfaces:**
- Consumes: `AgentV2RunQueue`, v2 store methods, `AgentV2ExecutionCore`, `AgentV2RunEventLog`.
- Produces:
  - `AgentV2WorkerService.start()`
  - `AgentV2WorkerService.stop()`
  - `AgentV2WorkerService.processOne()`
  - `AgentV2WorkerService.recoverOwnedRuns()`

- [ ] **Step 1: Write failing worker tests**

Test:
- claims queued v2 run and transitions `queued -> running -> completed`;
- terminal failure stores v2 error and emits diagnostic event;
- cancellation before claim becomes `cancelled`;
- cancellation while running aborts execution and becomes `cancelled`;
- stop marks owned running/cancelling runs `interrupted`;
- recovery requeues owned active queue claims and marks owned v2 running runs `interrupted`.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts
```

Expected: FAIL because `agent-v2-worker-service.js` does not exist.

- [ ] **Step 3: Implement worker**

Do not import `WorkspaceRunWorkerService`, `WorkerAgent`, `createRunAgent`, `RunRetryController`, or `AppPreviewGoalSupervisor`. Model retry/repair through existing v2 execution core behavior, not v1 assistant replay semantics.

- [ ] **Step 4: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-worker-service.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-task-engine.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-workspace/src/agent-v2-worker-service.ts packages/web-workspace/test/agent-v2-worker-service.test.ts
git commit -m "feat: add agent v2 worker lifecycle"
```

### Task 6: HTTP/SSE Routes, Worker Bootstrap, And Legacy Isolation

**Files:**
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Create: `packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify: `apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts`
- Create: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:**
- Consumes: `AgentV2RunApiService`, `AgentV2RunEventBus`, `AgentV2WorkerService`.
- Produces:
  - HTTP prefix `/api/runtime/agent-v2/runs`
  - `POST /api/runtime/agent-v2/runs/start`
  - `GET /api/runtime/agent-v2/runs`
  - `GET /api/runtime/agent-v2/runs/:runId`
  - `POST /api/runtime/agent-v2/runs/:runId/cancel`
  - `GET /api/runtime/agent-v2/runs/:runId/events?afterSeq=N`
  - SSE for the same events route when `Accept: text/event-stream`

- [ ] **Step 1: Write failing route tests**

Test:
- v2 route starts a run and returns v2 snapshot;
- v2 events route replays durable events as JSON;
- v2 events route streams live events as SSE;
- when `appAgentVersion` is `v2`, legacy `POST /api/runtime/runs/start` returns `410` with a message that the legacy run path is disabled;
- app-preview-goal routes are unavailable in v2 default mode.

- [ ] **Step 2: Write failing import-boundary test**

Assert production v2 files do not import these strings:

```text
run-api-service
run-worker-service
app-preview-goal-service
capability-planner
spec-artifact
context-orchestrator
preview-goal
createRunAgent
RunEventSink
WorkspaceRunApiService
WorkspaceRunWorkerService
```

The test may contain those strings only inside its deny-list fixture.

- [ ] **Step 3: Run tests to verify failure**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-vite-plugin-routes.test.ts test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL because routes and boundary enforcement do not exist.

- [ ] **Step 4: Implement route and bootstrap integration**

Add a v2 route branch before legacy run routing. Keep `PI_APP_AGENT_VERSION=v1` only as a short-term debug path in worker bootstrap and route setup. The default must be `v2`.

In `apps/pi-coding-web/src/worker/main.ts`, create v2 queue with `config.agentV2RunQueueName`, v2 live event bus with v2 stream settings, and `AgentV2WorkerService` by default. Keep the old worker creation behind `if (config.appAgentVersion === "v1")`.

- [ ] **Step 5: Run tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-vite-plugin-routes.test.ts test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-worker-service.test.ts
cd ../../apps/pi-coding-web
npm run check
cd ../../packages/web-workspace
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/src/vite-plugin.ts packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts apps/pi-coding-web/src/worker/main.ts apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts
git commit -m "feat: wire agent v2 runtime routes and worker"
```

## Final Verification

- [ ] Run focused v2 backend tests:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run \
  test/agent-v2-run-queue.test.ts \
  test/agent-v2-run-event-store.test.ts \
  test/agent-v2-run-event-bus.test.ts \
  test/agent-v2-run-event-log.test.ts \
  test/agent-v2-run-api-service.test.ts \
  test/agent-v2-worker-service.test.ts \
  test/agent-v2-vite-plugin-routes.test.ts \
  test/agent-v2-production-path-import-boundary.test.ts \
  test/agent-v2-execution-core.test.ts \
  test/agent-v2-validation-gate.test.ts \
  test/agent-v2-task-engine.test.ts
```

- [ ] Run package checks:

```bash
cd packages/web-workspace
npm run check
npm run build
cd ../../apps/pi-coding-web
npm run check
```

- [ ] Run root check:

```bash
npm run check
```

- [ ] Inspect import boundary:

```bash
rg "run-api-service|run-worker-service|app-preview-goal-service|capability-planner|spec-artifact|context-orchestrator|preview-goal|createRunAgent|RunEventSink|WorkspaceRunApiService|WorkspaceRunWorkerService" packages/web-workspace/src/agent-v2-*.ts apps/pi-coding-web/src/worker/main.ts
```

Expected: only allowed hits in short-term v1 debug branch of `apps/pi-coding-web/src/worker/main.ts`; no hits in `packages/web-workspace/src/agent-v2-*.ts`.

## Self-Review

- Spec coverage: The plan covers the requested review of current run API, Redis queue, worker lifecycle, cancel key, SSE live/replay, and then implements v2-specific replacements/adapters.
- Placeholder scan: No task uses TBD/TODO/fill-in placeholders; every task has exact files, interfaces, and test commands.
- Type consistency: Queue, event, gateway, worker, and route task interfaces all use `{ clientId, runId }` and `agent_v2_*` state, not legacy session/message state.
