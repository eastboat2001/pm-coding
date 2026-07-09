# Application Generation Agent v2 Phase 8 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the real Application Generation Agent v2 production chain with fault-injection and rehearsal tests for queue/cancel/replay, worker crash/restart/reclaim, diagnostic export/Langfuse/SSE, and v2 schema reset/startup.

**Architecture:** Phase 8 adds production-shape test harnesses around v2-named contracts. The default outcome should be stronger acceptance coverage; production code changes are allowed only when a failing rehearsal exposes a concrete v2 adapter or lifecycle bug. No task may reintroduce v1 generation services, v1 fallback routing, or old run/session/message/app-preview-goal compatibility.

**Tech Stack:** TypeScript, Vitest, tsgo, SQLite runtime store, optional Redis/PostgreSQL integration guards, v2 run API, v2 run queue adapter, v2 worker service, v2 run event log/bus, diagnostic export service.

## Global Constraints

- Do not preserve or reintroduce v1 generation agent compatibility paths.
- Do not use `PI_APP_AGENT_VERSION` as a formal runtime path.
- Do not migrate old v1 run/session/message/app-preview-goal test data.
- Prefer new v2 test harnesses over patching old tests.
- Reuse infrastructure only through v2 or infra adapter boundaries: runtime store, Redis queue/cancel/live events, worker lifecycle, run event persistence/SSE replay, diagnostics/Langfuse, static build/validate/preview, deployment config.
- If an old module is considered for reuse, first verify it is an infrastructure adapter and not product behavior from v1.
- External Redis/PostgreSQL tests must be environment-gated; they may skip only because the external service is unavailable.
- Do not push the branch. Finish local development and verification first.
- Use codegraph first for project structure and code lookup. If codegraph fails in a worktree, initialize or repair it before falling back to other search methods.

---

## File Structure

- `docs/superpowers/specs/2026-07-09-application-generation-agent-v2-phase8-design.md`: committed design spec for this phase.
- `packages/web-workspace/test/agent-v2-production-chain.test.ts`: new local production-chain rehearsal using real v2 API, worker, event log, event bus, runtime DB, diagnostic export, and reset.
- `packages/web-workspace/test/agent-v2-worker-service.test.ts`: targeted worker crash/restart/reclaim and lease-loss assertions if not already covered.
- `packages/web-workspace/test/run-events-sse.test.ts`: targeted SSE replay and live bus failure assertions if not already covered.
- `packages/web-workspace/test/diagnostic-export-service.test.ts`: targeted v2 run-only export and archive/Langfuse-adjacent acceptance if not already covered.
- `packages/web-workspace/test/vite-plugin-schema-init.test.ts` or `packages/web-workspace/test/runtime-store-factory.test.ts`: production startup/reset rehearsal assertions if the new production-chain test does not cover them cleanly.
- `packages/web-workspace/src/*.ts`: modify only when a Phase 8 failing test exposes a real v2 lifecycle bug.
- Generated source mirrors under `packages/web-workspace/src/*.js` and `*.js.map`: sync only after source changes and build verification.

---

### Task 1: v2 Production Chain Rehearsal Harness

**Files:**
- Create: `packages/web-workspace/test/agent-v2-production-chain.test.ts`
- Modify only if exposed by the test: `packages/web-workspace/src/agent-v2-run-api-service.ts`
- Modify only if exposed by the test: `packages/web-workspace/src/agent-v2-worker-service.ts`

**Interfaces:**
- Consumes:
  - `RuntimeDbStore`
  - `AgentV2RunApiService`
  - `AgentV2WorkerService`
  - `AgentV2RunEventLog`
  - `InMemoryAgentV2RunEventBus`
  - `WorkspaceDiagnosticLogService`
  - `WorkspaceDiagnosticExportService`
  - `WorkspaceSessionService`
  - `resetAgentV2RuntimeData`
- Produces:
  - A deterministic local end-to-end test proving a v2 run can be created, queued, claimed, executed, evented, exported, and reset without v1 product services.

