# Application Generation Agent v2 Phase 9 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Application Generation Agent v2 the only production generation runtime, remove residual v1-shaped queue/event/configuration Modules, and add a deterministic production cutover rehearsal.

**Architecture:** Delete dead selector and compatibility Modules instead of adapting them. Keep infrastructure behind direct v2 Interfaces: a standalone `AgentV2RunQueue`, an `AgentV2RunEventLog`/`AgentV2RunEventBus` pair, nested `AgentV2RuntimeConfig`, and `createAgentV2RuntimeStore()`. Preserve old HTTP prefixes only as inert `410 Gone` tombstones.

**Tech Stack:** TypeScript, Node.js, Vitest, Redis, PostgreSQL/SQLite, Vite Connect middleware, Docker/Podman Compose.

## Global Constraints

- Application Generation Agent v2 is the only product runtime.
- Do not preserve v1 module interfaces, prompt flows, spec/plan/task artifacts, preview-goal repair, run/session/message data, or diagnostic test data.
- Do not read legacy run data through v2 stores, queue adapters, event adapters, or HTTP handlers.
- `PI_APP_AGENT_VERSION` and retired `PI_RUN_*` generation settings are invalid configuration, not compatibility switches.
- Rollback is code redeployment; no in-process v1/v2 switch or data rollback is required.
- Preserve only PostgreSQL/SQLite, Redis, worker lifecycle, event/SSE, diagnostics/Langfuse, build/validation/preview, and deployment infrastructure that satisfies a v2 Interface.
- Use tests first and record the expected RED failure before production edits.
- Keep committed TypeScript source, JavaScript mirrors, and source maps synchronized through the package build.
- Do not push until all local development and final verification are complete.

---

### Task 1: Delete The Runtime Selector Surface

