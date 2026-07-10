# Application Generation Agent v2 Phase 9 Design

## Goal

Phase 9 prepares the Application Generation Agent v2 production cutover and removes the final v1-shaped product seams. After this phase, application generation has one runtime, one configuration vocabulary, one queue/event contract, and one production store factory. Rollback means deploying an earlier code version; the running process does not contain a v1 fallback.

## Constraints

- Application Generation Agent v2 is the only product runtime.
- Do not preserve v1 module interfaces, prompt flows, spec/plan/task artifacts, preview-goal repair, run/session/message data, or diagnostic test data.
- Do not read legacy run data through v2 stores, queue adapters, event adapters, or HTTP handlers.
- PostgreSQL, Redis, worker lifecycle, durable events/SSE replay, diagnostic/Langfuse export, static build/validation/preview, and Docker/Podman infrastructure may remain only behind v2 interfaces.
- `PI_APP_AGENT_VERSION` and legacy `PI_RUN_*` generation settings are invalid configuration, not compatibility switches.
- Rollback is code redeployment. Data rollback and an in-process v1/v2 switch are non-goals.
- Do not push until all local implementation and verification are complete.

## Current Findings

The production run API, worker, state machine, task graph, event log, SSE replay, diagnostics, and schema reset are v2 modules and passed the Phase 8 hardening suites. Four residual problems remain:

1. `selectApplicationGenerationRuntime(input)` exposes `requestedVersion` and `allowDebugV1` even though no production caller uses it. By the deletion test, this is a shallow Module whose Interface only preserves retired vocabulary.
2. `agent-v2-run-queue.ts` is a pass-through Adapter over the legacy `RunQueue`. The v2 Interface is sound, but its Implementation and test fixtures still depend on v1-named queue types.
3. `legacy-v1-agent-v2-run-event-bridge.ts`, `RunEventSink`, and the legacy event bus exist only for old tests. The v2 production path already has `AgentV2RunEventLog` and `AgentV2RunEventBus`.
4. `StorageConfig` still exposes unused `runsEnabled`, legacy queue/event/checkpoint/retry fields, and `createRuntimeStore()` returns the broad legacy `RuntimeStore` Interface. Production callers compensate with casts.

There is no project `CONTEXT.md` or relevant `docs/adr` decision to preserve. Domain names in this design therefore follow the established Agent v2 state, run, task, artifact, validation, diagnostic, queue, and event vocabulary.

## Considered Approaches

### 1. Remove only the v1 selector

This is the smallest change, but it leaves the v2 queue and production store seams dependent on legacy Interfaces. It improves naming without improving Locality or making old Implementation deletable. Rejected.

### 2. Hard-delete internal v1 paths and keep inert HTTP tombstones

This removes retired selectors, configuration, queue/event/retry Modules, and legacy test doubles. The old HTTP prefixes remain as stateless `410 Gone` responses for one operationally useful seam. They never construct a legacy Adapter, read legacy data, enqueue work, or stream events. Recommended.

### 3. Delete both internals and old HTTP prefixes immediately

This has the smallest runtime surface, but old clients receive an ambiguous generic `404` during rollout. It weakens production diagnosis without reducing meaningful Implementation complexity. Rejected for Phase 9; tombstones can be removed in a later cleanup after rollout evidence shows no callers.

## Architecture

### Runtime identity

The dead application-generation selector Module is deleted. v2 modules identify themselves by their v2 names and contracts; there is no runtime version-selection Interface and no `v1Disabled` metadata.

### Queue seam

`AgentV2RunQueue` remains the only queue Interface. Its in-memory and Redis Adapters move behind that seam and operate directly on `AgentV2RunQueueIdentity`, `AgentV2ActiveRunClaim`, cancel keys, lease timestamps, and queue cleanup results. The shallow `createAgentV2RunQueue(legacyQueue)` wrapper and the legacy `RunQueue` Module are deleted.

This produces Leverage because API, worker, maintenance, stress, and fault-injection tests use one v2 Interface. It improves Locality because queue keys, lease ownership, cancellation, reclaim, and cleanup behavior live in one v2 Module.

### Event seam

`AgentV2RunEventLog` owns durable persistence and publishes through `AgentV2RunEventBus`. The old `RunEventSink`, old `RunEventBus`, and v1-to-v2 bridge are deleted. Tests that need stale v1 rows seed the store directly and only prove isolation; they do not exercise a compatibility Adapter.

### Configuration seam

`StorageConfig` contains a nested `agentV2` configuration value with:

```ts
export interface AgentV2RuntimeConfig {
  queueName: string;
  eventStreamMaxLen: number;
  eventStreamTtlSeconds: number;
}
```

Only `PI_AGENT_V2_RUN_QUEUE_NAME`, `PI_AGENT_V2_RUN_EVENT_STREAM_MAXLEN`, and `PI_AGENT_V2_RUN_EVENT_STREAM_TTL_SECONDS` populate this value. `loadStorageConfig()` rejects `PI_APP_AGENT_VERSION` and retired generation variables from both process environment and the configured `.env` file. A stale deployment therefore fails fast with a diagnostic configuration error instead of silently ignoring operator intent.