- [ ] **Step 1: Write the failing production-chain test**

Create `packages/web-workspace/test/agent-v2-production-chain.test.ts` with this skeleton:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { InMemoryAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2RunQueue, AgentV2RunQueueIdentity } from "../src/agent-v2-run-queue.js";
import type { AgentV2ExecutionStepResult } from "../src/agent-v2-execution-core.js";
import { resetAgentV2RuntimeData } from "../src/agent-v2-reset.js";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticExportService } from "../src/diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";
import { AgentV2WorkerService } from "../src/agent-v2-worker-service.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("agent v2 production chain rehearsal", () => {
	let dir: string;
	let diagnostics: WorkspaceDiagnosticLogService;
	let runtimeDb: RuntimeDbStore;
	let sessions: WorkspaceSessionService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-production-chain-"));
		const config = { ...loadStorageConfig(dir), loggingEnabled: true, logStdoutEnabled: false };
		runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
		runtimeDb.ensureAgentV2Schema();
		diagnostics = new WorkspaceDiagnosticLogService(config);
		sessions = new WorkspaceSessionService(config);
		sessions.ensureDirs();
	});

	afterEach(() => {
		diagnostics.close();
		runtimeDb.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("starts, executes, replays, exports, and resets a v2 run without legacy state", async () => {
		const bus = new InMemoryAgentV2RunEventBus();
		const eventLog = new AgentV2RunEventLog({ store: runtimeDb, bus });
		const queue = new LocalAgentV2RunQueue();
		const api = new AgentV2RunApiService({
			store: runtimeDb,
			queue,
			events: eventLog,
			createRunId: () => "run-production-chain",
			now: timestampSequence("2026-07-09T00:00:00.000Z", "2026-07-09T00:00:01.000Z"),
		});
		const worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events: eventLog,
			execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
			workerId: "worker-production-chain",
			now: timestampSequence("2026-07-09T00:00:02.000Z", "2026-07-09T00:00:03.000Z"),
		});

		const run = await api.startRun(CLIENT_ID, {
			input: { prompt: "Build a reliable v2 app", sessionId: "session-production", title: "Production Chain" },
			model: { provider: "test", id: "v2-test-model" },
		});
		expect(run).toMatchObject({ runId: "run-production-chain", status: "queued", phase: "intake" });

		await expect(worker.processOne()).resolves.toBe(true);
		expect(await api.getRun(CLIENT_ID, "run-production-chain")).toMatchObject({
			status: "succeeded",
			phase: "delivery",
			workerId: "worker-production-chain",
		});

		const replayed = await eventLog.readLive({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			afterSeq: 0,
			blockMs: 1,
		});
		expect(replayed.map((event) => event.type)).toEqual([
			"agent_v2.run_created",
			"agent_v2.phase_changed",
			"agent_v2.phase_changed",
		]);

		const exported = await new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions).export({
			clientId: CLIENT_ID,
			runId: "run-production-chain",
			includeSettings: false,
		});
		expect(exported.runtime.runs).toHaveLength(1);
		expect(exported.runtime.runEventsByRunId["run-production-chain"]).toHaveLength(3);

		const reset = await resetAgentV2RuntimeData(runtimeDb, {
			confirmation: "RESET_AGENT_V2_RUNTIME_DATA",
			includeDiagnostics: true,
		});
		expect(reset.runsDeleted).toBe(1);
		expect(await api.listRuns(CLIENT_ID)).toEqual([]);
		expect(await eventLog.list(CLIENT_ID, "run-production-chain", 0)).toEqual([]);
	});
});

class LocalAgentV2RunQueue implements AgentV2RunQueue {
	private readonly queued: AgentV2RunQueueIdentity[] = [];
	private readonly cancelKeys = new Set<string>();

	async enqueue(run: AgentV2RunQueueIdentity): Promise<void> {
		this.queued.push(run);
	}

	async claim(): Promise<AgentV2RunQueueIdentity | undefined> {
		return this.queued.shift();
	}

