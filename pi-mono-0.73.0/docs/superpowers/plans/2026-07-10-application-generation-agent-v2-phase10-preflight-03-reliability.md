# Phase 10 Preflight 03: Reliability, Events, and Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Redis claim/reclaim、outbox projection、worker control、SSE replay、diagnostics 和 shutdown 在真实故障下可恢复且可诊断。

**Architecture:** Redis queue ownership由 workerId + claimToken 明确表达，每个 blocking claim 使用独立连接；expired reclaim 在单 Lua script 中回 ready。Durable outbox dispatcher 是 queue/live/diagnostic 投影的唯一交付路径；SSE 同时通过 durable gap healing 防御投影延迟和 retention。

**Tech Stack:** Redis 7 Lua/Streams、node-redis、SQLite/PostgreSQL outbox、Vitest、TCP fault proxy、AbortSignal/deadline。

## Global Constraints

- 继承 master plan 全部约束。
- 真实 Redis integration 必须连接 `redis://127.0.0.1:6379` 并执行，不得 skip。
- 不以增大现有 `claim(..., 1)` 断言超时掩盖首次连接/claim 语义；先定义 timeout 是“等待工作”而不是“建立基础连接”的 Interface。
- live publish、Langfuse 或 Workspace diagnostic 投影失败不得反转 durable 业务提交。
- maintenance 错误必须产生 sanitized taxonomy diagnostic，不允许 `.catch(() => undefined)`。

**Mandatory commit gate:** 每个 Task 在 `git commit` 前都必须从仓库根目录运行 `npm run check` 与 `git diff --check`；任一失败即不得提交。

---

### Task 1: Harden Redis Queue Ownership and Atomic Reclaim

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-run-queue.ts`, `agent-v2-runtime.ts`, `runtime-infra.ts`, `index.ts` plus mirrors
- Modify tests: `agent-v2-run-queue.test.ts`, `run-queue-redis.integration.test.ts`, `agent-v2-worker-service.test.ts`, `agent-v2-worker-stress.test.ts`
- Create: `packages/web-workspace/test/support/redis-fault-proxy.ts`

**Interfaces:**

```ts
export interface AgentV2ClaimedRun extends AgentV2RunQueueIdentity {
	workerId: string; claimToken: string; leaseExpiresAtMs: number;
}
export type AgentV2ClaimOwnership = "owned" | "lost" | "uncertain";
export type AgentV2LeaseRenewalResult =
	| { status: "renewed"; leaseExpiresAtMs: number }
	| { status: "lost" }
	| { status: "uncertain"; errorCode: string };