**Files:**
- Delete: `apps/pi-coding-web/src/agent-v2/runtime-entry.ts`
- Delete: `apps/pi-coding-web/src/agent-v2/types.ts`
- Delete: `apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts`
- Modify: `packages/web-workspace/src/agent-v2-types.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify generated mirrors/maps under `packages/web-workspace/src/`

**Interfaces:**
- Consumes: existing v2 run/state/task/document types.
- Produces: no runtime-version selection Interface; v2 modules remain directly importable.

- [ ] **Step 1: Write the failing deletion-boundary test**

Add assertions to `agent-v2-production-path-import-boundary.test.ts`:

```ts
it("deletes the retired application generation runtime selector", () => {
  const deleted = [
    "apps/pi-coding-web/src/agent-v2/runtime-entry.ts",
    "apps/pi-coding-web/src/agent-v2/types.ts",
    "apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts",
  ];
  for (const file of deleted) expect(existsSync(join(repoRoot, file)), file).toBe(false);

  const types = readFileSync(join(repoRoot, "packages/web-workspace/src/agent-v2-types.ts"), "utf8");
  const barrel = readFileSync(join(repoRoot, "packages/web-workspace/src/index.ts"), "utf8");
  for (const retired of [
    "APPLICATION_GENERATION_RUNTIME_V2",
    "ApplicationGenerationRuntimeVersion",
    "ApplicationGenerationRuntimeSelection",
    "v1Disabled",
    "allowDebugV1",
  ]) {
    expect(types, retired).not.toContain(retired);
    expect(barrel, retired).not.toContain(retired);
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL because the selector files and runtime-selection exports still exist.

- [ ] **Step 3: Delete the shallow Module and exports**

Delete the three app files. Remove these declarations from `agent-v2-types.ts` and their root barrel exports:

```ts
APPLICATION_GENERATION_RUNTIME_V2
ApplicationGenerationRuntimeVersion
ApplicationGenerationRuntimeSelection
```

Do not replace them with another selector, flag, factory, or `v1Disabled` marker.

- [ ] **Step 4: Build mirrors and verify GREEN**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-import-boundary.test.ts test/agent-v2-phase4-import-boundary.test.ts
npm --workspace pi-coding-web exec vitest --run test/agent-v2-run-client.test.ts
```

Expected: all selected tests PASS and generated mirrors contain no removed exports.

- [ ] **Step 5: Commit**

```bash
git add apps/pi-coding-web/src/agent-v2/runtime-entry.ts apps/pi-coding-web/src/agent-v2/types.ts apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts packages/web-workspace/src packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts
git commit -m "refactor: remove agent runtime selector"
```

### Task 2: Replace The Legacy Queue Wrapper With Direct v2 Adapters

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-run-queue.ts`
- Modify: `packages/web-workspace/src/agent-v2-maintenance.ts`
- Modify: `packages/web-workspace/src/agent-v2-runtime.ts`
- Modify: `packages/web-workspace/src/runtime-infra.ts`
- Modify: `packages/web-workspace/test/agent-v2-run-queue.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-run-api-service.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-quality-regression.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-worker-stress.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Delete: `packages/web-workspace/src/run-queue.ts`
- Delete: `packages/web-workspace/src/run-queue.js`
- Delete: `packages/web-workspace/src/run-queue.js.map`
- Delete: `packages/web-workspace/src/run-retry-controller.ts`
- Delete: `packages/web-workspace/src/run-retry-controller.js`
- Delete: `packages/web-workspace/src/run-retry-controller.js.map`
- Delete: `packages/web-workspace/test/run-queue.test.ts`
- Delete: `packages/web-workspace/test/retry-policy.test.ts`

**Interfaces:**
- Consumes: Redis client package and `AgentV2RunQueueIdentity`.
- Produces: `InMemoryAgentV2RunQueue`, `RedisAgentV2RunQueue`, `createAgentV2RunQueue()`, and `createRedisAgentV2RunQueue()` implementing `AgentV2RunQueue` directly.

- [ ] **Step 1: Write failing v2 queue ownership tests**

Replace legacy `InMemoryRunQueue` fixtures with the wished-for v2 Adapter and add this contract case:

```ts
it("keeps claim, cancel, lease and cleanup state inside the v2 queue adapter", async () => {
  const queue = createAgentV2RunQueue({ claimLeaseTtlMs: 100, cancelTtlSeconds: 60, now: () => 1_000 });
  await queue.enqueue({ clientId: "client-a", runId: "run-a" });
  expect(await queue.claim("worker-a", 0)).toEqual({ clientId: "client-a", runId: "run-a" });
  await queue.requestCancel({ clientId: "client-a", runId: "run-a" });
  expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-a" })).toBe(true);
  expect(await queue.renewLease({ clientId: "client-a", runId: "run-a" }, "worker-b")).toBe(false);
  await queue.complete({ clientId: "client-a", runId: "run-a" }, "worker-a");
  expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-a" })).toBe(false);
  expect(await queue.clear()).toEqual({ queueItemsDeleted: 0, activeClaimsDeleted: 0, cancelKeysDeleted: 0 });
});
```

Add deletion assertions for `run-queue.ts` and `run-retry-controller.ts`, and assert `agent-v2-run-queue.ts` does not contain `./run-queue.js`, `RunQueue`, `ClaimedRun`, or `ActiveRunClaim`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-run-queue.test.ts test/agent-v2-production-path-import-boundary.test.ts
```

Expected: FAIL because the direct in-memory Adapter does not exist and legacy files/imports remain.

- [ ] **Step 3: Implement the direct v2 queue contracts**

Keep this public shape in `agent-v2-run-queue.ts`:

```ts
export interface AgentV2RunQueueOptions {
  claimLeaseTtlMs?: number;
  cancelTtlSeconds?: number;
  now?: () => number;
}

export class InMemoryAgentV2RunQueue implements AgentV2RunQueue { /* direct v2 state */ }
export class RedisAgentV2RunQueue implements AgentV2RunQueue { /* direct Redis keys and leases */ }

export function createAgentV2RunQueue(options: AgentV2RunQueueOptions = {}): AgentV2RunQueue {
  return new InMemoryAgentV2RunQueue(options);
}

export function createRedisAgentV2RunQueue(options: RedisAgentV2RunQueueOptions): AgentV2RunQueue {
  return new RedisAgentV2RunQueue(options);
}
```

Port the Phase 8-verified semantics behind this Interface: FIFO queueing, single active owner, owner-only completion/renewal, lease expiry reclaim, worker requeue, scoped expiring cancel keys, bounded claim wait, idempotent close, and complete cleanup counts. Redis keys must remain namespaced by the configured v2 queue name so deployment data does not collide with `pi:runs`.

- [ ] **Step 4: Remove legacy queue/retry Modules and update consumers**

Use `AgentV2RunQueueClearResult` in maintenance. Replace every v2 test import of `InMemoryRunQueue`, `RunQueue`, or `RunQueueClearResult` with the direct v2 Interface/Adapter. Delete the legacy queue/retry source and dedicated tests.

- [ ] **Step 5: Verify GREEN and Redis compilation**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-run-queue.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-worker-service.test.ts test/agent-v2-worker-stress.test.ts test/agent-v2-maintenance.test.ts test/agent-v2-production-path-import-boundary.test.ts test/run-queue-redis.integration.test.ts
```

Expected: all non-environment-gated tests PASS; Redis integration either PASS with Redis configured or SKIP only for unavailable Redis.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/src packages/web-workspace/test
git commit -m "refactor: own agent v2 queue adapters"
```

### Task 3: Delete Legacy Event Compatibility And Isolate Retired Routes

**Files:**
- Delete: `packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.ts`
- Delete: `packages/web-workspace/src/legacy-v1-agent-v2-run-event-bridge.js`
- Delete: `packages/web-workspace/src/run-event-sink.ts`
- Delete: `packages/web-workspace/src/run-event-sink.js`
- Delete: `packages/web-workspace/src/run-event-sink.js.map`
- Delete: `packages/web-workspace/src/run-event-bus.ts`
- Delete: `packages/web-workspace/src/run-event-bus.js`
- Delete: `packages/web-workspace/src/run-event-bus.js.map`
- Delete: `packages/web-workspace/test/run-event-sink.test.ts`
- Delete: `packages/web-workspace/test/run-event-bus.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-store.test.ts`
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Modify: `packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:**
- Consumes: `AgentV2RunEventLog`, `AgentV2RunEventBus`, and Vite middleware request path.
- Produces: no compatibility event Adapter; pure retired-route classification returning fixed status/error values.

- [ ] **Step 1: Write failing deletion and route-purity tests**

Add deletion assertions for all five legacy source names and two dedicated test files. Remove `legacyRunApi` from the route harness type and assertions so the test cannot simulate an injectable v1 service. Add a source assertion that retired route handling contains no store, queue, session, or event-log parameter.

```ts
it("keeps retired generation routes as data-free tombstones", async () => {
  const harness = createHarness();
  const response = await dispatch(harness.middleware, { method: "GET", url: "/api/runtime/runs/old-run/events" });
  expect(response.statusCode).toBe(410);
  expect(JSON.parse(response.body)).toEqual({
    error: "Application Generation Agent v1 runtime routes have been removed.",
  });
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-vite-plugin-routes.test.ts
```

Expected: FAIL because legacy event files exist and the route harness still exposes legacy service spies.

- [ ] **Step 3: Delete compatibility event Modules**

Delete the bridge, old sink/bus, generated mirrors/maps, and dedicated tests. In `agent-v2-store.test.ts`, seed stale legacy events directly through the concrete store's legacy persistence method only inside the isolation test; do not create a compatibility helper or export it.

- [ ] **Step 4: Simplify retired route dispatch**

Keep one pure classifier local to `vite-plugin.ts`:

```ts
type RetiredApplicationGenerationRoute = { status: 404 | 410; error: string };

function retiredApplicationGenerationRoute(pathname: string): RetiredApplicationGenerationRoute | undefined {
  if (pathname.startsWith("/api/runtime/runs/goals/app-preview")) {
    return { status: 404, error: "Legacy app-preview-goal routes have been removed." };
  }
  if (["/api/runtime/runs", "/api/pi-runs", "/api/runs"].some((prefix) => pathname.startsWith(prefix))) {
    return { status: 410, error: "Application Generation Agent v1 runtime routes have been removed." };
  }
  if (pathname.startsWith("/api/pi-sessions")) {
    return { status: 410, error: "Application Generation Agent v1 runtime session routes have been removed." };
  }
  return undefined;
}
```

Classify the full pathname before v2/API dispatch and respond via `sendJson`. Do not inject any legacy service into the handler or test harness.

- [ ] **Step 5: Build and verify GREEN**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-store.test.ts test/agent-v2-run-event-log.test.ts test/agent-v2-run-event-bus.test.ts test/run-events-sse.test.ts test/agent-v2-vite-plugin-routes.test.ts test/agent-v2-production-path-import-boundary.test.ts
```

Expected: all selected tests PASS and no compatibility event file remains.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/src packages/web-workspace/test
git commit -m "refactor: remove legacy event compatibility"
```

### Task 4: Deepen v2 Configuration And Production Store Seams

**Files:**
- Modify: `packages/web-workspace/src/types.ts`
- Modify: `packages/web-workspace/src/config.ts`
- Modify: `packages/web-workspace/src/runtime-store-factory.ts`
- Modify: `packages/web-workspace/src/runtime-infra.ts`
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify: `packages/web-workspace/test/workspace.test.mjs`
- Modify: `packages/web-workspace/test/config-diagnostics.test.ts`
- Modify: `packages/web-workspace/test/runtime-store-factory.test.ts`
- Modify: all test-local `StorageConfig` fixtures returned by `rg -l 'runsEnabled|runQueueName' packages/web-workspace/test apps/pi-coding-web/test`
- Modify: `apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify generated mirrors/maps under `packages/web-workspace/src/`

**Interfaces:**
- Consumes: process env, configured `.env`, PostgreSQL/SQLite concrete stores.
- Produces: `AgentV2RuntimeConfig`, `StorageConfig.agentV2`, `RetiredApplicationGenerationConfigError`, and `createAgentV2RuntimeStore(config)` with a v2 production-store return Interface.

- [ ] **Step 1: Write failing configuration tests**

Define the desired nested value and fail-fast behavior:

```ts
expect(loadStorageConfig(root).agentV2).toEqual({
  queueName: "pi:agent-v2:runs",
  eventStreamMaxLen: 5000,
  eventStreamTtlSeconds: 3600,
});

process.env.PI_APP_AGENT_VERSION = "v1";
expect(() => loadStorageConfig(root)).toThrow(/PI_APP_AGENT_VERSION/);
```

Add a `.env` case containing `PI_RUN_QUEUE_NAME=pi:runs` and assert the thrown error lists `PI_RUN_QUEUE_NAME`. Add a positive override case for all three `PI_AGENT_V2_*` variables.

- [ ] **Step 2: Write failing production-store boundary tests**

Require production entries to contain `createAgentV2RuntimeStore` and not contain `createRuntimeStore`, `RuntimeStore`, or casts from the factory result. Require `runtime-store-factory.ts` not to import `./runtime-store.js`.

- [ ] **Step 3: Verify RED**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/config-diagnostics.test.ts test/runtime-store-factory.test.ts test/agent-v2-production-path-import-boundary.test.ts
npm --workspace pi-coding-web exec vitest --run test/worker-runtime-diagnostics.test.ts
```

Expected: FAIL because the nested config, rejection error, and v2 store factory do not exist.

- [ ] **Step 4: Implement nested v2 configuration and retired-variable audit**

Add:

```ts
export interface AgentV2RuntimeConfig {
  queueName: string;
  eventStreamMaxLen: number;
  eventStreamTtlSeconds: number;
}

export class RetiredApplicationGenerationConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Retired application generation configuration is not supported: ${variables.join(", ")}`);
    this.name = "RetiredApplicationGenerationConfigError";
  }
}
```

Audit both process env and parsed `.env` before returning `StorageConfig`. Reject this exact retired set:

```ts
const RETIRED_APPLICATION_GENERATION_ENV = [
  "PI_APP_AGENT_VERSION",
  "PI_RUNS_ENABLED",
  "PI_RUN_QUEUE_NAME",
  "PI_RUN_EVENT_RETENTION_DAYS",
  "PI_RUN_EVENT_STREAM_MAXLEN",
  "PI_RUN_EVENT_STREAM_TTL_SECONDS",
  "PI_RUN_EVENT_CHECKPOINT_INTERVAL_MS",
  "PI_RUN_EVENT_CHECKPOINT_MIN_CHARS",
  "PI_RUN_RETRY_MAX_ATTEMPTS",
  "PI_RUN_RETRY_BASE_DELAY_MS",
  "PI_RUN_RETRY_MAX_DELAY_MS",
  "PI_RUN_RETRY_JITTER_RATIO",
  "PI_RUN_MAX_AGENT_TURNS",
  "PI_RUN_MAX_AGENT_TOOL_EXECUTIONS",
] as const;
```

Remove the corresponding legacy fields from `StorageConfig`, diagnostics, and test fixtures. Production code reads `config.agentV2.queueName`, `config.agentV2.eventStreamMaxLen`, and `config.agentV2.eventStreamTtlSeconds`.

- [ ] **Step 5: Implement the v2 production store factory**

Export a composite Interface containing the v2 store capabilities used by web/worker plus `close()`:

```ts
export type AgentV2ProductionStore = AgentV2SchemaStore &
  AgentV2RunApiStore &
  AgentV2WorkerStore &
  AgentV2RunEventLogStore &
  AgentV2DiagnosticExportStore &
  AgentV2ExecutionStore &
  AgentV2ResetStore & {
    close(): void | Promise<void>;
  };

export function createAgentV2RuntimeStore(config: StorageConfig): AgentV2ProductionStore {
  return config.runtimeStore === "postgres"
    ? new PostgresRuntimeStore(config.postgresUrl)
    : new RuntimeDbStore(config.runtimeDbFile);
}
```

Use the exact constructor options already required by the concrete stores. If TypeScript exposes an additional v2 capability actually consumed by `vite-plugin.ts` or the worker, add that capability to this single composite Interface rather than casting at callers.

- [ ] **Step 6: Build and verify GREEN**

Run:

```bash
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace @mariozechner/pi-web-workspace test
npm --workspace pi-coding-web exec vitest --run test/worker-runtime-diagnostics.test.ts test/worker-schema-init.test.ts test/agent-v2-run-client.test.ts
npm --workspace pi-coding-web run build:worker
```

Expected: all commands PASS; source diagnostics contain only nested v2 queue/event values.

- [ ] **Step 7: Commit**

```bash
git add packages/web-workspace apps/pi-coding-web
git commit -m "refactor: enforce agent v2 production config"
```

### Task 5: Add The Production Cutover Rehearsal

**Files:**
- Create: `apps/pi-coding-web/src/worker/cutover-rehearsal.ts`
- Create: `apps/pi-coding-web/test/cutover-rehearsal.test.ts`
- Modify: `apps/pi-coding-web/package.json`
- Modify: `docker/pi-coding-web/.env.example`
- Modify: `docker/pi-coding-web/docker-compose.yaml`
- Modify: `docker/pi-coding-web/README.md`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:**
- Consumes: `fetch`, deployed base URL, client ID, model id/provider, bounded timeout/poll interval.
- Produces: `runAgentV2CutoverRehearsal(options): Promise<AgentV2CutoverRehearsalReport>` and CLI exit code `0` only when every check passes.

- [ ] **Step 1: Write failing rehearsal tests**

Use a scripted `fetch` Adapter and fake sleep. Cover health, v2 start/read/events/cancel, tombstones, and timeout:

```ts
it("verifies the v2 chain and retired route tombstones", async () => {
  const report = await runAgentV2CutoverRehearsal({
    baseUrl: "http://pi.test",
    clientId: "11111111-1111-4111-8111-111111111111",
    model: { provider: "test", id: "test-model" },
    fetch: scriptedFetch(successfulCutoverResponses()),
    sleep: async () => undefined,
    timeoutMs: 1_000,
    pollIntervalMs: 1,
  });
  expect(report.ok).toBe(true);
  expect(report.checks.map((check) => check.name)).toEqual([
    "storage-health",
    "v2-run-start",
    "v2-run-read",
    "v2-event-replay",
    "v2-run-cancel",
    "retired-run-route",
    "retired-session-route",
  ]);
});
```

Add a timeout case asserting `ok: false`, the last observed run status, and a non-secret error message.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm --workspace pi-coding-web exec vitest --run test/cutover-rehearsal.test.ts
```

Expected: FAIL because the rehearsal Module does not exist.

- [ ] **Step 3: Implement the rehearsal Module and CLI**

Use this public result shape:

```ts
export interface AgentV2CutoverCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AgentV2CutoverRehearsalReport {
  ok: boolean;
  runId?: string;
  finalStatus?: string;
  lastEventSeq?: number;
  checks: AgentV2CutoverCheck[];
}
```

The CLI reads `PI_CUTOVER_BASE_URL`, `PI_CUTOVER_CLIENT_ID`, `PI_CUTOVER_MODEL_PROVIDER`, `PI_CUTOVER_MODEL_ID`, `PI_CUTOVER_TIMEOUT_MS`, and `PI_CUTOVER_POLL_INTERVAL_MS`. It prints one JSON report, never prints provider keys, and sets exit code `1` on any failed check. It must not call reset or remove data.

- [ ] **Step 4: Add deployment wiring and v2-only environment example**

Add `rehearse:cutover` to the app package:

```json
"rehearse:cutover": "node dist-worker/worker/cutover-rehearsal.js"
```

Replace legacy `.env.example` generation settings with:

```env
PI_AGENT_V2_RUN_QUEUE_NAME=pi:agent-v2:runs
PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN=5000
PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS=3600
PI_CUTOVER_BASE_URL=http://pi-coding-web:5173
PI_CUTOVER_CLIENT_ID=11111111-1111-4111-8111-111111111111
PI_CUTOVER_MODEL_PROVIDER=
PI_CUTOVER_MODEL_ID=
```

Add a Compose `pi-cutover-rehearsal` profile service using the app image, no restart policy, the same `.env`, dependency on healthy web/Redis/PostgreSQL, and command `node dist-worker/worker/cutover-rehearsal.js`.

- [ ] **Step 5: Document production cutover, reset, rollback, and v1 removal**

Document exact commands:

```bash
docker compose config
docker compose up -d --no-build postgres redis pi-coding-web pi-worker
docker compose --profile cutover run --rm pi-cutover-rehearsal
docker compose logs --tail=200 pi-coding-web pi-worker
```

State that old data is not migrated, destructive reset requires explicit operator confirmation, rollback redeploys the previous image, and `PI_APP_AGENT_VERSION`/legacy `PI_RUN_*` variables must be removed before startup.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm --workspace pi-coding-web exec vitest --run test/cutover-rehearsal.test.ts
npm --workspace pi-coding-web run build:worker
npm --workspace @mariozechner/pi-web-workspace exec vitest --run test/agent-v2-production-path-import-boundary.test.ts
docker compose -f docker/pi-coding-web/docker-compose.yaml config
```

Expected: tests/build/Compose validation PASS. The live profile is documented but not required unless Docker/Podman services and a test provider are available.

- [ ] **Step 7: Commit**

```bash
git add apps/pi-coding-web docker/pi-coding-web packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts
git commit -m "feat: add agent v2 cutover rehearsal"
```

## Final Verification

- [ ] Run the web-workspace suite:

```bash
npm --workspace @mariozechner/pi-web-workspace test
```

- [ ] Run the app suite:

```bash
npm --workspace pi-coding-web test
```

- [ ] Run checks and builds:

```bash
npm --workspace @mariozechner/pi-web-workspace run check
npm --workspace pi-coding-web run check
npm --workspace @mariozechner/pi-web-workspace run build
npm --workspace pi-coding-web run build
npm --workspace pi-coding-web run build:worker
```

- [ ] Audit retired product surfaces:

```bash
rg -n --glob '!docs/**' --glob '!**/*.map' "PI_APP_AGENT_VERSION|allowDebugV1|v1Disabled|legacy-v1-agent-v2-run-event-bridge|from \"./run-queue.js\"|from \"./run-event-bus.js\"|from \"./run-event-sink.js\"|run-retry-controller|createRuntimeStore" apps/pi-coding-web packages/web-workspace docker/pi-coding-web
```

Expected: no production or active test hits except retired-variable rejection constants and fixed HTTP tombstone text.

- [ ] Run source mirror/map and Compose validation:

```bash
git status --short
docker compose -f docker/pi-coding-web/docker-compose.yaml config
```

Expected: only intentional Phase 9 source/doc changes before the final commit; Compose resolves without deprecated v1 variables.

- [ ] Dispatch a whole-branch code review against the Phase 9 merge base, fix all Critical/Important findings, re-run the covering tests, and then run this complete verification block again.