	async complete(): Promise<void> {}
	async requeueActive(): Promise<number> {
		return 0;
	}
	async renewLease(): Promise<boolean> {
		return true;
	}
	async releaseExpiredClaims(): Promise<[]> {
		return [];
	}
	async requestCancel(run: AgentV2RunQueueIdentity): Promise<void> {
		this.cancelKeys.add(`${run.clientId}:${run.runId}`);
	}
	async isCancelRequested(run: AgentV2RunQueueIdentity): Promise<boolean> {
		return this.cancelKeys.has(`${run.clientId}:${run.runId}`);
	}
	async clear(): Promise<{ queueItemsDeleted: number; activeClaimsDeleted: number; cancelKeysDeleted: number }> {
		const queueItemsDeleted = this.queued.length;
		const cancelKeysDeleted = this.cancelKeys.size;
		this.queued.length = 0;
		this.cancelKeys.clear();
		return { queueItemsDeleted, activeClaimsDeleted: 0, cancelKeysDeleted };
	}
	async close(): Promise<void> {}
}

class SequencedExecution {
	private index = 0;
	constructor(private readonly steps: AgentV2ExecutionStepResult[]) {}
	async executeNextTask(): Promise<AgentV2ExecutionStepResult> {
		return this.steps[this.index++] ?? { status: "complete", diagnosticIds: [] };
	}
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps[timestamps.length - 1] ?? "2026-07-09T00:00:00.000Z";
}
```

- [ ] **Step 2: Run the new test and verify the result**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-chain.test.ts
```

Expected before implementation fixes: if a production-chain lifecycle bug exists, FAIL with that specific missing behavior. If it passes immediately, keep it as the acceptance harness and continue.

- [ ] **Step 3: Fix only concrete v2 lifecycle failures**

If the test fails because reset leaves durable v2 run events behind, inspect `RuntimeDbStore.resetAgentV2RuntimeData` and ensure it deletes v2 run events through the existing v2 reset contract. If it fails because event replay is not durable-first, inspect `AgentV2RunEventLog.readLive`.

Do not add a v1 compatibility method. Production code changes in this task must stay in:

```ts
packages/web-workspace/src/agent-v2-run-event-log.ts
packages/web-workspace/src/agent-v2-reset.ts
packages/web-workspace/src/runtime-db.ts
packages/web-workspace/src/postgres-runtime-store.ts
```

- [ ] **Step 4: Run focused validation**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-chain.test.ts test/agent-v2-run-event-store.test.ts test/agent-v2-reset.test.ts
npm --workspace @mariozechner/pi-web-workspace run check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add packages/web-workspace/test/agent-v2-production-chain.test.ts
git add packages/web-workspace/src/agent-v2-run-event-log.ts packages/web-workspace/src/agent-v2-reset.ts packages/web-workspace/src/runtime-db.ts packages/web-workspace/src/postgres-runtime-store.ts
git commit -m "test: rehearse agent v2 production chain"
```

If no production source changed, the second `git add` is harmless.

---

### Task 2: Queue, Cancel, Worker Crash, and Reclaim Faults

**Files:**
- Modify: `packages/web-workspace/test/agent-v2-worker-service.test.ts`
- Modify only if exposed by the test: `packages/web-workspace/src/agent-v2-worker-service.ts`

**Interfaces:**
- Consumes:
  - `AgentV2WorkerService`
  - existing `MemoryWorkerStore`
  - existing `RecordingQueue`
- Produces:
  - Tests proving lease loss, replacement-worker reclaim, and mixed long-run draining do not produce stale terminal writes or active queue residue.

- [ ] **Step 1: Add a lease-loss test**

In `packages/web-workspace/test/agent-v2-worker-service.test.ts`, append this test inside the existing `describe("AgentV2WorkerService", ...)` block:

```ts
it("interrupts a run and avoids stale success when lease renewal is lost during execution", async () => {
	vi.useFakeTimers();
	const store = new MemoryWorkerStore();
	store.createQueuedRun("client-a", "run-lease-lost");
	const queue = new RecordingQueue([{ clientId: "client-a", runId: "run-lease-lost" }]);
	queue.failNextRenewLease = true;
	const worker = new AgentV2WorkerService({
		store,
		queue,
		events: new RecordingEventLog(),
		execution: {
			executeNextTask: async () => {
				await new Promise((resolve) => setTimeout(resolve, 40));
				return { status: "complete", diagnosticIds: [] };
			},
		},
		workerId: "worker-a",
		now: timestampSequence("2026-07-09T01:00:00.000Z", "2026-07-09T01:00:01.000Z"),
		leaseHeartbeatIntervalMs: 10,
	});

	const processing = worker.processOne();
	await vi.advanceTimersByTimeAsync(45);
	await expect(processing).resolves.toBe(true);

	expect(store.getRunSnapshot("client-a", "run-lease-lost")).toMatchObject({
		status: "interrupted",
	});
	expect(queue.completeCalls).toEqual([{ clientId: "client-a", runId: "run-lease-lost", workerId: "worker-a" }]);
});
```

Add this property and branch to the existing `RecordingQueue` helper:

```ts
failNextRenewLease = false;

