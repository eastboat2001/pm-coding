# Application Generation Agent v2 Phase 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish Application Generation Agent v2 cutover by adding operational reset/cleanup, quality regression and stress guards, v2-only runtime entry points, and an explicit old-agent sunset.

**Architecture:** Phase 6 treats v2 as the only product runtime. Existing infrastructure adapters may be reused only after the current implementation is reviewed and hardened; v1 prompt flow, spec artifact flow, session/message run state, and app-preview-goal repair are removed from formal production paths. Reset is an explicit destructive maintenance operation that clears v2 state plus obsolete legacy run data; rollback is redeploying the previous code version, not keeping a runtime v1 fallback.

**Tech Stack:** TypeScript, Node.js, Vite, Vitest, PostgreSQL/SQLite runtime stores, Redis list/hash/string/stream adapters, SSE live events, Biome, tsgo.

## Global Constraints

- 后续语言和工程记录使用中文，代码标识符保持英文。
- Application Generation Agent v2 的目标不是与旧生成 agent 长期并存，也不是在 v1 上加 feature flag 做兼容演进。
- 不要求兼容旧 agent 内部模块接口、旧 prompt 流程、旧 spec/plan/tasks 文件生成逻辑、旧 preview goal continuation repair 逻辑。
- 不要求迁移旧 run/session/message/app preview goal/diagnostic 测试数据。
- 允许破坏式 schema reset 或新增 v2 schema 后清空旧运行数据。
- 可以删除、隔离或废弃旧 application generation agent 代码，只保留经评审后合理可用的基础设施 adapter。
- `PI_APP_AGENT_VERSION=v1/v2` 不再是正式架构目标；Phase 6 必须移除正式 v1 runtime path。
- v2 run data 必须位于 `agent_v2_*` tables；v2 运行时不得把 legacy `runs`, `run_events`, `sessions`, `messages`, `app_preview_goals`, `app_preview_goal_events` 作为 v2 state 读取。
- Redis 清理必须由 adapter 暴露能力完成，不允许业务层硬编码私有 cancel/active key，也不允许用阻塞式 `KEYS` 扫描生产 Redis。
- generated project cleanup 只允许删除 `clientsRootDir/<client>/sessions/<session>/project` 子目录，不能删除整个 client/session 目录。
- 回滚策略只要求回滚代码版本或重新部署上一版本；同一运行时内不保留 v1/v2 双路径。
- Phase 6 起点基线：`packages/web-workspace` v2/backend 聚焦套件 15 files / 197 tests passed；根级 `npm run check` 当前受既有 Biome unsafe optional-chain warnings 阻塞，不把该 warning 修复混入 Phase 6 除非任务明确要求。

---

## File Structure

- `packages/web-workspace/src/run-queue.ts`: generic Redis/in-memory queue adapter. Add maintenance clear capability here because cancel key and active key are adapter-private.
- `packages/web-workspace/src/agent-v2-run-queue.ts`: v2 queue envelope. Expose v2-specific clear result while delegating to the reviewed generic adapter.
- `packages/web-workspace/src/agent-v2-run-event-bus.ts`: v2 live SSE Redis stream adapter. Add bounded purge capability using stream-key patterns and `SCAN`.
- `packages/web-workspace/src/agent-v2-maintenance.ts`: new operational reset orchestration: DB reset, diagnostics clear, queue clear, live stream purge, generated project cleanup.
- `packages/web-workspace/src/agent-v2-reset.ts`: keep as DB-reset compatibility wrapper, but route new operational callers to `agent-v2-maintenance.ts`.
- `packages/web-workspace/src/index.ts`: export new maintenance types/functions.
- `packages/web-workspace/src/config.ts` and `packages/web-workspace/src/types.ts`: remove formal `appAgentVersion` config field and `PI_APP_AGENT_VERSION` parsing.
- `packages/web-workspace/src/vite-plugin.ts`: route only v2 runtime generation APIs; legacy run/session/app-preview-goal routes return disabled responses without consulting a v1 flag.
- `apps/pi-coding-web/src/worker/main.ts`: remove dynamic `legacy-v1-main.js` import and always start `AgentV2WorkerService`.
- `apps/pi-coding-web/src/worker/legacy-v1-main.ts`: delete after v2-only worker tests pass.
- `apps/pi-coding-web/src/runtime/agent-v2-run-client.ts`: new browser client for `/api/agent-v2/runs`.
- `apps/pi-coding-web/src/runtime/run-client.ts`: keep only non-generation legacy helpers that are still used outside app generation, or split those helpers out before deleting old generation methods.
- `apps/pi-coding-web/src/app/bootstrap.ts`: switch generation start/cancel/events to the v2 client and stop building legacy `SpecArtifact` as generation input.
- `apps/pi-coding-web/src/runtime/spec-artifact.ts`: delete only after `bootstrap.ts` and tests no longer import it.
- `packages/web-workspace/test/*agent-v2*.test.ts`: strengthen reset, queue, event, route, import-boundary, and stress regression tests.
- `apps/pi-coding-web/test/*`: update worker/runtime entry and run-client tests to v2-only behavior; delete tests that only preserve v1 prompt/spec behavior.
- `docs/superpowers/specs/*phase*-design.md` and deployment docs/env examples: document v2-only default, reset command/adapter contract, and final v1 removal.

