# Phase 10 Preflight 04: Browser Migration, Cleanup, and Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 browser 只投影 v2 DTO/event，删除旧 continuation/planner/context/prompt 与高置信度死代码，严格化配置/readiness，并通过全部 preflight gate。

**Architecture:** Browser controller 消费 `AgentV2RunEventRecord` 的 discriminated payload，经一个小 `AgentV2BrowserRunSink` Adapter 更新现有 UI state，不再 cast `AgentEvent`。配置解析和 dependency readiness 各由一个深 Module 负责；删除只在 CodeGraph、rg、exports、tests 和 mirror 证据同时满足时进行。

**Tech Stack:** TypeScript、PI browser Agent state Adapter、Vite middleware、Redis/PostgreSQL readiness、CodeGraph、Vitest、Vite production build。

## Global Constraints

- 继承 master plan 全部约束。
- Browser 不得解析旧 toolResult continuation，不得调用旧 capability planner/context orchestrator/coding prompt。
- 可以保留 UI state 所需的 PI Agent 对象，但不能把 v2 payload cast 成 `AgentEvent` 或调用 `applyRemoteEvent()`。
- 删除源 TS 时同步删除其 JS/map；当前 v2 `agent-v2-types.ts` 不得删除。
- 远程 deployment 目录保持零 diff。

**Mandatory commit gate:** 每个 Task 在 `git commit` 前都必须从仓库根目录运行 `npm run check` 与 `git diff --check`；任一失败即不得提交。

---

### Task 1: Replace Remote AgentEvent Replay with a v2 Browser Projection

