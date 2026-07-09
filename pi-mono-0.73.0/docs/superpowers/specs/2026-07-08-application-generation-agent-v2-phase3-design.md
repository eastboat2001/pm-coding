# Application Generation Agent v2 Phase 3 Design

## Goal

Build a v2-native Task Runtime Core for Application Generation Agent v2. Phase 3 turns the Phase 2 capability/spec/plan/task graph records into independently consumable runtime state: task selection, task transitions, artifact index queries, and deterministic context packets.

Phase 3 does not integrate v2 into the old worker execution loop. It creates a clean v2 core that later phases can wire into a new v2 worker adapter.

## Non-Negotiable Architecture Constraints

- v2 correctness takes precedence over compatibility with the old application generation agent.
- New v2 runtime core modules must not import or reuse old application-generation decision modules:
  - `apps/pi-coding-web/src/runtime/capability-planner.ts`
  - `apps/pi-coding-web/src/runtime/spec-artifact.ts`
  - `apps/pi-coding-web/src/runtime/context-orchestrator.ts`
  - old preview-goal continuation repair logic
- If old application generation logic conflicts with v2 correctness, later phases may delete, isolate, or replace it. No long-term v1/v2 compatibility target exists.
- Application Generation Agent v2 is the only supported runtime target. Older v1 code is not a selectable product path and may only be deleted, isolated, or bypassed.
- v2 must not read legacy `sessions`, `messages`, `runs`, `run_events`, `app_preview_goals`, or preview-goal continuation data as v2 state.
- v2 may reuse infrastructure adapters only through anti-corruption boundaries: RuntimeStore, diagnostics sink, run events, worker lifecycle, queue/cancel/live stream, static build/preview primitives.
- Phase 3 must stay below execution/tool governance/validation/repair. It prepares the runtime core those later phases will consume.

## Current State After Phase 2

Phase 2 added v2 planning records and persistence:

- v2 run state in `agent_v2_runs`
- v2 task rows in `agent_v2_tasks`
- v2 artifact rows in `agent_v2_artifacts`
- v2 document rows in `agent_v2_documents`
- v2 diagnostic rows in `agent_v2_diagnostics`
- deterministic capability routing, spec document, plan document, task graph, and planning bootstrap

The old worker path still constructs the old agent runtime in `apps/pi-coding-web/src/worker/main.ts:createRunAgent`. That path still builds old `CapabilityPlan`, old `SpecArtifact`, and old context packets. Phase 3 must not extend that old logic.

## Chosen Approach

Use a strengthened standalone v2 core:

1. Add v2-native task engine.
2. Add v2-native artifact index query layer.
3. Add v2-native context packet builder.
4. Add a small v2 runtime core facade that composes the three.
5. Add import-boundary tests preventing v2 core from importing old application-generation logic.

This is intentionally not a worker integration. Phase 5 will replace the old worker path with a v2 worker adapter after v2 task/context/tool/validation primitives are independently tested.

## Modules

### `packages/web-workspace/src/agent-v2-task-engine.ts`

Responsibility: deterministic task graph consumption and task state transition.

Public API:

```ts
export interface AgentV2TaskSelection {
  activeTask?: AgentV2TaskNode;
  blockedTasks: AgentV2TaskNode[];
  completedTasks: AgentV2TaskNode[];
  pendingTasks: AgentV2TaskNode[];
  reason: "ready" | "complete" | "blocked_by_dependencies" | "failed_dependency" | "empty_graph";
  nextBestStep: string;
}

export interface AgentV2TaskTransitionInput {
  task: AgentV2TaskNode;
  status: AgentV2TaskStatus;
  now?: () => string;
  output?: JsonObject;
  error?: AgentV2TaskError;
}

export function selectNextAgentV2Task(tasks: AgentV2TaskNode[]): AgentV2TaskSelection;
export function transitionAgentV2Task(input: AgentV2TaskTransitionInput): AgentV2TaskNode;
```