---

### Task 1: Redis Queue and Live Event Maintenance Adapters

**Files:**
- Modify: `packages/web-workspace/src/run-queue.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-queue.ts`
- Modify: `packages/web-workspace/src/agent-v2-run-event-bus.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Test: `packages/web-workspace/test/run-queue.test.ts`
- Test: `packages/web-workspace/test/agent-v2-run-queue.test.ts`
- Test: `packages/web-workspace/test/agent-v2-run-event-bus.test.ts`

**Interfaces:**
- Produces `RunQueueClearResult`:

```typescript
export interface RunQueueClearResult {
	queueItemsDeleted: number;
	activeClaimsDeleted: number;
	cancelKeysDeleted: number;
}
```

- Produces `RunQueue.clear(): Promise<RunQueueClearResult>`.
- Produces `AgentV2RunQueue.clear(): Promise<RunQueueClearResult>`.
- Produces `AgentV2RunEventBus.purge(options?: AgentV2RunEventBusPurgeOptions): Promise<AgentV2RunEventBusPurgeResult>`.

```typescript
export interface AgentV2RunEventBusPurgeOptions {
	clientId?: string;
	runId?: string;
}

export interface AgentV2RunEventBusPurgeResult {
	streamsDeleted: number;
}
```

- Consumes no new code from later tasks.

- [ ] **Step 1: Write failing in-memory queue clear tests**

Add tests proving `InMemoryRunQueue.clear()` removes queued items, active claims, and cancel requests, and returns exact counts:

```typescript
it("clears queued, active, and cancel state", async () => {
	const queue = new InMemoryRunQueue();
	await queue.enqueue({ clientId: "client-a", runId: "run-queued" });
	await queue.enqueue({ clientId: "client-a", runId: "run-active" });
	expect(await queue.claim("worker-a", 0)).toEqual({ clientId: "client-a", runId: "run-queued" });
	await queue.requestCancel({ clientId: "client-a", runId: "run-cancelled" });

	const result = await queue.clear();

	expect(result).toEqual({ queueItemsDeleted: 1, activeClaimsDeleted: 1, cancelKeysDeleted: 1 });
	expect(await queue.claim("worker-a", 0)).toBeUndefined();
	expect(await queue.isCancelRequested({ clientId: "client-a", runId: "run-cancelled" })).toBe(false);
});
```

- [ ] **Step 2: Write failing v2 wrapper tests**

Add a wrapper test with a fake `RunQueue` implementation proving `createAgentV2RunQueue(base).clear()` delegates to base `clear()` and returns the same counts. The fake must fail if the v2 wrapper tries to infer Redis keys itself.

- [ ] **Step 3: Write failing Redis queue clear tests**

Add a fake Redis client in `run-queue.test.ts` that records calls. The test must prove:

```typescript
expect(fake.scanPatterns).toContain("pi:agent-v2:runs:cancel:*");
expect(fake.usedKeysCommand).toBe(false);
expect(result.cancelKeysDeleted).toBe(2);
```

The fake must implement `lLen`, `hLen`, `del`, and `scanIterator`. Use the queue name `pi:agent-v2:runs` so the cancel pattern is derived by the adapter.

- [ ] **Step 4: Implement queue clear**

In `run-queue.ts`, add `clear()` to `RunQueue`, implement it in `InMemoryRunQueue`, and implement Redis cleanup inside `RedisRunQueue`:

```typescript
async clear(): Promise<RunQueueClearResult> {
	this.assertOpen();
	const client = await this.connectedClient();
	const [queueItemsDeleted, activeClaimsDeleted] = await Promise.all([
		client.lLen(this.queueName),
		client.hLen(this.activeKey),
	]);
	const cancelKeys: string[] = [];
	for await (const key of client.scanIterator({ MATCH: `${this.queueName}:cancel:*`, COUNT: 100 })) {
		cancelKeys.push(String(key));
	}
	await Promise.all([
		client.del(this.queueName),
		client.del(this.activeKey),
		...chunk(cancelKeys, 100).map((keys) => client.del(keys)),
	]);
	return { queueItemsDeleted, activeClaimsDeleted, cancelKeysDeleted: cancelKeys.length };
}
```

If node-redis typing requires `del(...keys)` instead of `del(keys)`, keep the runtime behavior identical and cover it with the fake client test.

- [ ] **Step 5: Implement live event purge**

In `agent-v2-run-event-bus.ts`, add optional purge to both buses:

```typescript
async purge(options: AgentV2RunEventBusPurgeOptions = {}): Promise<AgentV2RunEventBusPurgeResult> {
	this.assertOpen();
	if (options.clientId && options.runId) {
		return this.deleteStreams([agentV2RunEventStreamKey({ clientId: options.clientId, runId: options.runId })]);
	}
	const pattern = options.clientId
		? `pi:agent-v2:runs:${options.clientId}:*:events`
		: "pi:agent-v2:runs:*:events";
	const client = await this.connectedClient();
	const keys: string[] = [];
	for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 100 })) keys.push(String(key));
	return this.deleteStreams(keys);
}
```

The Redis client interface must add `del` and `scanIterator`. The implementation must not use `KEYS`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/run-queue.test.ts test/agent-v2-run-queue.test.ts test/agent-v2-run-event-bus.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web-workspace/src/run-queue.ts packages/web-workspace/src/agent-v2-run-queue.ts packages/web-workspace/src/agent-v2-run-event-bus.ts packages/web-workspace/src/index.ts packages/web-workspace/test/run-queue.test.ts packages/web-workspace/test/agent-v2-run-queue.test.ts packages/web-workspace/test/agent-v2-run-event-bus.test.ts
git commit -m "feat: add agent v2 maintenance adapters"
```