**Files:**
- Create: `apps/pi-coding-web/src/runtime/agent-v2-browser-controller.ts`
- Create: `apps/pi-coding-web/test/agent-v2-browser-controller.test.ts`
- Modify: `apps/pi-coding-web/src/app/bootstrap.ts`, `runtime/agent-v2-run-client.ts`
- Delete after migration: `apps/pi-coding-web/src/runtime/remote-agent-controller.ts`, `apps/pi-coding-web/test/remote-agent-controller.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

**Interfaces:**

```ts
export interface AgentV2BrowserRunSink {
	beginRun(runId: string): void;
	setPhase(phase: AgentV2Phase, status: AgentV2RunStatus): void;
	setTask(event: AgentV2TaskUpdatedPayload): void;
	setArtifact(event: AgentV2ArtifactIndexedPayload): void;
	setValidation(event: AgentV2ValidationRecordedPayload): void;
	appendOutput(event: AgentV2OutputRecordedPayload): void;
	appendDiagnostic(event: AgentV2DiagnosticRecordedPayload): void;
	settle(status: AgentV2RunStatus, error?: AgentV2Error): void;
}
export class AgentV2BrowserController {
	constructor(sink: AgentV2BrowserRunSink);
	start(run: AgentV2RunSnapshot): void;
	apply(event: AgentV2RunEventRecord): void;
	hydrate(events: readonly AgentV2RunEventRecord[], afterSeq: number): void;
	get activeRunId(): string | undefined;
	get lastSeq(): number;
}
```

- [ ] **Step 1: RED tests** cover start/run mismatch, seq sorting/de-duplication, each v2 payload, reconnect checkpoint, terminal settle without synthetic AgentEvent and output-to-assistant UI projection.
- [ ] **Step 2: RED boundary test** rejects `payload as AgentEvent`, `applyRemoteEvent`, `agent_start`, `agent_end`, `message_end` and old remote controller import in generation path.
- [ ] **Step 3: Implement controller and a bootstrap-local sink Adapter** that mutates only documented UI fields/messages; an output event becomes a local assistant display record with v2 provider/model/usage summary, not a replayed provider event.
- [ ] **Step 4: Migrate SSE drain/connect/terminal flow, delete old Module/test, run full app focused tests and web boundary test.**
- [ ] **Step 5: Run app check and commit `refactor(web): project agent v2 events directly in browser`.**

### Task 2: Remove Browser Legacy Planning and Continuation Modules

**Files:**
- Delete: `apps/pi-coding-web/src/runtime/remote-resume.ts`, `runtime/capability-planner.ts`, `runtime/context-orchestrator.ts`, `prompts/coding-system-prompt.ts`
- Delete matching tests: `remote-resume.test.ts`, `capability-planner.test.ts`, `context-orchestrator.test.ts`, `coding-system-prompt.test.ts`
- Modify: `apps/pi-coding-web/src/app/bootstrap.ts`, `runtime/agent-v2-run-client.ts`, `runtime/project-file-seed.ts` and any remaining caller proven by `rg`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

- [ ] **Step 1: Add RED deletion/import tests** and behavior tests proving a new run submits objective/message/attachments/projectFiles and only stable model `{provider,id}` once, rejects client transport/baseUrl/credential fields, interrupted run never auto-creates continuation, and UI still renders terminal output/diagnostic from v2 events.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Remove `currentCapabilityPlan`, dynamic old system prompt, `startRemoteContinuationRun`, resumed-session tracking and `resumeInterruptedToolResultSession` calls.**
- [ ] **Step 4: Project inputs into the strict v2 start schema.** Send project file bytes once as `{filename,content,encoding?}`; send attachments only as safe `{type,fileName,mimeType,projectFilePath}` descriptors pointing at those files; strip raw attachment content/extractedText and full model transport fields from the request/message. Reject an attachment without a canonical project file instead of silently dropping it.
- [ ] **Step 5: Delete Modules/tests; do not introduce compatibility wrappers or feature flags.**
- [ ] **Step 6: Run app full focused suite, boundary test, app check and commit `refactor(web): remove legacy browser generation flow`.**

### Task 3: Fail Fast on Invalid Config and Probe Dependencies at Startup

**Files:**
- Create: `packages/web-workspace/src/agent-v2-readiness.ts` plus mirrors
- Create: `packages/web-workspace/test/agent-v2-readiness.test.ts`
- Create: `packages/web-workspace/test/agent-v2-readiness-postgres.integration.test.ts`
- Modify: `packages/web-workspace/src/config.ts`, `types.ts`, `agent-v2-run-queue.ts`, `agent-v2-run-event-bus.ts`, `vite-plugin.ts` plus mirrors
- Modify: `apps/pi-coding-web/src/worker/main.ts`
- Modify tests: `config-diagnostics.test.ts`, `vite-plugin-schema-init.test.ts`, `agent-v2-vite-plugin-routes.test.ts`, `worker-schema-init.test.ts`, `worker-runtime-diagnostics.test.ts`

**Interfaces:**

```ts
export interface AgentV2ReadinessDependency { readonly name: string; check(signal: AbortSignal): Promise<void>; }
export interface AgentV2ReadinessReport { ready: boolean; checkedAt: string; dependencies: Array<{ name: string; ready: boolean; code?: string; message?: string }>; }
export class AgentV2Readiness {
	constructor(dependencies: readonly AgentV2ReadinessDependency[]);
	check(input: { signal: AbortSignal; checkedAt: string }): Promise<AgentV2ReadinessReport>;
}
```

Add queue/event bus `ping(signal)` Adapter methods. Config helpers distinguish unset from invalid; invalid `PI_RUNTIME_STORE`, integer, boolean, URL/origin, container resource, outbox/worker timeout values throw typed error mentioning variable name only.

- [ ] **Step 1: RED config tests** cover typo enum, zero/negative/non-number, invalid boolean and credentialed URL; unset still defaults.
- [ ] **Step 2: RED readiness tests** cover store/Redis queue/event success, timeout/failure sanitization, `/status` 503 until ready, startup schema/Redis failure surfacing before accepting run requests, dependency loss after startup, cache expiry/coalescing, and recovery. Add real PostgreSQL integration requiring `PI_TEST_POSTGRES_URL` to prove transaction/readiness success and 503 after the connection is made unavailable; never print the URL.
- [ ] **Step 3: Implement strict parsers and readiness Module.** Vite `configureServer` performs a blocking startup check before route registration. `/status` and every run mutation call a coalesced dynamic check whose success cache is at most 1 second old; a failed check invalidates readiness immediately and returns sanitized 503, while the next successful check restores readiness. A background interval refreshes the same coalesced state. Worker performs the same initial and periodic dependency checks and stops claiming while unavailable.
- [ ] **Step 4: Sync, focused tests, checks and commit `fix(web-workspace): fail fast on invalid runtime dependencies`.**

### Task 4: Delete Proven Dead Code and Retired Public Surface

**Files:**
- Delete: `packages/web-workspace/src/node-service-runtime.ts`
- Modify: `packages/web-workspace/src/json.ts` plus mirrors to remove `cloneJsonObject`
- Delete: `apps/pi-coding-web/src/runtime/run-client.ts`, `apps/pi-coding-web/test/run-client.test.ts`
- Modify: `packages/web-workspace/src/types.ts` plus mirrors to remove the audited old DTO symbols
- Modify: `packages/web-workspace/src/agent-v2-run-api-service.ts`, `agent-v2-runtime-store.ts`, barrels plus mirrors to migrate/delete `AgentV2RunStore` alias
- Modify: `packages/web-workspace/src/agent-v2-run-event-log.ts` and tests to remove `readLive` after export check
- Modify: `packages/web-workspace/src/agent-v2-state-machine.ts` and callers/tests to remove `getReadyAgentV2TaskIds`
- Modify: `packages/web-workspace/src/vite-plugin.ts` plus mirror to remove v1 SSE record union
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`

- [ ] **Step 1: Record CodeGraph/rg/export evidence** in the task commit message notes: zero callers for node runtime/clone helper; private dead run-client; exact current callers for aliases/public methods migrated first.
- [ ] **Step 2: Add RED deny/public-surface tests** for files/symbols and ensure `agent-v2-types.ts` remains exported.
- [ ] **Step 3: Migrate callers to the single v2 Interface, then delete sources/tests/mirrors.** Never delete a whole types file for individual symbols.
- [ ] **Step 4: Run affected tests, mirror sync/audit, CodeGraph sync/status and app/web checks.**
- [ ] **Step 5: Commit `refactor(agent-v2): delete retired and shallow runtime code`.**