export type AgentV2QueueEnqueueResult = "enqueued" | "already_ready" | "already_active";
```

`complete` and `renewLease` consume the claim object, not separate identity/workerId. Add `confirmOwnership(claim, timeoutMs)` and `requeueExpiredClaims(nowMs?)`.

- [ ] **Step 1: Preserve existing real RED** by running `run-queue-redis.integration.test.ts` with `PI_TEST_REDIS_URL`; record three claim failures.
- [ ] **Step 2: Add RED tests** for idempotent enqueue ready set, worker/token ownership, concurrent independent claim sockets, response-drop claim recovery, atomic expired reclaim, cancel TTL/prune and close with active claims.
- [ ] **Step 3: Implement Redis ready set and Lua scripts**: enqueue SADD+LPUSH, claim RPOP+SREM+HSET token/expiry, complete/renew/confirm owner+token CAS, expired HDEL+SADD+LPUSH in one script.
- [ ] **Step 4: Replace singleton `claimClient` with per-claim clients** tracked in a Set; connect before starting the caller's wait-for-work deadline, and only timeout the blocking/poll phase.
- [ ] **Step 5: Sync mirrors and run unit + real Redis tests.** Expected: prior 3 RED cases and new failure cases PASS.
- [ ] **Step 6: Run check and commit `fix(web-workspace): harden redis queue ownership and reclaim`.**

### Task 2: Dispatch Durable Queue and Live Projections

**Files:**
- Create: `packages/web-workspace/src/agent-v2-outbox-dispatcher.ts` plus mirrors
- Create tests: `agent-v2-outbox-dispatcher.test.ts`, `agent-v2-outbox-redis.integration.test.ts`, `agent-v2-run-event-bus-redis.integration.test.ts`
- Modify: `agent-v2-run-event-log.ts`, `agent-v2-run-event-bus.ts`, `vite-plugin.ts`, `runtime-infra.ts`, `agent-v2-runtime.ts` plus mirrors
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify existing event-log/event-bus/Vite/worker tests

**Interfaces:**

```ts
export interface AgentV2OutboxDeliveryAdapter<K extends AgentV2OutboxKind = AgentV2OutboxKind> {
	readonly kind: K;
	deliver(intent: AgentV2OutboxRecord, signal: AbortSignal): Promise<void>;
}
export class AgentV2OutboxDispatcher {
	dispatchAvailable(input: AgentV2OutboxDispatchInput): Promise<AgentV2OutboxDispatchResult>;
	start(input: { ownerId: string; intervalMs: number; signal: AbortSignal }): Promise<void>;
}
export interface AgentV2RunEventBus {
	project(event: AgentV2LiveRunEvent): Promise<"projected" | "already_projected">;
	read(request: AgentV2RunEventReadRequest): Promise<AgentV2LiveRunEvent[]>;
}
```

- [ ] **Step 1: RED dispatcher tests** cover lease owner, adapter routing, success ack, retry/dead-letter, abort and one sink not blocking another. Add `run_cancel` delivery for queued/running runs and prove duplicate/ack-loss delivery is idempotent by cancel token.
- [ ] **Step 2: RED real Redis tests** cover queue enqueue and cancel delivered/ack-loss replay, Redis unavailable then recovery, and stream projection using explicit `${seq}-0`: same payload is idempotent, conflicting payload is typed conflict.
- [ ] **Step 3: Implement delivery Adapters**; outbox stores canonical references only, so live reads durable event by seq and diagnostic delivery reads canonical diagnostic by id.
- [ ] **Step 4: Remove bus from `AgentV2RunEventLog.append()`**; no production business mutation may call Redis project synchronously.
- [ ] **Step 5: Compose dispatcher in web and worker with DB lease ownership; wake only triggers scan and never bypasses outbox.**
- [ ] **Step 6: Sync, focused unit/real Redis tests, checks and commit `feat(web-workspace): dispatch durable agent v2 projections`.**

### Task 3: Commit Worker State and Events Before Claim Completion

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-worker-service.ts`, `agent-v2-run-event-log.ts` plus mirrors
- Modify tests: `agent-v2-worker-service.test.ts`, `agent-v2-worker-stress.test.ts`, `agent-v2-run-event-store.test.ts`, `postgres-runtime-store.test.ts`

- [ ] **Step 1: RED tests** assert queued→running and terminal/cancel/interrupt use `commitAgentV2RunTransition`; CAS failure writes no event/outbox; commit failure keeps claim owned; terminal durable commit precedes `complete`; projection failure is irrelevant to worker success.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Replace transition + separate append calls** with durable commit result. Complete only with the exact claim token after terminal or explicit safely-skipped run state.
- [ ] **Step 4: Add sanitized diagnostics for contended/failed commits through canonical commit Interface.**
- [ ] **Step 5: Sync, focused tests, real Redis worker cases, check and commit `fix(web-workspace): commit worker state and events atomically`.**

### Task 4: Heal SSE Gaps and Support Standard Replay Cursor

**Files:**
- Modify: `packages/web-workspace/src/vite-plugin.ts` plus mirrors
- Modify: `apps/pi-coding-web/src/runtime/agent-v2-run-client.ts`
- Modify tests: `packages/web-workspace/test/run-events-sse.test.ts`, `apps/pi-coding-web/test/agent-v2-run-client.test.ts`
- Create: `packages/web-workspace/test/agent-v2-durable-live-redis.integration.test.ts`

**Interface rules:** query `afterSeq` and `Last-Event-ID` accept strict non-negative integers; if both exist and differ return 400. Emit `id: <seq>` and `data:`. Advance cursor only after contiguous send.

- [ ] **Step 1: RED unit tests** cover conflicting/invalid cursors, `id:` output, live N+1 with durable N hole, periodic durable check and reconnect de-duplication.
- [ ] **Step 2: RED real Redis test** persists terminal event without live projection and proves an already-connected client receives it through durable check.
- [ ] **Step 3: Implement buffered live reads and `fillDurableGap(afterSeq, targetSeq?)`; invoke on jumps and periodic idle.**
- [ ] **Step 4: Update browser client to send/track `Last-Event-ID` while retaining `afterSeq` compatibility during this same v2 Interface, not a v1 route.**
- [ ] **Step 5: Sync server mirror, run both package tests + real Redis, checks and commit `fix(web-workspace): heal durable gaps in agent v2 sse`.**

### Task 5: Canonicalize and Project v2 Diagnostics