### Task 2: Operational Agent v2 Reset Orchestrator

**Files:**
- Create: `packages/web-workspace/src/agent-v2-maintenance.ts`
- Modify: `packages/web-workspace/src/agent-v2-reset.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Test: `packages/web-workspace/test/agent-v2-reset.test.ts`
- Test: `packages/web-workspace/test/agent-v2-maintenance.test.ts`

**Interfaces:**
- Consumes Task 1 `AgentV2RunQueue.clear()` and `AgentV2RunEventBus.purge()`.
- Produces `resetAgentV2Runtime(options): Promise<AgentV2RuntimeResetResult>`.
- Produces `clearAgentV2GeneratedProjectWorkspaces(clientsRootDir): AgentV2GeneratedProjectCleanupResult`.

```typescript
export const AGENT_V2_RESET_CONFIRMATION = "application-generation-agent-v2";

export interface AgentV2RuntimeResetOptions {
	store: RuntimeStore;
	queue?: Pick<AgentV2RunQueue, "clear">;
	eventBus?: Pick<AgentV2RunEventBus, "purge">;
	diagnostics?: AgentV2ResetDiagnosticsAdapter;
	clientsRootDir?: string;
	includeClients?: boolean;
	includeDiagnostics?: boolean;
	includeQueue?: boolean;
	includeLiveEvents?: boolean;
	includeGeneratedProjects?: boolean;
	confirmation?: string;
	now?: () => string;
}
```

- [ ] **Step 1: Write failing confirmation and composition tests**

Add tests proving reset refuses missing confirmation, calls store reset with `includeClients` and `now`, and only calls queue/event/diagnostics/project cleanup when the matching `include*` option is true.

- [ ] **Step 2: Write generated project cleanup tests**

Create a temp `clientsRootDir` containing:

```text
client-a/sessions/session-a/project/index.html
client-a/sessions/session-a/notes.txt
client-b/sessions/session-b/project/.pi-project.json
client-b/keep.txt
```

Assert that cleanup deletes only the two `project` directories and leaves `notes.txt` plus `keep.txt` intact.

- [ ] **Step 3: Implement maintenance module**

Implement `resetAgentV2Runtime` in `agent-v2-maintenance.ts`:

```typescript
export async function resetAgentV2Runtime(options: AgentV2RuntimeResetOptions): Promise<AgentV2RuntimeResetResult> {
	assertAgentV2ResetConfirmation(options.confirmation);
	const store = await options.store.resetAgentV2RuntimeData({
		includeClients: options.includeClients,
		now: options.now,
	});
	const [queue, liveEvents, diagnostics, generatedProjects] = await Promise.all([
		options.includeQueue && options.queue ? options.queue.clear() : undefined,
		options.includeLiveEvents && options.eventBus ? options.eventBus.purge() : undefined,
		options.includeDiagnostics && options.diagnostics?.clearAgentV2Diagnostics
			? options.diagnostics.clearAgentV2Diagnostics()
			: undefined,
		options.includeGeneratedProjects && options.clientsRootDir
			? clearAgentV2GeneratedProjectWorkspaces(options.clientsRootDir)
			: undefined,
	]);
	return { store, queue, liveEvents, diagnosticsDeleted: diagnostics, generatedProjects };
}
```

Keep the existing `resetAgentV2RuntimeData(store, options, diagnostics)` export working for tests and direct callers, but document it as DB/log-sink reset only.

- [ ] **Step 4: Run reset tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-reset.test.ts test/agent-v2-maintenance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web-workspace/src/agent-v2-maintenance.ts packages/web-workspace/src/agent-v2-reset.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-reset.test.ts packages/web-workspace/test/agent-v2-maintenance.test.ts
git commit -m "feat: add agent v2 runtime reset orchestration"
```