### Task 5: Audit All Mirrors and Product Boundaries

**Files:**
- Modify: `packages/web-workspace/test/source-mirror-script.test.ts`
- Modify: `packages/web-workspace/test/agent-v2-production-path-import-boundary.test.ts`
- Modify: `packages/web-workspace/package.json` only if an explicit all-current-sources audit script is needed

- [ ] **Step 1: Add RED full audit test** enumerating every tracked `src/*.ts` except declaration files and intentional `node-service-runtime.ts` deletion; require same-name JS/map, relative source, exact sourcesContent and no orphan JS/map.
- [ ] **Step 2: Add forbidden-surface scan** for removed v1 modules, old prompt/continuation, AgentEvent casts, host build commands, v1 SSE union and retired config.
- [ ] **Step 3: Run audit, repair only via targeted sync/delete, then `codegraph sync` and `codegraph status`.**
- [ ] **Step 4: Commit `test(agent-v2): enforce source and v2 production boundaries`.**

### Task 6: Full Preflight Verification and Whole-Branch Review

**Files:** No planned production changes. Any verification fix requires its own RED test and focused commit.

- [ ] **Step 1: Full web-workspace tests with real Redis**

```powershell
$env:PI_TEST_REDIS_URL = "redis://127.0.0.1:6379"
Set-Location packages/web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run --exclude test/workspace.test.mjs
node test/workspace.test.mjs
Remove-Item Env:PI_TEST_REDIS_URL
```

Expected: all Vitest and 34 Node scenarios PASS; no Redis skip.

- [ ] **Step 2: Real PostgreSQL durable/readiness integration**

```powershell
if (-not $env:PI_TEST_POSTGRES_URL) { throw "PI_TEST_POSTGRES_URL is required for Phase 10 preflight" }
Set-Location packages/web-workspace
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run test/agent-v2-postgres-durable.integration.test.ts test/agent-v2-readiness-postgres.integration.test.ts
```

Expected: both tests PASS against the local Docker PostgreSQL; no skip and no credential output.

- [ ] **Step 3: Full pi-coding-web tests**

```powershell
Set-Location ../../apps/pi-coding-web
& ..\..\node_modules\.bin\tsx.cmd ..\..\node_modules\vitest\dist\cli.js --run --config vitest.config.ts
```

Expected: all tests PASS.

- [ ] **Step 4: TypeScript checks**

```powershell
Set-Location ../..
npm run check
```

Expected: exit 0 with no errors, warnings or infos; inspect any formatter modifications before staging.

- [ ] **Step 5: Worker and frontend production builds without forbidden npm build scripts**

```powershell
Set-Location packages/web-workspace
& ..\..\node_modules\.bin\tsgo.cmd -p tsconfig.build.json
Set-Location ../../apps/pi-coding-web
& ..\..\node_modules\.bin\tsgo.cmd -p tsconfig.worker.json
& ..\..\node_modules\.bin\vite.cmd build
```

Expected: worker TypeScript and Vite production build exit 0.

- [ ] **Step 6: Isolated BuildRunner integration**

Resolve local approved build and proxy image RepoDigests into `PI_TEST_BUILD_CONTAINER_IMAGE` and `PI_TEST_BUILD_PROXY_IMAGE`; run `ephemeral-container-build-runner.integration.test.ts` with engine/images required. Expected: PASS, not SKIP, denied direct/off-allowlist/IP egress, and no residual test proxy/container/network/volume.

- [ ] **Step 7: Repository integrity**

```powershell
Set-Location ../..
codegraph sync
codegraph status
git diff --check
git status --short
git status --short -- docker/pi-coding-web
docker compose -f docker/pi-coding-web/docker-compose.yaml config
docker compose -f docker/pi-coding-web/docker-compose.yaml --profile cutover config
```

Expected: CodeGraph index current; diff check empty; remote deployment directory empty; ordinary and cutover-profile Compose configs both resolve; only planned branch changes, and worktree clean after commits.

- [ ] **Step 8: Independent whole-branch review**

Generate a review package from `b0fd9b65d0a7bfa3fb6a0e9b1d5d0ce8ceaf8dc0` to HEAD. Reviewer checks the approved design, four plans, v2-only constraints, security, real Adapter semantics, deletion evidence and test quality. Fix every Blocker/Important via TDD and repeat Steps 1-7 plus review.

- [ ] **Step 9: Stop before real E2E**

Report exact commits, test counts, build evidence, remaining Minor items and reviewer verdict. Do not start model-paid generation, web/worker runtime, cutover rehearsal or crash/cancel/SSE E2E until the user explicitly approves the preflight result.