Rules:

- Select the first pending task whose dependencies are complete.
- Do not skip failed dependencies.
- Running tasks are returned as active before new pending work.
- Terminal all-complete graph returns `reason: "complete"`.
- Empty graph returns `reason: "empty_graph"`.
- Transitions stamp `startedAt` and `endedAt` deterministically through `now`.
- Failed/blocked tasks must carry structured `error`.

### `packages/web-workspace/src/agent-v2-artifact-index.ts`

Responsibility: deterministic query and summary layer over v2 artifact records.

Public API:

```ts
export interface AgentV2ArtifactIndexQuery {
  taskId?: string;
  kind?: AgentV2ArtifactRecord["kind"];
  validationStatus?: AgentV2ArtifactRecord["validationStatus"];
  pathPrefix?: string;
}

export interface AgentV2ArtifactIndexEntry {
  artifactId: string;
  kind: AgentV2ArtifactRecord["kind"];
  path: string;
  mediaType: string;
  sourceTaskId?: string;
  validationStatus: AgentV2ArtifactRecord["validationStatus"];
  version: string;
  updatedAt: string;
}

export interface AgentV2ArtifactIndex {
  entries: AgentV2ArtifactIndexEntry[];
  byTaskId: Record<string, AgentV2ArtifactIndexEntry[]>;
  pendingValidation: AgentV2ArtifactIndexEntry[];
}

export function buildAgentV2ArtifactIndex(
  artifacts: AgentV2ArtifactRecord[],
  query?: AgentV2ArtifactIndexQuery,
): AgentV2ArtifactIndex;
```

Rules:

- Do not read files or infer missing artifacts.
- Preserve stable ordering by updated time then artifact id.
- The index is derived from v2 artifact rows only.

### `packages/web-workspace/src/agent-v2-context-packet.ts`

Responsibility: build a compact v2 context packet from v2 state records.

Public API:

```ts
export interface AgentV2ContextPacketInput {
  run: AgentV2RunSnapshot;
  documents: AgentV2DocumentRecord[];
  tasks: AgentV2TaskNode[];
  artifacts: AgentV2ArtifactRecord[];
  diagnostics: AgentV2DiagnosticEvent[];
  now?: () => string;
  tokenBudgetHint?: number;
}

export interface AgentV2ContextPacket {
  schemaVersion: 1;
  runId: string;
  clientId: string;
  phase: AgentV2RunSnapshot["phase"];
  objective: string;
  capabilityDecision?: AgentV2CapabilityDecision;
  platformContract?: AgentV2PlatformContract;
  specSummary?: string;
  planSummary?: string;
  activeTask?: AgentV2TaskNode;
  completedTasks: Array<Pick<AgentV2TaskNode, "taskId" | "title" | "status">>;
  pendingTasks: Array<Pick<AgentV2TaskNode, "taskId" | "title" | "dependsOn" | "status">>;
  openProblems: AgentV2ContextProblem[];
  artifactIndex: AgentV2ArtifactIndex;
  requiredRereads: AgentV2ArtifactIndexEntry[];
  validationStatus: "not_started" | "pending" | "passed" | "failed";
  nextBestStep: string;
  createdAt: string;
}

export function buildAgentV2ContextPacket(input: AgentV2ContextPacketInput): AgentV2ContextPacket;
export function renderAgentV2ContextPacketMarkdown(packet: AgentV2ContextPacket): string;
```

Rules:

- Do not consume old chat history or old context compaction.
- Derive objective from v2 run input and/or spec document.
- Use document rows for capability/spec/plan summaries.
- Use task rows for active/completed/pending state.
- Use artifact rows for required rereads and file/artifact memory.
- Use v2 diagnostics for open problems.
- Output must be deterministic with a supplied `now`.

### `packages/web-workspace/src/agent-v2-runtime-core.ts`

Responsibility: compose v2 task selection, artifact index, context packet, and persistence through RuntimeStore.