### Task 3: Backend v2-only Runtime Entry

**Files:**
- Modify: `packages/web-workspace/src/config.ts`
- Modify: `packages/web-workspace/src/types.ts`
- Modify: `packages/web-workspace/src/vite-plugin.ts`
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Delete: `apps/pi-coding-web/src/worker/legacy-v1-main.ts`
- Test: `packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts`
- Test: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Test: `apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts`
- Test: `apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts`

**Interfaces:**
- Consumes Task 1/2 maintenance adapters only indirectly.
- Produces no runtime `PI_APP_AGENT_VERSION` branch.
- Produces legacy route response policy:
  - `/api/agent-v2/runs/*`: active v2 route.
  - `/api/pi-runs/*`, `/api/runtime/runs/*`, `/api/runs/*`: `410` with `"Application Generation Agent v1 runtime routes have been removed."`
  - `/api/pi-sessions/*`: `410` with `"Application Generation Agent v1 runtime session routes have been removed."`
  - legacy `/goals/app-preview`: `404` with `"Legacy app-preview-goal routes have been removed."`

- [ ] **Step 1: Write failing config and worker tests**

Update `agent-v2-runtime-entry.test.ts` so setting `process.env.PI_APP_AGENT_VERSION = "v1"` still starts v2 worker and never imports `legacy-v1-main.js`.

- [ ] **Step 2: Write failing route tests**

Update `agent-v2-vite-plugin-routes.test.ts` to remove flag-dependent assertions and assert the fixed v2-only legacy responses above.

- [ ] **Step 3: Remove config flag**

Remove `appAgentVersion` from `StorageConfig`, remove parsing of `PI_APP_AGENT_VERSION`, and update config fixture objects in tests to stop passing it.

- [ ] **Step 4: Remove worker v1 branch**

In `apps/pi-coding-web/src/worker/main.ts`, delete:

```typescript
if (config.appAgentVersion === "v1") {
	const legacy = await import("./legacy-v1-main.js");
	await legacy.runLegacyV1Worker();
	return;
}
```

Remove `appAgentVersion` from worker diagnostic payloads.

- [ ] **Step 5: Disable old routes without v1 service**