async renewLease(run: { clientId: string; runId: string }, workerId: string): Promise<boolean> {
	this.renewLeaseCalls.push({ ...run, workerId });
	if (this.failNextRenewLease) {
		this.failNextRenewLease = false;
		return false;
	}
	return true;
}
```

- [ ] **Step 2: Add a replacement-worker reclaim test**

Append:

```ts
it("lets a replacement worker reclaim an expired queued claim after the first worker disappears", async () => {
	const store = new MemoryWorkerStore();
	store.createQueuedRun("client-a", "run-reclaimed-by-replacement");
	const queue = new RecordingQueue();
	queue.expiredClaims = [
		{
			clientId: "client-a",
			runId: "run-reclaimed-by-replacement",
			workerId: "worker-crashed",
			claimedAtMs: 1,
			heartbeatAtMs: 2,
			leaseExpiresAtMs: 3,
		},
	];
	const replacement = new AgentV2WorkerService({
		store,
		queue,
		events: new RecordingEventLog(),
		execution: new SequencedExecution([{ status: "complete", diagnosticIds: [] }]),
		workerId: "worker-replacement",
		now: timestampSequence("2026-07-09T01:01:00.000Z", "2026-07-09T01:01:01.000Z"),
	});

	await replacement.recoverOwnedRuns();
	await expect(replacement.processOne()).resolves.toBe(true);

	expect(queue.enqueuedClaims).toEqual([{ clientId: "client-a", runId: "run-reclaimed-by-replacement" }]);
	expect(store.getRunSnapshot("client-a", "run-reclaimed-by-replacement")).toMatchObject({
		status: "succeeded",
		workerId: "worker-replacement",
	});
});
```

- [ ] **Step 3: Run the worker tests and verify failures or pass**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-worker-service.test.ts
```

Expected: PASS if current worker behavior is already correct. If it fails, fix `AgentV2WorkerService` without changing queue contracts to v1 names.

- [ ] **Step 4: Fix only concrete worker lifecycle bugs**

Allowed production fix areas:

```ts
packages/web-workspace/src/agent-v2-worker-service.ts
packages/web-workspace/src/agent-v2-run-queue.ts
```

Examples of valid fixes:

```ts
if (leaseLost) {
	await this.interruptRun(current);
	return;
}
```

Examples of invalid fixes:

```ts
// invalid: do not add v1 fallback worker behavior
if (legacyRunWorker) await legacyRunWorker.recover();
```

