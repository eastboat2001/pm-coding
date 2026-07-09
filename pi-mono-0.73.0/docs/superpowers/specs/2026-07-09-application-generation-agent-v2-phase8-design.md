# Application Generation Agent v2 Phase 8 Design

## Goal

Phase 8 hardens the real Application Generation Agent v2 production chain after the v1 generation surface has been removed. The phase proves that v2 can survive realistic queue, worker, event replay, diagnostic export, and deployment reset scenarios without relying on deleted v1 run API, worker, app-preview-goal, or legacy compatibility paths.

## Scope

Phase 8 covers four reliability tracks:

1. Redis queue, cancel key, and live event replay failure injection.
2. Worker crash, restart, lease expiry, reclaim, and long-run draining behavior.
3. Diagnostic export, Langfuse flushing, and SSE replay end-to-end acceptance.
4. v2 schema reset and production startup rehearsal for SQLite/PostgreSQL-capable runtime stores.

This is not a feature expansion phase. It should not reintroduce `PI_APP_AGENT_VERSION`, v1 service fallbacks, old run/session/message migrations, or app-preview-goal repair logic. The work may improve v2 adapters or test harnesses when the current adapter contract is too weak to make production behavior observable and deterministic.

## Current State

Phase 7 left the real v2 production path concentrated behind v2-named modules:

- `AgentV2RunApiService` creates, cancels, lists, and reads v2 runs.
- `createRedisAgentV2RunQueue` exposes Redis queue and cancel-key infrastructure behind a v2 adapter.
- `AgentV2WorkerService` claims queued v2 runs, executes v2 tasks, renews leases, handles cancel keys, interrupts owned runs on shutdown, and recovers expired active claims.
- `AgentV2RunEventLog` persists run events and `RedisAgentV2RunEventBus` supports live event reads.
- `vite-plugin.ts` exposes `/api/runtime/agent-v2/runs` routes and SSE event streaming with durable replay first.
- `WorkspaceDiagnosticExportService` exports v2 run, event, and diagnostic context.
- Worker bootstrap uses `agent-v2-runtime` and `runtime-infra` subpaths rather than the root barrel or old v1 product services.

Existing tests cover many unit-level behaviors. Phase 8 should raise coverage to production-shape acceptance by composing the real v2 API, queue, worker, event log, event bus, diagnostics, and reset routines.

## Architecture

Phase 8 uses production rehearsal harnesses rather than v1-compatible implementation paths.

The preferred design is to build small test harness utilities around current v2 contracts:

- A v2 runtime harness that wires `AgentV2RunApiService`, `AgentV2WorkerService`, `AgentV2RunEventLog`, `AgentV2RunEventBus`, queue, diagnostic sink, and runtime store.
- A fault-injection queue wrapper that can fail enqueue, claim, cancel, lease renewal, live read, or close calls without changing the production queue contract.
- A worker execution fixture that can block, crash, observe abort signals, produce task statuses, and emit deterministic diagnostics/events.
- A deployment rehearsal fixture that initializes schema, starts services, resets v2 data, restarts services, and verifies old v1 data is not read.

If a production adapter lacks a narrow hook needed for deterministic testing, add the smallest v2-specific hook or contract. Do not widen interfaces to match v1 behavior. Do not add compatibility aliases for old service names.

## Data Flow

The primary rehearsal flow is:

1. Initialize a v2-capable runtime store and ensure the v2 schema.
2. Construct the real v2 run API with the v2 queue adapter and run event log.
3. Start a v2 run through the API.
4. Claim and execute the run through `AgentV2WorkerService`.
5. Persist phase/diagnostic events through `AgentV2RunEventLog`.
6. Stream events through SSE with durable replay before live Redis reads.
7. Export diagnostic context by `runId` and verify it contains v2 run state, v2 events, v2 diagnostics, and sanitized config/session context where applicable.
8. Reset v2 runtime data with the confirmation token and verify v2 tables are cleared while old v1 state is neither required nor read.

## Failure Model

Phase 8 must cover these concrete failure modes:

- Queue enqueue failure marks a newly created run as interrupted and emits a retryable v2 enqueue diagnostic/event.
- Cancel key is honored while a worker is executing, including the race where API cancellation writes `cancelling` while the worker is still holding a lease.
- Live event bus read failure after SSE headers have been sent produces an SSE error event and closes the stream instead of hanging.
- Durable event replay sends persisted events once and does not duplicate them when live reads return overlapping sequence numbers.
- Worker stop/crash simulation interrupts owned running runs, releases/recovers active claims, and allows a replacement worker to reclaim queued work after lease expiry.
- Lease renewal failure aborts execution and prevents stale success/failure writes after the lease has been lost.
- Long-run draining leaves no queued, running, cancelling, or active-claim residue after mixed success, failure, cancellation, interruption, and reclaim scenarios.
- Diagnostic archive export includes v2 run events and diagnostics for a run-only export and does not depend on a legacy session record.
- Langfuse flushing is triggered in worker shutdown/error paths without blocking safe process termination.
- Schema bootstrap/reset is idempotent across fresh database, existing v2 database, and database containing stale v1 tables or rows.

## Testing Strategy

Phase 8 tests should be mostly deterministic unit/integration tests and should not require external services by default.

Required local tests:

- A production-chain harness test using in-memory or SQLite-backed store plus in-memory event bus/queue where external Redis/Postgres is not required.
- Fault-injection tests for queue, cancel, worker reclaim, SSE replay, and diagnostic export.
- Startup/reset rehearsal tests that run without Redis/Postgres by default and assert the same v2 schema lifecycle contracts used by the production entrypoints.

Optional environment-gated tests:

- Redis integration tests under the existing Redis guard.
- PostgreSQL integration tests under the existing PostgreSQL guard.

Skipped external-service tests must skip only because the service is unavailable. They must still typecheck and must not hide import, contract, or harness failures.

## Acceptance Criteria

Phase 8 is complete when:

- The v2 production-chain rehearsal can start a run, execute it, replay events, export diagnostics, and reset v2 state without touching v1 service paths.
- Fault injection proves queue/cancel/live event replay failures resolve to explicit terminal states or explicit SSE/export errors.
- Worker crash/restart/reclaim tests prove replacement workers can recover work without stale terminal writes.
- Diagnostic export and Langfuse flush behavior are covered for v2 run-only context.
- Schema reset and production startup rehearsal are idempotent and ignore old v1 data.
- Import boundary tests still reject old v1 generation service paths.
- Full package tests, typecheck, build, source map audit, and legacy surface audit pass.

## Non-Goals

- Do not implement a new LLM task executor in this phase.
- Do not migrate old v1 run/session/message/app-preview-goal data.
- Do not preserve a v1 fallback runtime path.
- Do not introduce broad deployment orchestration or Docker changes unless a failing rehearsal exposes a concrete v2 startup bug.
- Do not push until local development and final verification are complete.