In `vite-plugin.ts`, stop requiring `WorkspaceRunApiService` or `RunEventBus` for generation routes. Legacy route handlers must not call old service methods; they return disabled responses only.

- [ ] **Step 6: Delete legacy worker**

Delete `apps/pi-coding-web/src/worker/legacy-v1-main.ts` and update tests that imported legacy diagnostics helpers by moving any still-useful diagnostic helper into `main.ts` or a small `worker-diagnostics.ts` module.

- [ ] **Step 7: Run backend entry tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-vite-plugin-routes.test.ts test/agent-v2-production-path-import-boundary.test.ts
cd ../../apps/pi-coding-web
npm test -- test/agent-v2-runtime-entry.test.ts test/worker-runtime-diagnostics.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web-workspace/src/config.ts packages/web-workspace/src/types.ts packages/web-workspace/src/vite-plugin.ts apps/pi-coding-web/src/worker/main.ts packages/web-workspace/test/agent-v2-vite-plugin-routes.test.ts packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts apps/pi-coding-web/test/agent-v2-runtime-entry.test.ts apps/pi-coding-web/test/worker-runtime-diagnostics.test.ts
git add -u apps/pi-coding-web/src/worker/legacy-v1-main.ts
git commit -m "feat: make agent v2 the only backend runtime entry"
```

### Task 4: Frontend v2 Run Client and Generation Entry Switch

**Files:**
- Create: `apps/pi-coding-web/src/runtime/agent-v2-run-client.ts`
- Modify: `apps/pi-coding-web/src/app/bootstrap.ts`
- Modify: `apps/pi-coding-web/src/runtime/run-client.ts`
- Test: `apps/pi-coding-web/test/run-client.test.ts`
- Test: `apps/pi-coding-web/test/agent-v2-run-client.test.ts`
- Test: `apps/pi-coding-web/test/context-orchestrator.test.ts`
- Test: `apps/pi-coding-web/test/coding-system-prompt.test.ts`

**Interfaces:**
- Produces browser client:

```typescript
const AGENT_V2_RUNS_API_PREFIX = "/api/agent-v2/runs";

export interface AgentV2BrowserStartRunRequest {
	sessionId: string;
	title: string;
	message?: unknown;
	attachments?: unknown[];
	projectFiles?: unknown[];
	model?: unknown;
}