**Files:**
- Create: `packages/web-workspace/src/agent-v2-diagnostic-projections.ts` plus mirrors
- Create tests: `agent-v2-diagnostic-outbox.test.ts`, `langfuse-exporter.test.ts`
- Modify: `agent-v2-diagnostics.ts`, `agent-v2-execution-core.ts`, `agent-v2-runtime-core.ts`, `agent-v2-planning-bootstrap.ts`, `agent-v2-worker-service.ts`, `diagnostic-log-service.ts`, `langfuse-exporter.ts`, `diagnostic-export-service.ts` plus mirrors
- Modify related diagnostic/export/worker tests

**Interfaces:** `createAgentV2DiagnosticEvent()` returns the only canonical sanitized shape. `commitAgentV2Diagnostic()` atomically stores it, optional run event and workspace/Langfuse intents. Workspace/Langfuse/archive never receive raw input.

- [ ] **Step 1: RED sanitizer tests** cover sensitive key/header/cookie, URL credentials/query, nested arrays, Error/cause, stdout/stderr, provider payload and free-text token patterns.
- [ ] **Step 2: RED transaction/projection tests** prove raw secret never exists in DB/event/archive, workspace and Langfuse failures are isolated, and dead-letter error is sanitized.
- [ ] **Step 3: Make sanitizer part of canonical creation**, not an optional export conversion; wire `toWorkspaceDiagnosticEvent()` as a real delivery Adapter.
- [ ] **Step 4: Split local Workspace write from Langfuse enqueue** to avoid projection recursion. Make Langfuse delivery await remote confirmation with AbortSignal; concurrent flush waits the same promise.
- [ ] **Step 5: Sync, focused tests, check and commit `fix(web-workspace): canonicalize and project agent v2 diagnostics`.**

### Task 6: Serialize Heartbeat and Cancel Monitoring

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-worker-service.ts`, `agent-v2-run-queue.ts` plus mirrors
- Modify tests: `agent-v2-worker-service.test.ts`, `agent-v2-worker-stress.test.ts`, `run-queue-redis.integration.test.ts`

- [ ] **Step 1: RED tests** make renew/cancel reject and stall; assert no unhandled rejection, no overlapping tick and no side effect while ownership is uncertain.
- [ ] **Step 2: RED ownership race tests** cover renewed→continue, lost→abort+interrupt, uncertain→confirm until deadline then interrupt, and terminal commit re-confirming ownership.
- [ ] **Step 3: Replace both `setInterval(... void promise)` loops** with one serial async control loop sharing AbortSignal and latest claim/run state.
- [ ] **Step 4: Emit canonical taxonomy diagnostics for poll/lease errors; never swallow maintenance failure.**
- [ ] **Step 5: Sync, unit/stress/real Redis tests, check and commit `fix(web-workspace): serialize worker lease and cancel monitoring`.**

### Task 7: Enforce One Total Shutdown Deadline

**Files:**
- Create: `packages/web-workspace/src/agent-v2-lifecycle.ts` plus mirrors
- Create: `apps/pi-coding-web/src/worker/shutdown-deadline.ts`
- Modify: worker service, queue, event bus, dispatcher, Langfuse exporter, Vite composition, worker main and their tests

**Interfaces:**

```ts
export interface AgentV2CloseOptions { signal: AbortSignal; deadlineAtMs: number; }
export interface AgentV2WorkerStopResult {
	completed: boolean;
	timedOutSteps: string[];
	errors: Array<{ step: string; code: string; message: string }>;
}
```

- [ ] **Step 1: RED tests** stall claim connect, XREAD, execution, dispatcher delivery and Langfuse fetch separately; total stop must return by the same deadline, list exact step and still attempt store close.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Thread one `deadlineAtMs`/AbortSignal** through stop, close and flush; each step uses remaining time, never resets its own full timeout.
- [ ] **Step 4: First SIGTERM writes sanitized stop result; second signal may force exit using existing policy.**
- [ ] **Step 5: Sync, focused tests, checks and commit `fix(web): bound agent v2 worker shutdown`.**

## Plan 03 Real Redis Verification

```powershell
$env:PI_TEST_REDIS_URL = "redis://127.0.0.1:6379"
Set-Location packages/web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/run-queue-redis.integration.test.ts test/agent-v2-run-event-bus-redis.integration.test.ts test/agent-v2-outbox-redis.integration.test.ts test/agent-v2-durable-live-redis.integration.test.ts
npm run check
Remove-Item Env:PI_TEST_REDIS_URL
git diff --check
```

Expected: no test skip/failure; Redis keys/streams from each test are cleaned; worktree contains only planned changes.