Public API:

```ts
export interface AgentV2RuntimeSnapshot {
  run: AgentV2RunSnapshot;
  documents: AgentV2DocumentRecord[];
  tasks: AgentV2TaskNode[];
  artifacts: AgentV2ArtifactRecord[];
  diagnostics: AgentV2DiagnosticEvent[];
  taskSelection: AgentV2TaskSelection;
  contextPacket: AgentV2ContextPacket;
}

export async function loadAgentV2RuntimeSnapshot(
  store: RuntimeStore,
  clientId: string,
  runId: string,
  options?: { now?: () => string },
): Promise<AgentV2RuntimeSnapshot | undefined>;

export async function advanceAgentV2Task(
  store: RuntimeStore,
  input: {
    clientId: string;
    runId: string;
    taskId: string;
    status: AgentV2TaskStatus;
    output?: JsonObject;
    error?: AgentV2TaskError;
    now?: () => string;
  },
): Promise<AgentV2TaskNode>;
```

Rules:

- Runtime core may use RuntimeStore v2 methods only.
- It must not call legacy session/message/run APIs.
- It must not call old app runtime modules.
- It may append v2 diagnostics for invalid transitions.

## Import Boundary

Add a test that scans new v2 core files and fails if they import old application generation modules. The forbidden imports are:

- `apps/pi-coding-web/src/runtime/capability-planner`
- `apps/pi-coding-web/src/runtime/spec-artifact`
- `apps/pi-coding-web/src/runtime/context-orchestrator`
- `apps/pi-coding-web/src/runtime/app-preview-goal`
- `apps/pi-coding-web/src/runtime/preview-goal`

This is a deliberate architectural guardrail. Later phases may delete or replace old code; Phase 3 must not depend on it.

## Data Model Additions

Prefer no schema changes in Phase 3. Existing v2 tables already represent the state required for this phase.

If implementation reveals a missing field, add it only when the runtime core cannot derive the value from existing v2 records. Any new field must be added to SQLite and PostgreSQL stores together and covered by store contract tests.

## Test Strategy

Unit tests:

- `agent-v2-task-engine.test.ts`
  - selects first dependency-ready task
  - keeps running task active
  - blocks pending task when dependency failed
  - returns complete when all terminal tasks completed
  - transitions started/ended/error timestamps correctly
- `agent-v2-artifact-index.test.ts`
  - groups artifacts by source task
  - filters by task/kind/status/path prefix
  - identifies pending validation artifacts
- `agent-v2-context-packet.test.ts`
  - builds packet from v2 run/doc/task/artifact/diagnostic records
  - includes active task, completed tasks, open problems, artifact index, required rereads
  - renders stable markdown without old chat history
- `agent-v2-runtime-core.test.ts`
  - loads runtime snapshot using only v2 store methods
  - advances task and persists transition
  - rejects invalid task transitions with v2 diagnostic
- `agent-v2-import-boundary.test.ts`
  - fails if new v2 core imports old app-generation runtime modules

Integration tests:

- create v2 run
- persist Phase 2 planning bootstrap
- load v2 runtime snapshot
- select active task
- mark active task complete
- verify next task becomes active
- verify context packet reflects transition and artifact index

## Phase 3 Done Criteria

- v2 task graph can be consumed independently of old agent runtime.
- v2 runtime snapshot can be loaded from RuntimeStore without legacy reads.
- v2 context packet can be generated from v2 records only.
- v2 artifact index is deterministic and task-aware.
- Import-boundary tests prevent accidental reuse of old application-generation logic.
- Package and root checks pass.

## Follow-On Phases

Phase 4:

- v2 tool governance.
- validation gates.
- repair action model.

Phase 5:

- new v2 worker adapter.
- replace old `createRunAgent` path rather than mixing v2 into it.

Phase 6:

- reset/data cleanup.
- quality regression suite.
- default switch.
- old agent code deletion or isolation.