export async function startAgentV2Run(request: AgentV2BrowserStartRunRequest): Promise<AgentV2RunSnapshot>;
export async function cancelAgentV2Run(runId: string): Promise<AgentV2RunSnapshot>;
export async function listAgentV2RunEvents(runId: string, afterSeq?: number): Promise<AgentV2RunEventRecord[]>;
export function connectAgentV2RunEvents(...): RunEventConnection;
```

- Consumes `/api/agent-v2/runs/start`, `/api/agent-v2/runs/:runId/cancel`, `/api/agent-v2/runs/:runId/events`.
- Does not consume legacy `/api/pi-runs`, `/api/pi-sessions`, app-preview-goal routes, or `buildSpecArtifact`.

- [ ] **Step 1: Write failing v2 client tests**

Create `agent-v2-run-client.test.ts` proving:
  - `startAgentV2Run` POSTs to `/api/agent-v2/runs/start`.
  - request body shape is `{ input: { sessionId, title, message, attachments, projectFiles }, model }`.
  - SSE event connection uses `/api/agent-v2/runs/<runId>/events`.
  - client request headers keep `X-PI-Client-ID`.

- [ ] **Step 2: Implement v2 client**

Copy only transport mechanics from `run-client.ts`: `buildRunRequestHeaders`, SSE parsing, polling fallback, and error handling. Do not import `StartRunRequest`, `StartRunResult`, `RuntimeSessionDetail`, `AppPreviewGoalRecord`, or legacy app-preview-goal helpers.

- [ ] **Step 3: Switch bootstrap generation start**

In `bootstrap.ts`, replace `startRuntimeRun(...)` for application generation with `startAgentV2Run(...)`. Remove `buildSpecArtifact(...)` from the start path. The payload must include the current UI session id and title so `parseAgentV2RunContext` passes.

- [ ] **Step 4: Remove app-preview-goal generation calls**

Delete or isolate calls to `enableAppPreviewGoal`, `disableAppPreviewGoal`, `getAppPreviewGoal`, and `buildAppPreviewGoalStartRequest` from the application generation path. If non-generation diagnostics UI still references old session data, keep it behind non-generation diagnostics helpers only.

- [ ] **Step 5: Update tests**

Replace tests that assert old spec prompt content with v2 request-contract tests. Delete tests whose only purpose is preserving `docs/spec.md`, `docs/plan.md`, `docs/tasks.md` generation for v1.

- [ ] **Step 6: Run app client tests**

Run:

```bash
cd apps/pi-coding-web
npm test -- test/agent-v2-run-client.test.ts test/run-client.test.ts test/context-orchestrator.test.ts test/coding-system-prompt.test.ts
```

Expected: PASS after deleting or rewriting v1-only assertions.

- [ ] **Step 7: Commit**

```bash
git add apps/pi-coding-web/src/runtime/agent-v2-run-client.ts apps/pi-coding-web/src/runtime/run-client.ts apps/pi-coding-web/src/app/bootstrap.ts apps/pi-coding-web/test/agent-v2-run-client.test.ts apps/pi-coding-web/test/run-client.test.ts apps/pi-coding-web/test/context-orchestrator.test.ts apps/pi-coding-web/test/coding-system-prompt.test.ts
git commit -m "feat: switch web generation entry to agent v2"
```

### Task 5: Delete Legacy Generation Artifacts and Strengthen Boundaries

**Files:**
- Delete: `apps/pi-coding-web/src/runtime/spec-artifact.ts`
- Delete: `apps/pi-coding-web/test/spec-artifact.test.ts`
- Delete: `apps/pi-coding-web/test/spec-artifact-files.test.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-import-boundary.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts`

**Interfaces:**
- Produces boundary tests that fail on these production references:
  - `PI_APP_AGENT_VERSION`
  - `legacy-v1-main`
  - `buildSpecArtifact`
  - `SPEC_ARTIFACT_PROJECT_FILES`
  - `AppPreviewGoalSupervisor`
  - `createRunAgent`
  - `WorkspaceRunWorkerService` in v2 worker path
  - `WorkspaceRunApiService` in v2 run API path

- [ ] **Step 1: Write failing boundary tests**

Update boundary tests to scan production TS files and assert forbidden symbols are absent from:
  - `apps/pi-coding-web/src/worker/main.ts`
  - `apps/pi-coding-web/src/app/bootstrap.ts`
  - `apps/pi-coding-web/src/runtime/agent-v2-run-client.ts`
  - `packages/web-workspace/src/agent-v2-*.ts`
  - v2 route code in `packages/web-workspace/src/vite-plugin.ts`

- [ ] **Step 2: Delete spec artifact module/tests**

Remove the v1 spec artifact module and tests after Task 4 removed imports.

- [ ] **Step 3: Keep useful infrastructure exports only**

Do not delete reusable infrastructure modules in this task: Redis queue base, diagnostic log/export, runtime store schema, static preview/build/validate helpers, Docker/Podman deployment config. Only delete or isolate v1 generation orchestration.

- [ ] **Step 4: Run boundary tests**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-import-boundary.test.ts test/agent-v2-phase4-import-boundary.test.ts
cd ../../apps/pi-coding-web
npm test -- test/spec-artifact.test.ts test/spec-artifact-files.test.ts
```

Expected: web-workspace boundary tests PASS; deleted app spec tests are removed from the runnable test list.

- [ ] **Step 5: Commit**

```bash
git add packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts packages/web-workspace/test/agent-v2-import-boundary.test.ts packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts
git add -u apps/pi-coding-web/src/runtime/spec-artifact.ts apps/pi-coding-web/test/spec-artifact.test.ts apps/pi-coding-web/test/spec-artifact-files.test.ts
git commit -m "refactor: remove legacy generation artifacts"
```

### Task 6: Phase 6 Regression, Stress, Docs, and Generated Outputs

**Files:**
- Create: `packages/web-workspace/test/agent-v2-quality-regression.test.ts`
- Create: `packages/web-workspace/test/agent-v2-worker-stress.test.ts`
- Modify: `packages/web-workspace/package.json` if a focused test script is useful.
- Modify: deployment/env docs that mention `PI_APP_AGENT_VERSION`.
- Modify generated JS/map outputs produced by package build.