- [ ] **Step 5: Run focused validation**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-worker-service.test.ts test/agent-v2-worker-stress.test.ts test/run-queue-redis.integration.test.ts
npm --workspace @mariozechner/pi-web-workspace run check
```

Expected: worker tests PASS. Redis integration may skip only through its existing Redis availability guard.

- [ ] **Step 6: Commit Task 2**

Run:

```bash
git add packages/web-workspace/test/agent-v2-worker-service.test.ts packages/web-workspace/src/agent-v2-worker-service.ts packages/web-workspace/src/agent-v2-run-queue.ts
git commit -m "test: harden agent v2 worker reclaim paths"
```

---

### Task 3: SSE Replay and Diagnostic Export Acceptance

**Files:**
- Modify: `packages/web-workspace/test/run-events-sse.test.ts`
- Modify: `packages/web-workspace/test/diagnostic-export-service.test.ts`
- Modify only if exposed by the tests: `packages/web-workspace/src/vite-plugin.ts`
- Modify only if exposed by the tests: `packages/web-workspace/src/diagnostic-export-service.ts`

**Interfaces:**
- Consumes:
  - `createConfiguredStoragePluginForTest`
  - `WorkspaceDiagnosticExportService`
  - existing fake request/response utilities in the touched test files
- Produces:
  - Explicit SSE behavior for durable replay overlap, live read failure, and v2 run-only diagnostic archive.

- [ ] **Step 1: Add SSE replay overlap assertion if missing**

Inspect `packages/web-workspace/test/run-events-sse.test.ts`. If the current `deduplicates live events at or before the last sent durable sequence` test exists and passes, do not duplicate it. If it does not exist, add:

```ts
it("deduplicates overlapping durable and live events during SSE replay", async () => {
	const run = runSnapshot();
	const bus = new ScriptedAgentV2RunEventBus([{ events: [runEvent(2), runEvent(3)] }, { waitForAbort: true }]);
	const harness = createSseHarness({
		agentV2RunApi: { getRun: vi.fn().mockResolvedValue(run) },
		runEventLog: { list: vi.fn().mockResolvedValue([runEvent(2)]) },
		agentV2RunEventBus: bus,
	});

	const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=1`);
	await waitUntil(() => sseDataEvents(request.response.body).some((event) => event.seq === 3));

	expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([2, 3]);
	request.close();
	await request.done;
});
```

- [ ] **Step 2: Add SSE live failure assertion if missing**

If `emits an SSE error event when live bus reads fail after headers are written` already exists, keep it. If not, add:

```ts
it("emits an SSE error event when live event replay fails after headers are sent", async () => {
	const run = runSnapshot();
	const bus = new ScriptedAgentV2RunEventBus([{ error: new Error("redis read failed") }]);
	const harness = createSseHarness({
		agentV2RunApi: { getRun: vi.fn().mockResolvedValue(run) },
		runEventLog: { list: vi.fn().mockResolvedValue([]) },
		agentV2RunEventBus: bus,
	});

	const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
	await request.done;

	expect(request.response.statusCode).toBe(200);
	expect(request.response.body).toContain("event: error");
	expect(request.response.body).toContain("Agent v2 runtime event stream unavailable.");
});
```

- [ ] **Step 3: Add diagnostic archive run-only acceptance if missing**

In `packages/web-workspace/test/diagnostic-export-service.test.ts`, if the current `exports v2 runs, events, and diagnostics by run id without legacy session lookups` test already asserts archive files, keep it. Add this extra assertion to that test if missing:

```ts
expect(files["manifest.json"]).toContain("\"runId\":\"run-v2\"");
expect(files["runtime/session.json"]).toBe("null");
expect(files["runtime/messages.ndjson"]).toBe("");
expect(files["agent-v2/diagnostics/run-v2.diagnostics.ndjson"]).toContain("diag-v2");
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/run-events-sse.test.ts test/diagnostic-export-service.test.ts
```

Expected: PASS. If not, fix `vite-plugin.ts` or `diagnostic-export-service.ts` only for the failing v2 behavior.

- [ ] **Step 5: Run typecheck and commit**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
git add packages/web-workspace/test/run-events-sse.test.ts packages/web-workspace/test/diagnostic-export-service.test.ts packages/web-workspace/src/vite-plugin.ts packages/web-workspace/src/diagnostic-export-service.ts
git commit -m "test: cover v2 replay and diagnostic exports"
```

---

### Task 4: Schema Reset and Production Startup Rehearsal

**Files:**
- Modify: `packages/web-workspace/test/vite-plugin-schema-init.test.ts`
- Modify: `packages/web-workspace/test/runtime-store-factory.test.ts`
- Modify only if exposed by the tests: `packages/web-workspace/src/runtime-store-factory.ts`
- Modify only if exposed by the tests: `packages/web-workspace/src/vite-plugin.ts`

**Interfaces:**
- Consumes:
  - `createRuntimeStore`
  - `RuntimeDbStore.ensureAgentV2Schema`
  - `resetAgentV2RuntimeData`
  - `createConfiguredStoragePluginForTest`
- Produces:
  - Rehearsal coverage that startup initializes v2 schema independently and reset does not need legacy rows.

- [ ] **Step 1: Add startup schema idempotency assertion**

In `packages/web-workspace/test/vite-plugin-schema-init.test.ts`, add or extend the test to call the configured plugin startup twice with a fake `runtimeDb.ensureAgentV2Schema` spy:

```ts
it("initializes the v2 schema on every configured plugin startup without legacy runtime services", async () => {
	const runtimeDb = { ensureAgentV2Schema: vi.fn() };
	const services = createSchemaInitServices({ runtimeDb });
	createConfiguredStoragePluginForTest(services).configureServer?.(createFakeServer());
	createConfiguredStoragePluginForTest(services).configureServer?.(createFakeServer());

	expect(runtimeDb.ensureAgentV2Schema).toHaveBeenCalledTimes(2);
});
```

If the helper names differ, reuse the current helpers in `vite-plugin-schema-init.test.ts` and keep the assertion exact.

- [ ] **Step 2: Add reset rehearsal with stale v1-shaped rows**

In `packages/web-workspace/test/runtime-store-factory.test.ts`, add a SQLite-backed test:

```ts
it("resets v2 runtime data without reading stale legacy runtime rows", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-reset-rehearsal-"));
	try {
		const config = { ...loadStorageConfig(root), runtimeStore: "sqlite" as const };
		const store = createRuntimeStore(config);
		store.ensureAgentV2Schema();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-reset-rehearsal",
			input: { prompt: "reset me", sessionId: "session-a", title: "Reset" },
			model: { provider: "test" },
			createdAt: "2026-07-09T02:00:00.000Z",
		});

		const result = store.resetAgentV2RuntimeData({
			confirmation: "RESET_AGENT_V2_RUNTIME_DATA",
			includeDiagnostics: true,
		});

		expect(result.runsDeleted).toBe(1);
		expect(store.listAgentV2Runs("client-a")).toEqual([]);
		store.close();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
```

Use the existing imports/helpers in the file. If `createRuntimeStore(config)` returns an async Postgres store for a modified config, keep `runtimeStore: "sqlite"`.

- [ ] **Step 3: Run focused tests**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/vite-plugin-schema-init.test.ts test/runtime-store-factory.test.ts test/postgres-runtime-store.test.ts
```

Expected: PASS. PostgreSQL-specific tests should use existing mocks/guards and not require a live database unless the file already does.

- [ ] **Step 4: Fix only concrete startup/reset defects**

Allowed production fix areas:

```ts
packages/web-workspace/src/runtime-store-factory.ts
packages/web-workspace/src/vite-plugin.ts
packages/web-workspace/src/runtime-db.ts
packages/web-workspace/src/postgres-runtime-store.ts
```

Do not add old table migrations as a requirement for v2 startup. v2 startup may tolerate old tables, but it must not depend on them.

- [ ] **Step 5: Run typecheck and commit**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
git add packages/web-workspace/test/vite-plugin-schema-init.test.ts packages/web-workspace/test/runtime-store-factory.test.ts packages/web-workspace/src/runtime-store-factory.ts packages/web-workspace/src/vite-plugin.ts packages/web-workspace/src/runtime-db.ts packages/web-workspace/src/postgres-runtime-store.ts
git commit -m "test: rehearse v2 schema startup reset"
```

---

### Task 5: Final Verification and Legacy Surface Audit

**Files:**
- Modify only if verification reveals a concrete remaining generated-source or legacy-boundary issue.

**Interfaces:**
- Consumes all Phase 8 task commits.
- Produces a verified Phase 8 branch ready for review and later local merge decision.

- [ ] **Step 1: Run codegraph status**

Run:

```bash
codegraph status
```

Expected: the Phase 8 worktree index exists and reports indexed TypeScript files. If the CLI uses a different status subcommand, run the equivalent codegraph status command available in the environment.

- [ ] **Step 2: Run source map audit**

Run:

```bash
node -e "const fs=require('fs'); const path=require('path'); const roots=['packages/web-workspace/src','apps/pi-coding-web/src']; let bad=[]; for (const root of roots){ for (const name of fs.readdirSync(root,{recursive:true})){ const file=path.join(root,name); if (!file.endsWith('.js.map')) continue; const raw=fs.readFileSync(file); if (raw[0]===0xef&&raw[1]===0xbb&&raw[2]===0xbf) bad.push(file+':bom'); const map=JSON.parse(raw.toString('utf8')); if (map.sourceRoot && path.isAbsolute(map.sourceRoot)) bad.push(file+':absolute sourceRoot'); for (const source of map.sources||[]) if (path.isAbsolute(source)||/^[A-Za-z]:[\\\\/]/.test(source)) bad.push(file+':absolute source '+source); }} if (bad.length){ console.error(bad.join('\\n')); process.exit(1); } console.log('source maps parse without BOM or absolute sources');"
```

Expected: `source maps parse without BOM or absolute sources`.

- [ ] **Step 3: Run legacy surface audit**

Run:

```bash
rg -n --glob '!*.js' --glob '!*.js.map' "WorkspaceRunApiService|WorkspaceRunWorkerService|AppPreviewGoal(Service|Supervisor)|\bRunApiError\b|\bRunWorker\b|createRuntimeRunQueue|run-api-service|run-worker-service|app-preview-goal-service|app-preview-goal-supervisor|\brunApi\b|\brunEventBus\b" packages/web-workspace/src packages/web-workspace/test apps/pi-coding-web/src apps/pi-coding-web/test
```

Expected: hits may remain only in boundary deny strings, tests that explicitly assert removal, and `AgentV2RunApiService` file/import names.

- [ ] **Step 4: Run full web-workspace tests**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace test
```

Expected: PASS. Redis integration tests may skip only through existing external-service guards.

- [ ] **Step 5: Run app tests**

Run:

```bash
npm --workspace pi-coding-web exec vitest --run
```

Expected: PASS.

- [ ] **Step 6: Run typecheck and builds**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace pi-coding-web run build:worker
```

Expected: all PASS.

- [ ] **Step 7: Run whitespace and status checks**

Run:

```bash
git diff --check
git status --short --branch
```

Expected: no whitespace errors. Final status is clean after committing any required generated-source sync.

- [ ] **Step 8: Commit verification-only fixes if needed**

If a build regenerates tracked source-adjacent JS/map files, inspect the diff. If it is mechanical output from the verified build, commit it:

```bash
git add -u packages/web-workspace/src apps/pi-coding-web/src
git commit -m "fix: sync phase 8 generated sources"
```

If no files changed, do not create an empty commit.

---

## Self-Review

**Spec coverage:** The plan covers Redis/queue/cancel/replay failure injection, worker crash/restart/reclaim, diagnostic export/SSE/Langfuse-adjacent behavior, and v2 schema reset/startup rehearsal.

**Placeholder scan:** The plan uses exact files, exact commands, concrete test snippets, and concrete commit messages. It contains no placeholder implementation tasks.

**Type consistency:** The plan uses current v2 names: `AgentV2RunApiService`, `AgentV2WorkerService`, `AgentV2RunEventLog`, `InMemoryAgentV2RunEventBus`, `AgentV2RunQueue`, `RuntimeDbStore`, and `WorkspaceDiagnosticExportService`.