### Production store seam

`createAgentV2RuntimeStore(config)` replaces `createRuntimeStore(config)` in the web and worker production entries. Its return Interface is the exact intersection needed by v2 schema initialization, run API, worker execution, event log, diagnostic export, reset, and close. PostgreSQL and SQLite remain concrete infrastructure Adapters; callers no longer import or cast the legacy `RuntimeStore` Interface.

### Retired HTTP seam

The Vite middleware recognizes `/api/runtime/runs`, `/api/pi-runs`, `/api/runs`, and `/api/pi-sessions` only as retired prefixes. It returns deterministic JSON `410 Gone`; removed app-preview-goal routes return deterministic `404`. The handler has no injected legacy run/session service and cannot read a legacy store.

### Production rehearsal

A Node-based cutover rehearsal command validates the deployed web/worker chain after Compose startup. It checks storage health, v2 run creation/read/events/cancel behavior, legacy tombstones, and terminal/replay visibility within bounded timeouts. Destructive reset remains an explicit operator step documented separately and requires the existing confirmation token; the rehearsal command never deletes data by default.

## Data Flow

1. Web and worker load configuration and reject retired generation variables.
2. `createAgentV2RuntimeStore()` creates the selected PostgreSQL or SQLite Adapter and initializes only the v2 schema contract used by the entry.
3. The web entry creates the direct Redis `AgentV2RunQueue` Adapter, `RedisAgentV2RunEventBus`, durable `AgentV2RunEventLog`, and `AgentV2RunApiService`.
4. `POST /api/agent-v2/runs/start` persists a v2 run/event and enqueues a v2 identity.
5. The worker claims the identity, executes the v2 task graph, renews the lease, observes the cancel key, persists events/diagnostics, and reaches a terminal state.
6. SSE replays durable events first and then reads the live v2 event stream without legacy event translation.
7. The rehearsal command verifies the flow and the inert retired-route responses.

## Failure Model

- A retired configuration variable makes startup fail with the exact offending names.
- An invalid or empty v2 queue identity is rejected before Redis or in-memory state changes.
- A lease can be completed, renewed, requeued, or reclaimed only by its owner and current lease record.
- A cancel key is scoped by client and run, expires, and is cleared by completion/reset.
- Event replay never reads or translates legacy `run_events` through a compatibility bridge.
- A missing Redis/PostgreSQL dependency fails startup or rehearsal explicitly; it does not select a v1 path.
- Rehearsal timeouts report the last observed run state and event sequence.

## Data Reset and Rollback

Production cutover starts from a fresh v2 schema or an explicit v2 reset. Old run/session/message/app-preview-goal data is not migrated and is not consulted. Docker/Podman reset instructions may remove application data and PostgreSQL/Redis volumes when the operator confirms that no data must be preserved.

Rollback consists of redeploying the previous image/code version. Phase 9 does not keep dual schemas synchronized, restore discarded test data, or expose a runtime feature flag.

## Testing Strategy

- TDD for each behavior change: failing focused test, minimal implementation, focused green run, then package regression.
- Queue contract tests run against the direct in-memory Adapter; environment-gated Redis tests run against the direct Redis Adapter.
- Import-boundary tests require deleted v1 files and selector/config symbols to remain absent.
- Route tests construct no legacy run/session service and verify fixed tombstone responses.
- Configuration tests cover process env, `.env`, v2 defaults/overrides, and retired-variable rejection.
- Store factory tests verify PostgreSQL/SQLite selection through the v2 production Interface without caller casts.
- Rehearsal tests use a local HTTP harness and fake clock/sleep to cover success, timeout, failure, cancellation, and replay.
- Final verification includes both package test suites, checks, browser build, worker build, source mirror/map audit, and a repository-wide retired-surface search.

## Acceptance Criteria

- No production or test file contains a v1 runtime selector, `allowDebugV1`, or `v1Disabled` product metadata.
- v2 queue production/test code does not import `run-queue.ts`; legacy queue and retry Modules are deleted.
- legacy event bridge, event sink, event bus, and their dedicated tests are deleted.
- production web/worker entries use `config.agentV2` and `createAgentV2RuntimeStore()` without legacy store casts.
- retired generation environment variables fail fast and do not alter v2 behavior.
- old HTTP prefixes are inert tombstones with no legacy service/store dependency.
- the live cutover rehearsal command is documented and test-covered.
- all local verification passes before any push or production deployment.

## Non-Goals

- Migrating or recovering old v1 data.
- Preserving a v1 debug flag or runtime selection Interface.
- Rewriting PostgreSQL or SQLite storage engines when their v2 Adapter behavior is already verified.
- Removing the temporary HTTP tombstones before production rollout evidence is available.
- Pushing the branch or deploying production in this phase.