**Interfaces:**
- Consumes all prior tasks.
- Produces regression coverage for:
  - v2 state/schema independent initialization.
  - reset after old data: v2 does not read legacy run/session/message/app-preview-goal data.
  - v2 run creation, state machine, task graph, artifact index, diagnostic taxonomy.
  - Redis queue/cancel/lease cleanup and SSE live/replay cleanup.
  - v2 worker lifecycle under multiple queued runs and cancellation.
  - old v1 entry disabled or removed.

- [ ] **Step 1: Write quality regression test**

Create a test that seeds legacy tables with plausible v1 rows, resets via `resetAgentV2Runtime`, then starts a v2 run and asserts:

```typescript
expect(run.status).toBe("queued");
expect(await store.listAgentV2Runs(clientId)).toHaveLength(1);
expect(await legacyReadProbe.didReadLegacyState()).toBe(false);
```

Use an existing proxy-store pattern from earlier v2 tests to fail on legacy state reads.

- [ ] **Step 2: Write worker stress test**

Create a deterministic in-memory stress test with at least 20 queued v2 runs, worker concurrency `4`, and mixed cancellation. Assert every run reaches `succeeded` or `cancelled`, no active claim remains after `stop()`, and no run stays `running`/`cancelling`.

- [ ] **Step 3: Update docs and env examples**

Remove `PI_APP_AGENT_VERSION` from docs/env examples. Add a short reset procedure:

```text
1. Stop v2 workers.
2. Run the Agent v2 reset maintenance operation with confirmation token application-generation-agent-v2.
3. Start v2 workers.
4. Verify /api/agent-v2/runs/start and event replay.
Rollback: redeploy the previous code version and restore from backup if required.
```

- [ ] **Step 4: Run final focused suite**

Run:

```bash
cd packages/web-workspace
npx tsx ../../node_modules/vitest/dist/cli.js --run test/run-queue.test.ts test/run-api-service.test.ts test/run-worker-service.test.ts test/agent-v2-run-queue.test.ts test/agent-v2-run-event-store.test.ts test/agent-v2-run-event-bus.test.ts test/agent-v2-run-event-log.test.ts test/agent-v2-run-api-service.test.ts test/agent-v2-worker-service.test.ts test/agent-v2-vite-plugin-routes.test.ts test/agent-v2-production-path-import-boundary.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-validation-gate.test.ts test/agent-v2-task-engine.test.ts test/agent-v2-quality-regression.test.ts test/agent-v2-worker-stress.test.ts test/postgres-runtime-store.test.ts
cd ../..
npm run check --workspace packages/web-workspace
cd apps/pi-coding-web
npm run check
npm run build:worker
npm test -- test/agent-v2-runtime-entry.test.ts test/worker-runtime-diagnostics.test.ts test/agent-v2-run-client.test.ts
```

Expected: PASS. If root `npm run check` is still blocked only by the pre-existing Biome unsafe optional-chain warnings, report that explicitly and do not mix unrelated warning fixes into this phase.

- [ ] **Step 5: Build generated outputs**

Run package/app builds that update tracked JS/map files:

```bash
cd packages/web-workspace
npm run build
cd ../../apps/pi-coding-web
npm run build:worker
```

Review generated changes and include only outputs corresponding to modified TS files.

- [ ] **Step 6: Commit**

```bash
git add packages/web-workspace/test/agent-v2-quality-regression.test.ts packages/web-workspace/test/agent-v2-worker-stress.test.ts docs packages/web-workspace/src packages/web-workspace/test apps/pi-coding-web/src apps/pi-coding-web/test
git add -u
git diff --check
git commit -m "test: add agent v2 phase 6 regression coverage"
```

---

## Self-Review

- Spec coverage: reset/data cleanup is covered by Tasks 1, 2, and 6; quality regression/stress by Task 6; default v2 switch and old agent sunset by Tasks 3, 4, and 5; no v1 compatibility path is retained.
- Placeholder scan: no `TBD`, `TODO`, or "implement later" placeholders are present.
- Type consistency: queue clear, event purge, and reset orchestration use explicit result types and do not require legacy run/session/message state.
