# Application Generation Agent v2 Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v2-native runtime core that consumes v2 run/task/document/artifact/diagnostic state without relying on the legacy application generation agent.

**Architecture:** Phase 3 adds small, focused `agent-v2-*` modules under `packages/web-workspace/src`: a task engine, artifact index, context packet builder, and runtime core facade. These modules read and write only the v2 store surface introduced in Phases 1-2, and import-boundary tests make legacy agent internals an explicit failure. Worker integration is intentionally out of scope for this phase so the v2 runtime model can stabilize before it owns execution.

**Tech Stack:** TypeScript ESM (`moduleResolution: Node16`), `@mariozechner/pi-web-workspace`, v2 `RuntimeStore`, Vitest via `tsx`, source-adjacent generated `.js/.js.map` files matching the existing package layout.

## Global Constraints

- All implementation must happen in `C:\VibeCoding\pm-coding-agent-v2-phase3\pi-mono-0.73.0` on branch `codex/app-agent-v2-phase3`.
- v2 correctness, diagnosability, task state machine quality, and validation/repair readiness take priority over compatibility with the old generation agent.
- New v2 runtime modules must not import or call `apps/pi-coding-web/src/runtime/capability-planner.ts`, `apps/pi-coding-web/src/runtime/spec-artifact.ts`, `apps/pi-coding-web/src/runtime/context-orchestrator.ts`, or old preview-goal continuation repair logic.
- Phase 3 must not read legacy `sessions`, `messages`, `runs`, `run_events`, `app_preview_goals`, or app preview goal event tables as v2 runtime state.
- Phase 3 must not require old prompt flow, old spec/plan/tasks file generation, old agent module interfaces, or old preview goal continuation behavior.
- `PI_APP_AGENT_VERSION` may remain only as a temporary development/debug switch outside this package; no Phase 3 API may encode v1/v2 long-term compatibility.
- Reuse only infrastructure adapters that are already cleanly separated: v2 `RuntimeStore` methods, v2 schema management, run event persistence, diagnostics, and static build/validate/preview primitives. Do not wrap old generation behavior as a v2 dependency.
- Do not run root `npm run dev`, root `npm run build`, or root `npm run test`. Root `npm run check` is allowed as final verification. Package-level `npm run build`, `npm run check`, and focused Vitest commands are allowed.
- Use TDD for each feature task: add failing tests first, implement the minimum production code, run the focused tests, then commit the task.
- Manual file edits must use `apply_patch`. Mechanical generated `.js/.js.map` refresh may use the package TypeScript compiler or an existing generation command.

---

## File Structure

- `packages/web-workspace/src/agent-v2-task-engine.ts`
  Owns pure task graph selection and task status transitions for `AgentV2TaskNode[]`.
- `packages/web-workspace/src/agent-v2-artifact-index.ts`
  Owns deterministic artifact indexing, filtering, and validation queue views for `AgentV2ArtifactRecord[]`.
- `packages/web-workspace/src/agent-v2-context-packet.ts`
  Builds deterministic, serializable v2 context packets from v2 documents, tasks, artifacts, diagnostics, and task engine output.
- `packages/web-workspace/src/agent-v2-runtime-core.ts`
  Loads a complete v2 runtime snapshot from `RuntimeStore` v2 methods and persists task transitions with v2 diagnostics.
- `packages/web-workspace/src/index.ts`
  Re-exports the new public v2 runtime APIs.
- `packages/web-workspace/src/*.js` and `packages/web-workspace/src/*.js.map`
  Source-adjacent generated JavaScript files matching the existing package convention.
- `packages/web-workspace/test/agent-v2-task-engine.test.ts`
  Covers task selection, dependency blocking, terminal states, and transition stamping.
- `packages/web-workspace/test/agent-v2-artifact-index.test.ts`
  Covers stable artifact ordering, filtering, latest lookup, and pending validation views.
- `packages/web-workspace/test/agent-v2-context-packet.test.ts`
  Covers context packet construction from v2 documents only, open problem extraction, and deterministic markdown rendering.
- `packages/web-workspace/test/agent-v2-runtime-core.test.ts`
  Covers store-backed snapshot loading and task transition persistence using only v2 store methods.
- `packages/web-workspace/test/agent-v2-import-boundary.test.ts`
  Enforces that new v2 modules do not import forbidden legacy application generation modules.

---

### Task 1: Pure v2 Task Engine

**Files:**
- Create: `packages/web-workspace/src/agent-v2-task-engine.ts`
- Create: `packages/web-workspace/test/agent-v2-task-engine.test.ts`
- Modify: `packages/web-workspace/src/index.ts`

**Interfaces:**
- Consumes: `AgentV2Error`, `AgentV2TaskNode`, and `AgentV2TaskStatus` from `packages/web-workspace/src/agent-v2-types.ts`.
- Produces:
  - `type AgentV2TaskSelectionReason = "running" | "ready" | "complete" | "empty_graph" | "blocked_by_dependencies" | "failed_dependency"`
  - `interface AgentV2TaskSelection { task?: AgentV2TaskNode; reason: AgentV2TaskSelectionReason; blockedTaskIds: string[]; failedDependencyTaskIds: string[] }`
  - `interface AgentV2TaskTransitionInput { task: AgentV2TaskNode; status: AgentV2TaskStatus; now: string; output?: Record<string, unknown>; error?: AgentV2Error }`
  - `function selectNextAgentV2Task(tasks: AgentV2TaskNode[]): AgentV2TaskSelection`
  - `function transitionAgentV2Task(input: AgentV2TaskTransitionInput): AgentV2TaskNode`

- [ ] **Step 1: Write task engine tests**

Create `packages/web-workspace/test/agent-v2-task-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectNextAgentV2Task, transitionAgentV2Task } from "../src/agent-v2-task-engine.js";
import type { AgentV2TaskNode } from "../src/agent-v2-types.js";

const CREATED_AT = "2026-07-08T00:00:00.000Z";
const UPDATED_AT = "2026-07-08T00:00:00.000Z";

describe("agent v2 task engine", () => {
	it("selects an already running task before starting another task", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "running", dependsOn: ["capability"], startedAt: "2026-07-08T00:01:00.000Z" }),
			task({ taskId: "plan", status: "ready", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "running",
			blockedTaskIds: [],
			failedDependencyTaskIds: [],
		});
	});

	it("selects the first pending or ready task whose dependencies succeeded", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "ready", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "ready",
			blockedTaskIds: ["plan"],
			failedDependencyTaskIds: [],
		});
	});

	it("reports dependency blocking without selecting a task", () => {
		const tasks = [
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "blocked_by_dependencies",
			blockedTaskIds: ["spec", "plan"],
			failedDependencyTaskIds: [],
		});
	});

	it("reports failed dependencies before dependency blocking", () => {
		const tasks = [
			task({ taskId: "capability", status: "failed" }),
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: ["plan"],
			failedDependencyTaskIds: ["spec"],
		});
	});

	it("reports complete only when every task succeeded", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "succeeded", dependsOn: ["capability"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "complete",
			blockedTaskIds: [],
			failedDependencyTaskIds: [],
		});
	});

	it("does not treat terminal failures as a complete graph", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({
				taskId: "validate",
				status: "failed",
				dependsOn: ["capability"],
				error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
			}),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: [],
			failedDependencyTaskIds: ["validate"],
		});
	});

	it("stamps running and terminal transitions without mutating the original task", () => {
		const original = task({ taskId: "spec", status: "ready" });

		const running = transitionAgentV2Task({
			task: original,
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});
		const succeeded = transitionAgentV2Task({
			task: running,
			status: "succeeded",
			now: "2026-07-08T00:03:00.000Z",
			output: { filesChanged: ["src/App.tsx"] },
		});

		expect(original.status).toBe("ready");
		expect(running).toMatchObject({
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
			updatedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(succeeded).toMatchObject({
			status: "succeeded",
			output: { filesChanged: ["src/App.tsx"] },
			startedAt: "2026-07-08T00:02:00.000Z",
			endedAt: "2026-07-08T00:03:00.000Z",
			updatedAt: "2026-07-08T00:03:00.000Z",
		});
	});

	it("requires an error for failed transitions", () => {
		expect(() =>
			transitionAgentV2Task({
				task: task({ taskId: "validate", status: "running" }),
				status: "failed",
				now: "2026-07-08T00:04:00.000Z",
			}),
		).toThrow("Agent v2 failed task transitions require an error");
	});
});

function task(input: Partial<AgentV2TaskNode> & { taskId: string }): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		parentTaskId: input.parentTaskId,
		kind: input.kind ?? "implementation",
		title: input.title ?? input.taskId,
		status: input.status ?? "pending",
		dependsOn: input.dependsOn ?? [],
		acceptanceCriteria: input.acceptanceCriteria ?? [],
		input: input.input ?? {},
		output: input.output ?? {},
		createdAt: input.createdAt ?? CREATED_AT,
		updatedAt: input.updatedAt ?? UPDATED_AT,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		error: input.error,
	};
}
```

- [ ] **Step 2: Run tests to verify failure**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts
```

Expected: FAIL because `../src/agent-v2-task-engine.js` does not exist or does not export the requested functions.

- [ ] **Step 3: Implement the task engine**

Create `packages/web-workspace/src/agent-v2-task-engine.ts`:

```ts
import type { AgentV2Error, AgentV2TaskNode, AgentV2TaskStatus } from "./agent-v2-types.js";

export type AgentV2TaskSelectionReason =
	| "running"
	| "ready"
	| "complete"
	| "empty_graph"
	| "blocked_by_dependencies"
	| "failed_dependency";

export interface AgentV2TaskSelection {
	task?: AgentV2TaskNode;
	reason: AgentV2TaskSelectionReason;
	blockedTaskIds: string[];
	failedDependencyTaskIds: string[];
}

export interface AgentV2TaskTransitionInput {
	task: AgentV2TaskNode;
	status: AgentV2TaskStatus;
	now: string;
	output?: Record<string, unknown>;
	error?: AgentV2Error;
}

const TERMINAL_STATUSES = new Set<AgentV2TaskStatus>(["blocked", "succeeded", "failed", "cancelled"]);

export function selectNextAgentV2Task(tasks: AgentV2TaskNode[]): AgentV2TaskSelection {
	if (tasks.length === 0) return selection("empty_graph");

	const running = tasks.find((task) => task.status === "running");
	if (running) return selection("running", running);

	const taskById = new Map(tasks.map((task) => [task.taskId, task]));
	const blockedTaskIds: string[] = [];
	const failedDependencyTaskIds: string[] = [];

	for (const task of tasks) {
		if (!isSelectableTask(task)) continue;

		const dependencyStatuses = task.dependsOn.map((taskId) => taskById.get(taskId)?.status);
		if (dependencyStatuses.some((status) => status === "failed" || status === "cancelled" || status === "blocked")) {
			failedDependencyTaskIds.push(task.taskId);
			continue;
		}
		if (dependencyStatuses.every((status) => status === "succeeded")) {
			return {
				task,
				reason: "ready",
				blockedTaskIds: collectBlockedTaskIds(tasks, taskById, task.taskId),
				failedDependencyTaskIds,
			};
		}
		blockedTaskIds.push(task.taskId);
	}

	if (failedDependencyTaskIds.length > 0) {
		return {
			reason: "failed_dependency",
			blockedTaskIds,
			failedDependencyTaskIds,
		};
	}

	if (tasks.every((task) => task.status === "succeeded")) return selection("complete");

	const terminalFailureTaskIds = tasks
		.filter((task) => task.status !== "succeeded" && TERMINAL_STATUSES.has(task.status))
		.map((task) => task.taskId);
	if (terminalFailureTaskIds.length > 0) {
		return {
			reason: "failed_dependency",
			blockedTaskIds,
			failedDependencyTaskIds: terminalFailureTaskIds,
		};
	}

	if (blockedTaskIds.length > 0) {
		return {
			reason: "blocked_by_dependencies",
			blockedTaskIds,
			failedDependencyTaskIds: [],
		};
	}

	return selection("complete");
}

export function transitionAgentV2Task(input: AgentV2TaskTransitionInput): AgentV2TaskNode {
	if (input.status === "failed" && !input.error) {
		throw new Error("Agent v2 failed task transitions require an error");
	}

	const startedAt = input.status === "running" ? input.task.startedAt ?? input.now : input.task.startedAt;
	const endedAt = TERMINAL_STATUSES.has(input.status) ? input.now : input.task.endedAt;

	return {
		...input.task,
		status: input.status,
		output: input.output ?? input.task.output,
		error: input.error ?? (input.status === "failed" ? input.task.error : undefined),
		startedAt,
		endedAt,
		updatedAt: input.now,
	};
}

function selection(reason: AgentV2TaskSelectionReason, task?: AgentV2TaskNode): AgentV2TaskSelection {
	return {
		task,
		reason,
		blockedTaskIds: [],
		failedDependencyTaskIds: [],
	};
}

function isSelectableTask(task: AgentV2TaskNode): boolean {
	return task.status === "pending" || task.status === "ready";
}

function collectBlockedTaskIds(tasks: AgentV2TaskNode[], taskById: Map<string, AgentV2TaskNode>, selectedTaskId: string): string[] {
	const blockedTaskIds: string[] = [];
	for (const task of tasks) {
		if (!isSelectableTask(task) || task.taskId === selectedTaskId) continue;
		const dependencyStatuses = task.dependsOn.map((taskId) => taskById.get(taskId)?.status);
		if (!dependencyStatuses.every((status) => status === "succeeded")) blockedTaskIds.push(task.taskId);
	}
	return blockedTaskIds;
}
```

Modify `packages/web-workspace/src/index.ts` to export the task engine:

```ts
export {
	type AgentV2TaskSelection,
	type AgentV2TaskSelectionReason,
	type AgentV2TaskTransitionInput,
	selectNextAgentV2Task,
	transitionAgentV2Task,
} from "./agent-v2-task-engine.js";
```

- [ ] **Step 4: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts
npm run check
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 1**

Run from repo root:

```bash
git add packages/web-workspace/src/agent-v2-task-engine.ts packages/web-workspace/test/agent-v2-task-engine.test.ts packages/web-workspace/src/index.ts
git commit -m "feat: add agent v2 task engine"
```

---

### Task 2: v2 Artifact Index

**Files:**
- Create: `packages/web-workspace/src/agent-v2-artifact-index.ts`
- Create: `packages/web-workspace/test/agent-v2-artifact-index.test.ts`
- Modify: `packages/web-workspace/src/index.ts`

**Interfaces:**
- Consumes: `AgentV2ArtifactRecord` from `packages/web-workspace/src/agent-v2-store.ts`.
- Produces:
  - `interface AgentV2ArtifactIndexFilter { kind?: string; sourceTaskId?: string; validationStatus?: string; pathPrefix?: string }`
  - `interface AgentV2ArtifactIndex { artifacts: AgentV2ArtifactRecord[]; latestByPath: Map<string, AgentV2ArtifactRecord>; pendingValidation: AgentV2ArtifactRecord[] }`
  - `function buildAgentV2ArtifactIndex(artifacts: AgentV2ArtifactRecord[]): AgentV2ArtifactIndex`
  - `function filterAgentV2Artifacts(index: AgentV2ArtifactIndex, filter: AgentV2ArtifactIndexFilter): AgentV2ArtifactRecord[]`
  - `function findLatestAgentV2ArtifactByPath(index: AgentV2ArtifactIndex, path: string): AgentV2ArtifactRecord | undefined`

- [ ] **Step 1: Write artifact index tests**

Create `packages/web-workspace/test/agent-v2-artifact-index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	buildAgentV2ArtifactIndex,
	filterAgentV2Artifacts,
	findLatestAgentV2ArtifactByPath,
} from "../src/agent-v2-artifact-index.js";
import type { AgentV2ArtifactRecord } from "../src/agent-v2-store.js";

describe("agent v2 artifact index", () => {
	it("orders artifacts deterministically by updatedAt, path, and artifactId", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "b", path: "agent-v2/spec.md", updatedAt: "2026-07-08T00:03:00.000Z" }),
			artifact({ artifactId: "a", path: "agent-v2/spec.md", updatedAt: "2026-07-08T00:03:00.000Z" }),
			artifact({ artifactId: "c", path: "agent-v2/plan.md", updatedAt: "2026-07-08T00:02:00.000Z" }),
		]);

		expect(index.artifacts.map((item) => item.artifactId)).toEqual(["c", "a", "b"]);
	});

	it("keeps the latest artifact by path", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "spec-v1", path: "agent-v2/spec.md", version: "1", updatedAt: "2026-07-08T00:01:00.000Z" }),
			artifact({ artifactId: "spec-v2", path: "agent-v2/spec.md", version: "2", updatedAt: "2026-07-08T00:05:00.000Z" }),
		]);

		expect(findLatestAgentV2ArtifactByPath(index, "agent-v2/spec.md")).toMatchObject({
			artifactId: "spec-v2",
			version: "2",
		});
	});

	it("filters by kind, source task, validation status, and path prefix", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "spec", kind: "document", path: "agent-v2/spec.md", sourceTaskId: "spec", validationStatus: "accepted" }),
			artifact({ artifactId: "app", kind: "source", path: "src/App.tsx", sourceTaskId: "implement", validationStatus: "pending" }),
			artifact({ artifactId: "test", kind: "source", path: "src/App.test.tsx", sourceTaskId: "validate", validationStatus: "pending" }),
		]);

		expect(
			filterAgentV2Artifacts(index, {
				kind: "source",
				sourceTaskId: "implement",
				validationStatus: "pending",
				pathPrefix: "src/",
			}).map((item) => item.artifactId),
		).toEqual(["app"]);
	});

	it("exposes artifacts pending validation", () => {
		const index = buildAgentV2ArtifactIndex([
			artifact({ artifactId: "accepted", validationStatus: "accepted" }),
			artifact({ artifactId: "passed", validationStatus: "passed" }),
			artifact({ artifactId: "pending", validationStatus: "pending" }),
			artifact({ artifactId: "not-started", validationStatus: "not_started" }),
		]);

		expect(index.pendingValidation.map((item) => item.artifactId)).toEqual(["pending", "not-started"]);
	});
});

function artifact(input: Partial<AgentV2ArtifactRecord> & { artifactId: string }): AgentV2ArtifactRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-a",
		artifactId: input.artifactId,
		kind: input.kind ?? "document",
		path: input.path ?? `agent-v2/${input.artifactId}.md`,
		mediaType: input.mediaType ?? "text/markdown",
		checksum: input.checksum ?? `sha256:${input.artifactId}`,
		version: input.version ?? "1",
		sourceTaskId: input.sourceTaskId,
		validationStatus: input.validationStatus ?? "accepted",
		metadataJson: input.metadataJson ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}
```

- [ ] **Step 2: Run tests to verify failure**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-artifact-index.test.ts
```

Expected: FAIL because `../src/agent-v2-artifact-index.js` does not exist or does not export the requested functions.

- [ ] **Step 3: Implement the artifact index**

Create `packages/web-workspace/src/agent-v2-artifact-index.ts`:

```ts
import type { AgentV2ArtifactRecord } from "./agent-v2-store.js";

export interface AgentV2ArtifactIndexFilter {
	kind?: string;
	sourceTaskId?: string;
	validationStatus?: string;
	pathPrefix?: string;
}

export interface AgentV2ArtifactIndex {
	artifacts: AgentV2ArtifactRecord[];
	latestByPath: Map<string, AgentV2ArtifactRecord>;
	pendingValidation: AgentV2ArtifactRecord[];
}

const PENDING_VALIDATION_STATUSES = new Set(["pending", "not_started"]);

export function buildAgentV2ArtifactIndex(artifacts: AgentV2ArtifactRecord[]): AgentV2ArtifactIndex {
	const ordered = [...artifacts].sort(compareArtifacts);
	const latestByPath = new Map<string, AgentV2ArtifactRecord>();
	for (const artifact of ordered) latestByPath.set(artifact.path, artifact);

	return {
		artifacts: ordered,
		latestByPath,
		pendingValidation: ordered.filter((artifact) => PENDING_VALIDATION_STATUSES.has(artifact.validationStatus)),
	};
}

export function filterAgentV2Artifacts(index: AgentV2ArtifactIndex, filter: AgentV2ArtifactIndexFilter): AgentV2ArtifactRecord[] {
	return index.artifacts.filter((artifact) => {
		if (filter.kind !== undefined && artifact.kind !== filter.kind) return false;
		if (filter.sourceTaskId !== undefined && artifact.sourceTaskId !== filter.sourceTaskId) return false;
		if (filter.validationStatus !== undefined && artifact.validationStatus !== filter.validationStatus) return false;
		if (filter.pathPrefix !== undefined && !artifact.path.startsWith(filter.pathPrefix)) return false;
		return true;
	});
}

export function findLatestAgentV2ArtifactByPath(
	index: AgentV2ArtifactIndex,
	path: string,
): AgentV2ArtifactRecord | undefined {
	return index.latestByPath.get(path);
}

function compareArtifacts(left: AgentV2ArtifactRecord, right: AgentV2ArtifactRecord): number {
	return (
		left.updatedAt.localeCompare(right.updatedAt) ||
		left.path.localeCompare(right.path) ||
		left.artifactId.localeCompare(right.artifactId)
	);
}
```

Modify `packages/web-workspace/src/index.ts` to export the artifact index:

```ts
export {
	type AgentV2ArtifactIndex,
	type AgentV2ArtifactIndexFilter,
	buildAgentV2ArtifactIndex,
	filterAgentV2Artifacts,
	findLatestAgentV2ArtifactByPath,
} from "./agent-v2-artifact-index.js";
```

- [ ] **Step 4: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-artifact-index.test.ts
npm run check
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 2**

Run from repo root:

```bash
git add packages/web-workspace/src/agent-v2-artifact-index.ts packages/web-workspace/test/agent-v2-artifact-index.test.ts packages/web-workspace/src/index.ts
git commit -m "feat: add agent v2 artifact index"
```

---

### Task 3: v2 Context Packet

**Files:**
- Create: `packages/web-workspace/src/agent-v2-context-packet.ts`
- Create: `packages/web-workspace/test/agent-v2-context-packet.test.ts`
- Modify: `packages/web-workspace/src/index.ts`

**Interfaces:**
- Consumes:
  - `AgentV2DiagnosticEvent` from `packages/web-workspace/src/agent-v2-diagnostics.ts`
  - `AgentV2ArtifactRecord`, `AgentV2DocumentRecord` from `packages/web-workspace/src/agent-v2-store.ts`
  - `AgentV2RunSnapshot`, `AgentV2TaskNode` from `packages/web-workspace/src/agent-v2-types.ts`
  - `AgentV2ArtifactIndex`, `buildAgentV2ArtifactIndex`, `filterAgentV2Artifacts` from Task 2
  - `AgentV2TaskSelection`, `selectNextAgentV2Task` from Task 1
- Produces:
  - `interface AgentV2ContextPacketInput { run: AgentV2RunSnapshot; documents: AgentV2DocumentRecord[]; tasks: AgentV2TaskNode[]; artifacts: AgentV2ArtifactRecord[]; diagnostics: AgentV2DiagnosticEvent[] }`
  - `interface AgentV2ContextPacket { run: AgentV2RunSnapshot; taskSelection: AgentV2TaskSelection; activeTask?: AgentV2TaskNode; documents: { capabilityDecision?: AgentV2DocumentRecord; spec?: AgentV2DocumentRecord; plan?: AgentV2DocumentRecord; tasks?: AgentV2DocumentRecord }; artifactIndex: AgentV2ArtifactIndex; activeTaskArtifacts: AgentV2ArtifactRecord[]; openProblems: AgentV2ContextProblem[]; requiredRereads: AgentV2ContextReread[]; markdown: string }`
  - `interface AgentV2ContextProblem { source: "task" | "diagnostic"; severity: "warn" | "error"; code: string; message: string; taskId?: string; artifactId?: string }`
  - `interface AgentV2ContextReread { kind: "document" | "artifact"; id: string; path?: string; reason: string }`
  - `function buildAgentV2ContextPacket(input: AgentV2ContextPacketInput): AgentV2ContextPacket`
  - `function renderAgentV2ContextPacketMarkdown(packet: Omit<AgentV2ContextPacket, "markdown">): string`

- [ ] **Step 1: Write context packet tests**

Create `packages/web-workspace/test/agent-v2-context-packet.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAgentV2ContextPacket } from "../src/agent-v2-context-packet.js";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord } from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "../src/agent-v2-types.js";

describe("agent v2 context packet", () => {
	it("builds deterministic context from v2 records only", () => {
		const run = runSnapshot();
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "running", dependsOn: ["capability"], acceptanceCriteria: ["Spec describes static preview scope."] }),
		];
		const packet = buildAgentV2ContextPacket({
			run,
			tasks,
			documents: [
				document({ documentId: "plan", kind: "plan", contentMarkdown: "# Plan\nBuild static app." }),
				document({ documentId: "spec", kind: "spec", contentMarkdown: "# Spec\nStatic dashboard." }),
				document({ documentId: "capability_decision", kind: "capability_decision", contentMarkdown: "# Capability\nstatic_app" }),
				document({ documentId: "tasks", kind: "tasks", contentMarkdown: "# Tasks\nspec" }),
			],
			artifacts: [
				artifact({ artifactId: "spec-md", sourceTaskId: "spec", path: "agent-v2/spec.md" }),
				artifact({ artifactId: "plan-md", sourceTaskId: "plan", path: "agent-v2/plan.md" }),
			],
			diagnostics: [],
		});

		expect(packet.run.runId).toBe("run-v2");
		expect(packet.taskSelection).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "running",
			blockedTaskIds: [],
			failedDependencyTaskIds: [],
		});
		expect(packet.documents).toEqual({
			capabilityDecision: expect.objectContaining({ documentId: "capability_decision" }),
			spec: expect.objectContaining({ documentId: "spec" }),
			plan: expect.objectContaining({ documentId: "plan" }),
			tasks: expect.objectContaining({ documentId: "tasks" }),
		});
		expect(packet.activeTaskArtifacts.map((item) => item.artifactId)).toEqual(["spec-md"]);
		expect(packet.requiredRereads).toEqual([
			{ kind: "document", id: "spec", reason: "active task context" },
			{ kind: "artifact", id: "spec-md", path: "agent-v2/spec.md", reason: "active task artifact" },
		]);
		expect(packet.markdown).toContain("## Active Task\n- `spec` running");
		expect(packet.markdown).toContain("## Required Rereads\n- document `spec`: active task context");
	});

	it("extracts open problems from failed tasks and warn/error diagnostics", () => {
		const packet = buildAgentV2ContextPacket({
			run: runSnapshot(),
			documents: [],
			artifacts: [],
			tasks: [
				task({
					taskId: "validate",
					status: "failed",
					error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
				}),
			],
			diagnostics: [
				diagnostic({ diagnosticId: "debug", severity: "debug", code: "IGNORED", message: "ignored" }),
				diagnostic({ diagnosticId: "warn", severity: "warn", code: "MISSING_ARTIFACT", message: "Artifact missing", taskId: "validate" }),
				diagnostic({ diagnosticId: "error", severity: "error", code: "BUILD_FAILED", message: "Build failed", taskId: "validate", artifactId: "app" }),
			],
		});

		expect(packet.openProblems).toEqual([
			{
				source: "task",
				severity: "error",
				code: "VALIDATION_FAILED",
				message: "Build failed",
				taskId: "validate",
			},
			{
				source: "diagnostic",
				severity: "warn",
				code: "MISSING_ARTIFACT",
				message: "Artifact missing",
				taskId: "validate",
			},
			{
				source: "diagnostic",
				severity: "error",
				code: "BUILD_FAILED",
				message: "Build failed",
				taskId: "validate",
				artifactId: "app",
			},
		]);
	});
});

function runSnapshot(): AgentV2RunSnapshot {
	return {
		clientId: "client-a",
		runId: "run-v2",
		status: "running",
		phase: "implementation",
		attempt: 1,
		input: { prompt: "Build a static dashboard" },
		model: { provider: "test", model: "local" },
		createdAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:00.000Z",
	};
}

function task(input: Partial<AgentV2TaskNode> & { taskId: string }): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		kind: input.kind ?? "implementation",
		title: input.title ?? input.taskId,
		status: input.status ?? "pending",
		dependsOn: input.dependsOn ?? [],
		acceptanceCriteria: input.acceptanceCriteria ?? [],
		input: input.input ?? {},
		output: input.output ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		error: input.error,
	};
}

function document(input: Partial<AgentV2DocumentRecord> & { documentId: string; kind: AgentV2DocumentRecord["kind"] }): AgentV2DocumentRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		documentId: input.documentId,
		kind: input.kind,
		version: input.version ?? "1",
		contentMarkdown: input.contentMarkdown ?? "",
		contentJson: input.contentJson ?? ({ kind: input.kind } as AgentV2DocumentRecord["contentJson"]),
		sourceTaskId: input.sourceTaskId,
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}

function artifact(input: Partial<AgentV2ArtifactRecord> & { artifactId: string }): AgentV2ArtifactRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		artifactId: input.artifactId,
		kind: input.kind ?? "document",
		path: input.path ?? `agent-v2/${input.artifactId}.md`,
		mediaType: input.mediaType ?? "text/markdown",
		checksum: input.checksum ?? `sha256:${input.artifactId}`,
		version: input.version ?? "1",
		sourceTaskId: input.sourceTaskId,
		validationStatus: input.validationStatus ?? "accepted",
		metadataJson: input.metadataJson ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}

function diagnostic(input: Partial<AgentV2DiagnosticEvent> & { diagnosticId: string; severity: AgentV2DiagnosticEvent["severity"]; code: string; message: string }): AgentV2DiagnosticEvent {
	return {
		diagnosticId: input.diagnosticId,
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		severity: input.severity,
		category: input.category ?? "task_graph",
		code: input.code,
		phase: input.phase,
		taskId: input.taskId,
		artifactId: input.artifactId,
		traceId: input.traceId,
		message: input.message,
		data: input.data ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
	};
}
```

- [ ] **Step 2: Run tests to verify failure**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-context-packet.test.ts
```

Expected: FAIL because `../src/agent-v2-context-packet.js` does not exist or does not export the requested function.

- [ ] **Step 3: Implement the context packet**

Create `packages/web-workspace/src/agent-v2-context-packet.ts`:

```ts
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import {
	type AgentV2ArtifactIndex,
	buildAgentV2ArtifactIndex,
	filterAgentV2Artifacts,
} from "./agent-v2-artifact-index.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord } from "./agent-v2-store.js";
import { type AgentV2TaskSelection, selectNextAgentV2Task } from "./agent-v2-task-engine.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";

export interface AgentV2ContextPacketInput {
	run: AgentV2RunSnapshot;
	documents: AgentV2DocumentRecord[];
	tasks: AgentV2TaskNode[];
	artifacts: AgentV2ArtifactRecord[];
	diagnostics: AgentV2DiagnosticEvent[];
}

export interface AgentV2ContextDocuments {
	capabilityDecision?: AgentV2DocumentRecord;
	spec?: AgentV2DocumentRecord;
	plan?: AgentV2DocumentRecord;
	tasks?: AgentV2DocumentRecord;
}

export interface AgentV2ContextProblem {
	source: "task" | "diagnostic";
	severity: "warn" | "error";
	code: string;
	message: string;
	taskId?: string;
	artifactId?: string;
}

export interface AgentV2ContextReread {
	kind: "document" | "artifact";
	id: string;
	path?: string;
	reason: string;
}

export interface AgentV2ContextPacket {
	run: AgentV2RunSnapshot;
	taskSelection: AgentV2TaskSelection;
	activeTask?: AgentV2TaskNode;
	documents: AgentV2ContextDocuments;
	artifactIndex: AgentV2ArtifactIndex;
	activeTaskArtifacts: AgentV2ArtifactRecord[];
	openProblems: AgentV2ContextProblem[];
	requiredRereads: AgentV2ContextReread[];
	markdown: string;
}

export function buildAgentV2ContextPacket(input: AgentV2ContextPacketInput): AgentV2ContextPacket {
	const taskSelection = selectNextAgentV2Task(input.tasks);
	const activeTask = taskSelection.task;
	const documents = selectContextDocuments(input.documents);
	const artifactIndex = buildAgentV2ArtifactIndex(input.artifacts);
	const activeTaskArtifacts = activeTask
		? filterAgentV2Artifacts(artifactIndex, { sourceTaskId: activeTask.taskId })
		: [];
	const openProblems = collectOpenProblems(input.tasks, input.diagnostics);
	const requiredRereads = collectRequiredRereads(activeTask, documents, activeTaskArtifacts);
	const packetWithoutMarkdown = {
		run: input.run,
		taskSelection,
		activeTask,
		documents,
		artifactIndex,
		activeTaskArtifacts,
		openProblems,
		requiredRereads,
	};

	return {
		...packetWithoutMarkdown,
		markdown: renderAgentV2ContextPacketMarkdown(packetWithoutMarkdown),
	};
}

export function renderAgentV2ContextPacketMarkdown(packet: Omit<AgentV2ContextPacket, "markdown">): string {
	const lines = [
		`# Agent v2 Context Packet`,
		``,
		`## Run`,
		`- \`${packet.run.runId}\` ${packet.run.status} / ${packet.run.phase}`,
		``,
		`## Active Task`,
		packet.activeTask ? `- \`${packet.activeTask.taskId}\` ${packet.activeTask.status}` : `- none (${packet.taskSelection.reason})`,
		``,
		`## Required Rereads`,
		...renderRereads(packet.requiredRereads),
		``,
		`## Open Problems`,
		...renderProblems(packet.openProblems),
	];
	return `${lines.join("\n")}\n`;
}

function selectContextDocuments(documents: AgentV2DocumentRecord[]): AgentV2ContextDocuments {
	const latestByKind = new Map<AgentV2DocumentRecord["kind"], AgentV2DocumentRecord>();
	for (const document of [...documents].sort(compareDocuments)) latestByKind.set(document.kind, document);
	return {
		capabilityDecision: latestByKind.get("capability_decision"),
		spec: latestByKind.get("spec"),
		plan: latestByKind.get("plan"),
		tasks: latestByKind.get("tasks"),
	};
}

function collectOpenProblems(tasks: AgentV2TaskNode[], diagnostics: AgentV2DiagnosticEvent[]): AgentV2ContextProblem[] {
	const taskProblems = tasks
		.filter((task) => task.status === "failed" || task.status === "blocked")
		.map((task): AgentV2ContextProblem => ({
			source: "task",
			severity: "error",
			code: task.error?.code ?? `TASK_${task.status.toUpperCase()}`,
			message: task.error?.message ?? `Task ${task.taskId} is ${task.status}`,
			taskId: task.taskId,
		}));
	const diagnosticProblems = diagnostics
		.filter((diagnostic) => diagnostic.severity === "warn" || diagnostic.severity === "error")
		.map((diagnostic): AgentV2ContextProblem => ({
			source: "diagnostic",
			severity: diagnostic.severity,
			code: diagnostic.code,
			message: diagnostic.message,
			taskId: diagnostic.taskId,
			artifactId: diagnostic.artifactId,
		}));
	return [...taskProblems, ...diagnosticProblems];
}

function collectRequiredRereads(
	activeTask: AgentV2TaskNode | undefined,
	documents: AgentV2ContextDocuments,
	activeTaskArtifacts: AgentV2ArtifactRecord[],
): AgentV2ContextReread[] {
	const rereads: AgentV2ContextReread[] = [];
	const activeDocument = activeTask ? documentForTask(activeTask, documents) : undefined;
	if (activeDocument) rereads.push({ kind: "document", id: activeDocument.documentId, reason: "active task context" });
	for (const artifact of activeTaskArtifacts) {
		rereads.push({ kind: "artifact", id: artifact.artifactId, path: artifact.path, reason: "active task artifact" });
	}
	return rereads;
}

function documentForTask(
	task: AgentV2TaskNode,
	documents: AgentV2ContextDocuments,
): AgentV2DocumentRecord | undefined {
	if (task.taskId === "capability" || task.kind === "capability") return documents.capabilityDecision;
	if (task.taskId === "spec" || task.kind === "spec") return documents.spec;
	if (task.taskId === "plan" || task.kind === "plan") return documents.plan;
	return documents.tasks ?? documents.plan ?? documents.spec;
}

function renderRereads(rereads: AgentV2ContextReread[]): string[] {
	if (rereads.length === 0) return ["- none"];
	return rereads.map((item) => {
		const path = item.path ? ` (${item.path})` : "";
		return `- ${item.kind} \`${item.id}\`${path}: ${item.reason}`;
	});
}

function renderProblems(problems: AgentV2ContextProblem[]): string[] {
	if (problems.length === 0) return ["- none"];
	return problems.map((problem) => `- ${problem.severity} ${problem.source} \`${problem.code}\`: ${problem.message}`);
}

function compareDocuments(left: AgentV2DocumentRecord, right: AgentV2DocumentRecord): number {
	return (
		left.updatedAt.localeCompare(right.updatedAt) ||
		left.kind.localeCompare(right.kind) ||
		left.documentId.localeCompare(right.documentId)
	);
}
```

Modify `packages/web-workspace/src/index.ts` to export the context packet:

```ts
export {
	type AgentV2ContextDocuments,
	type AgentV2ContextPacket,
	type AgentV2ContextPacketInput,
	type AgentV2ContextProblem,
	type AgentV2ContextReread,
	buildAgentV2ContextPacket,
	renderAgentV2ContextPacketMarkdown,
} from "./agent-v2-context-packet.js";
```

- [ ] **Step 4: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts
npm run check
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 3**

Run from repo root:

```bash
git add packages/web-workspace/src/agent-v2-context-packet.ts packages/web-workspace/test/agent-v2-context-packet.test.ts packages/web-workspace/src/index.ts
git commit -m "feat: add agent v2 context packet"
```

---

### Task 4: v2 Runtime Core Facade

**Files:**
- Create: `packages/web-workspace/src/agent-v2-runtime-core.ts`
- Create: `packages/web-workspace/test/agent-v2-runtime-core.test.ts`
- Modify: `packages/web-workspace/src/index.ts`

**Interfaces:**
- Consumes:
  - `createAgentV2DiagnosticEvent` from `packages/web-workspace/src/agent-v2-diagnostics.ts`
  - `AgentV2ArtifactRecord`, `AgentV2DocumentRecord`, `UpsertAgentV2TaskInput` from `packages/web-workspace/src/agent-v2-store.ts`
  - `AgentV2ContextPacket`, `buildAgentV2ContextPacket` from Task 3
  - `AgentV2TaskTransitionInput`, `transitionAgentV2Task` from Task 1
  - `AgentV2RunSnapshot`, `AgentV2TaskNode` from `packages/web-workspace/src/agent-v2-types.ts`
  - `RuntimeStore` from `packages/web-workspace/src/runtime-store.ts`
- Produces:
  - `type AgentV2RuntimeStore = Pick<RuntimeStore, "getAgentV2Run" | "listAgentV2Tasks" | "listAgentV2Artifacts" | "listAgentV2Documents" | "listAgentV2Diagnostics" | "upsertAgentV2Task" | "appendAgentV2Diagnostic">`
  - `interface AgentV2RuntimeSnapshot { run: AgentV2RunSnapshot; tasks: AgentV2TaskNode[]; artifacts: AgentV2ArtifactRecord[]; documents: AgentV2DocumentRecord[]; diagnostics: AgentV2DiagnosticEvent[]; contextPacket: AgentV2ContextPacket }`
  - `interface LoadAgentV2RuntimeSnapshotInput { store: AgentV2RuntimeStore; clientId: string; runId: string }`
  - `interface AdvanceAgentV2TaskInput extends Omit<AgentV2TaskTransitionInput, "task"> { store: AgentV2RuntimeStore; clientId: string; runId: string; taskId: string }`
  - `function loadAgentV2RuntimeSnapshot(input: LoadAgentV2RuntimeSnapshotInput): Promise<AgentV2RuntimeSnapshot>`
  - `function advanceAgentV2Task(input: AdvanceAgentV2TaskInput): Promise<AgentV2TaskNode>`

Missing runs must throw directly without persisting a run-scoped diagnostic. That is a v2 schema correctness constraint, not a compatibility gap: `agent_v2_diagnostics` references `agent_v2_runs`, so fabricating a diagnostic for an absent run would fail the real schema. `advanceAgentV2Task` must check `getAgentV2Run` first and only emit `task_not_found` when the run exists but the task does not. Task transition diagnostics are best-effort only; if the diagnostic write fails after a successful task upsert, the task state remains the source of truth and the API should still resolve with the persisted task.

- [ ] **Step 1: Write runtime core tests**

Create `packages/web-workspace/test/agent-v2-runtime-core.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot } from "../src/agent-v2-runtime-core.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeStore } from "../src/runtime-store.js";

describe("agent v2 runtime core", () => {
	const cleanupRoots: string[] = [];
	const cleanupStores: RuntimeDbStore[] = [];

	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("loads a runtime snapshot from v2 records and context only", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-runtime",
			input: { prompt: "Build a static planning board" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		await persistAgentV2PlanningBootstrap(
			store,
			buildAgentV2PlanningBootstrap({
				run,
				now: () => "2026-07-08T00:01:00.000Z",
			}),
		);

		const snapshot = await loadAgentV2RuntimeSnapshot({
			store: forbidLegacyRuntimeReads(store),
			clientId: "client-a",
			runId: "run-v2-runtime",
		});

		expect(snapshot.run.runId).toBe("run-v2-runtime");
		expect(snapshot.tasks.map((task) => task.taskId)).toEqual(["capability", "spec", "plan", "implement", "validate", "deliver"]);
		expect(snapshot.documents.map((document) => document.documentId)).toEqual(["capability_decision", "spec", "plan", "tasks"]);
		expect(snapshot.artifacts.map((artifact) => artifact.artifactId)).toEqual(["capability_decision", "spec", "plan", "tasks"]);
		expect(snapshot.contextPacket.taskSelection.reason).toBe("ready");
		expect(snapshot.contextPacket.markdown).toContain("# Agent v2 Context Packet");
	});

	it("persists task transitions through v2 task storage and appends a v2 diagnostic", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-transition",
			input: { prompt: "Build a static app" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-v2-transition",
			taskId: "implement",
			kind: "implementation",
			title: "Implement app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const updated = await advanceAgentV2Task({
			store: forbidLegacyRuntimeReads(store),
			clientId: "client-a",
			runId: "run-v2-transition",
			taskId: "implement",
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(updated).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Tasks("client-a", "run-v2-transition")[0]).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-transition")).toEqual([
			expect.objectContaining({
				category: "task_graph",
				code: "agent_v2.task_transitioned",
				taskId: "implement",
				severity: "info",
			}),
		]);
	});

	it("keeps the task mutation when diagnostic append fails", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			input: { prompt: "Build a static app" },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			taskId: "implement",
			kind: "implementation",
			title: "Implement app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const updated = await advanceAgentV2Task({
			store: forbidLegacyRuntimeReads(store, { failAgentV2DiagnosticWrites: true }),
			clientId: "client-a",
			runId: "run-v2-diagnostic-failure",
			taskId: "implement",
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(updated).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Tasks("client-a", "run-v2-diagnostic-failure")[0]).toMatchObject({
			taskId: "implement",
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-diagnostic-failure")).toEqual([]);
	});

	it("throws a clear missing-run error without persisting a diagnostic", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);

		await expect(
			loadAgentV2RuntimeSnapshot({
				store: forbidLegacyRuntimeReads(store),
				clientId: "client-a",
				runId: "missing-run",
			}),
		).rejects.toThrow("Agent v2 run not found: client-a/missing-run");
		expect(store.listAgentV2Diagnostics("client-a", "missing-run")).toEqual([]);
	});
});

function createTempRuntimeDbStoreWithV2Schema(cleanupRoots: string[], cleanupStores: RuntimeDbStore[]): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-runtime-core-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}

function forbidLegacyRuntimeReads(store: RuntimeDbStore): RuntimeStore {
	return new Proxy(store, {
		get(target, property, receiver) {
			if (
				property === "getRun" ||
				property === "getRunById" ||
				property === "listRuns" ||
				property === "listRunsForSession" ||
				property === "listMessages" ||
				property === "iterateMessages" ||
				property === "getAppPreviewGoal" ||
				property === "listAppPreviewGoalEvents"
			) {
				return () => {
					throw new Error(`legacy runtime read is forbidden in agent v2 runtime core: ${String(property)}`);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeStore;
}
```

- [ ] **Step 2: Run tests to verify failure**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-runtime-core.test.ts
```

Expected: FAIL because `../src/agent-v2-runtime-core.js` does not exist or does not export the requested functions.

- [ ] **Step 3: Implement the runtime core**

Create `packages/web-workspace/src/agent-v2-runtime-core.ts`:

```ts
import type { AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { createAgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord, UpsertAgentV2TaskInput } from "./agent-v2-store.js";
import { type AgentV2ContextPacket, buildAgentV2ContextPacket } from "./agent-v2-context-packet.js";
import { type AgentV2TaskTransitionInput, transitionAgentV2Task } from "./agent-v2-task-engine.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "./agent-v2-types.js";
import type { RuntimeStore } from "./runtime-store.js";

export type AgentV2RuntimeStore = Pick<
	RuntimeStore,
	| "getAgentV2Run"
	| "listAgentV2Tasks"
	| "listAgentV2Artifacts"
	| "listAgentV2Documents"
	| "listAgentV2Diagnostics"
	| "upsertAgentV2Task"
	| "appendAgentV2Diagnostic"
>;

export interface AgentV2RuntimeSnapshot {
	run: AgentV2RunSnapshot;
	tasks: AgentV2TaskNode[];
	artifacts: AgentV2ArtifactRecord[];
	documents: AgentV2DocumentRecord[];
	diagnostics: AgentV2DiagnosticEvent[];
	contextPacket: AgentV2ContextPacket;
}

export interface LoadAgentV2RuntimeSnapshotInput {
	store: AgentV2RuntimeStore;
	clientId: string;
	runId: string;
}

export interface AdvanceAgentV2TaskInput extends Omit<AgentV2TaskTransitionInput, "task"> {
	store: AgentV2RuntimeStore;
	clientId: string;
	runId: string;
	taskId: string;
}

export async function loadAgentV2RuntimeSnapshot(
	input: LoadAgentV2RuntimeSnapshotInput,
): Promise<AgentV2RuntimeSnapshot> {
	const run = await input.store.getAgentV2Run(input.clientId, input.runId);
	if (!run) {
		await appendRuntimeDiagnostic(input.store, input.clientId, input.runId, {
			code: "agent_v2.run_not_found",
			severity: "error",
			message: `Agent v2 run not found: ${input.clientId}/${input.runId}`,
			createdAt: new Date().toISOString(),
		});
		throw new Error(`Agent v2 run not found: ${input.clientId}/${input.runId}`);
	}

	const [tasks, artifacts, documents, diagnostics] = await Promise.all([
		input.store.listAgentV2Tasks(input.clientId, input.runId),
		input.store.listAgentV2Artifacts(input.clientId, input.runId),
		input.store.listAgentV2Documents(input.clientId, input.runId),
		input.store.listAgentV2Diagnostics(input.clientId, input.runId),
	]);
	const contextPacket = buildAgentV2ContextPacket({ run, tasks, artifacts, documents, diagnostics });
	return { run, tasks, artifacts, documents, diagnostics, contextPacket };
}

export async function advanceAgentV2Task(input: AdvanceAgentV2TaskInput): Promise<AgentV2TaskNode> {
	const tasks = await input.store.listAgentV2Tasks(input.clientId, input.runId);
	const task = tasks.find((candidate) => candidate.taskId === input.taskId);
	if (!task) {
		await appendRuntimeDiagnostic(input.store, input.clientId, input.runId, {
			code: "agent_v2.task_not_found",
			severity: "error",
			message: `Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`,
			taskId: input.taskId,
			createdAt: input.now,
		});
		throw new Error(`Agent v2 task not found: ${input.clientId}/${input.runId}/${input.taskId}`);
	}

	const transitioned = transitionAgentV2Task({
		task,
		status: input.status,
		now: input.now,
		output: input.output,
		error: input.error,
	});
	const persisted = await input.store.upsertAgentV2Task(toUpsertTaskInput(input.clientId, input.runId, transitioned));
	await appendRuntimeDiagnostic(input.store, input.clientId, input.runId, {
		code: "agent_v2.task_transitioned",
		severity: "info",
		message: `Agent v2 task ${input.taskId} transitioned to ${input.status}`,
		taskId: input.taskId,
		createdAt: input.now,
	});
	return persisted;
}

function toUpsertTaskInput(clientId: string, runId: string, task: AgentV2TaskNode): UpsertAgentV2TaskInput {
	return {
		clientId,
		runId,
		taskId: task.taskId,
		parentTaskId: task.parentTaskId,
		kind: task.kind,
		title: task.title,
		status: task.status,
		dependsOn: task.dependsOn,
		acceptanceCriteria: task.acceptanceCriteria,
		input: task.input,
		output: task.output,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		startedAt: task.startedAt,
		endedAt: task.endedAt,
		error: task.error,
	};
}

async function appendRuntimeDiagnostic(
	store: AgentV2RuntimeStore,
	clientId: string,
	runId: string,
	input: {
		code: string;
		severity: "info" | "error";
		message: string;
		taskId?: string;
		createdAt: string;
	},
): Promise<void> {
	await store.appendAgentV2Diagnostic(
		createAgentV2DiagnosticEvent({
			diagnosticId: `${input.code}:${input.taskId ?? "run"}:${input.createdAt}`,
			clientId,
			runId,
			severity: input.severity,
			category: "task_graph",
			code: input.code,
			taskId: input.taskId,
			message: input.message,
			data: {},
			createdAt: input.createdAt,
		}),
	);
}
```

Modify `packages/web-workspace/src/index.ts` to export the runtime core:

```ts
export {
	type AdvanceAgentV2TaskInput,
	type AgentV2RuntimeSnapshot,
	type AgentV2RuntimeStore,
	type LoadAgentV2RuntimeSnapshotInput,
	advanceAgentV2Task,
	loadAgentV2RuntimeSnapshot,
} from "./agent-v2-runtime-core.js";
```

- [ ] **Step 4: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts test/agent-v2-runtime-core.test.ts
npm run check
```

Expected: both commands PASS.

- [ ] **Step 5: Commit Task 4**

Run from repo root:

```bash
git add packages/web-workspace/src/agent-v2-runtime-core.ts packages/web-workspace/test/agent-v2-runtime-core.test.ts packages/web-workspace/src/index.ts
git commit -m "feat: add agent v2 runtime core"
```

---

### Task 5: v2 Import Boundary Tests

**Files:**
- Create: `packages/web-workspace/test/agent-v2-import-boundary.test.ts`

**Interfaces:**
- Consumes: source files created in Tasks 1-4.
- Produces: a test that fails if new v2 runtime modules import forbidden legacy application generation modules.

- [ ] **Step 1: Write import boundary test**

Create `packages/web-workspace/test/agent-v2-import-boundary.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

const V2_RUNTIME_FILES = [
	"agent-v2-task-engine.ts",
	"agent-v2-artifact-index.ts",
	"agent-v2-context-packet.ts",
	"agent-v2-runtime-core.ts",
];

const FORBIDDEN_IMPORT_FRAGMENTS = [
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"app-preview-goal",
	"createRunAgent",
	"selectApplicationGenerationRuntime",
];

describe("agent v2 runtime import boundary", () => {
	it("does not import legacy application generation internals", () => {
		for (const fileName of V2_RUNTIME_FILES) {
			const source = readFileSync(join(SRC_ROOT, fileName), "utf8");
			for (const forbidden of FORBIDDEN_IMPORT_FRAGMENTS) {
				expect(source, `${fileName} must not reference ${forbidden}`).not.toContain(forbidden);
			}
		}
	});
});
```

- [ ] **Step 2: Run import boundary test**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-import-boundary.test.ts
```

Expected: PASS after Tasks 1-4. If it fails, remove the forbidden dependency instead of adding an allowlist.

- [ ] **Step 3: Run all Phase 3 focused tests and typecheck**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts test/agent-v2-runtime-core.test.ts test/agent-v2-import-boundary.test.ts
npm run check
```

Expected: both commands PASS.

- [ ] **Step 4: Commit Task 5**

Run from repo root:

```bash
git add packages/web-workspace/test/agent-v2-import-boundary.test.ts
git commit -m "test: enforce agent v2 runtime boundaries"
```

---

### Task 6: Source-Adjacent JavaScript and Final Verification

**Files:**
- Create: `packages/web-workspace/src/agent-v2-task-engine.js`
- Create: `packages/web-workspace/src/agent-v2-task-engine.js.map`
- Create: `packages/web-workspace/src/agent-v2-artifact-index.js`
- Create: `packages/web-workspace/src/agent-v2-artifact-index.js.map`
- Create: `packages/web-workspace/src/agent-v2-context-packet.js`
- Create: `packages/web-workspace/src/agent-v2-context-packet.js.map`
- Create: `packages/web-workspace/src/agent-v2-runtime-core.js`
- Create: `packages/web-workspace/src/agent-v2-runtime-core.js.map`
- Modify: `packages/web-workspace/src/index.js`
- Modify: `packages/web-workspace/src/index.js.map`

**Interfaces:**
- Consumes: TypeScript modules from Tasks 1-4.
- Produces: generated source-adjacent JavaScript files and maps matching the existing package convention.

- [ ] **Step 1: Generate source-adjacent JavaScript files**

Run from `packages/web-workspace`:

```bash
npx tsc --module Node16 --moduleResolution Node16 --target ES2022 --rootDir src --outDir src --sourceMap true --declaration false --emitDeclarationOnly false --skipLibCheck true src/agent-v2-task-engine.ts src/agent-v2-artifact-index.ts src/agent-v2-context-packet.ts src/agent-v2-runtime-core.ts src/index.ts
```

Expected: command exits 0 and creates or updates the `.js` and `.js.map` files listed above.

- [ ] **Step 2: Confirm generated files are present**

Run from repo root:

```bash
git status --short packages/web-workspace/src/agent-v2-task-engine.js packages/web-workspace/src/agent-v2-task-engine.js.map packages/web-workspace/src/agent-v2-artifact-index.js packages/web-workspace/src/agent-v2-artifact-index.js.map packages/web-workspace/src/agent-v2-context-packet.js packages/web-workspace/src/agent-v2-context-packet.js.map packages/web-workspace/src/agent-v2-runtime-core.js packages/web-workspace/src/agent-v2-runtime-core.js.map packages/web-workspace/src/index.js packages/web-workspace/src/index.js.map
```

Expected: new `.js/.js.map` files and modified `index.js/.js.map` appear in git status.

- [ ] **Step 3: Run full Phase 3 focused tests**

Run from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts test/agent-v2-runtime-core.test.ts test/agent-v2-import-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run package check and build**

Run from `packages/web-workspace`:

```bash
npm run check
npm run build
```

Expected: both commands PASS.

- [ ] **Step 5: Run root check**

Run from repo root:

```bash
npm run check
```

Expected: PASS. Do not run root `npm run build`, root `npm run test`, or root `npm run dev`.

- [ ] **Step 6: Commit Task 6**

Run from repo root:

```bash
git add packages/web-workspace/src/agent-v2-task-engine.js packages/web-workspace/src/agent-v2-task-engine.js.map packages/web-workspace/src/agent-v2-artifact-index.js packages/web-workspace/src/agent-v2-artifact-index.js.map packages/web-workspace/src/agent-v2-context-packet.js packages/web-workspace/src/agent-v2-context-packet.js.map packages/web-workspace/src/agent-v2-runtime-core.js packages/web-workspace/src/agent-v2-runtime-core.js.map packages/web-workspace/src/index.js packages/web-workspace/src/index.js.map
git commit -m "chore: generate agent v2 runtime source files"
```

---

## Final Review and Completion

- [ ] Run a final import-boundary grep from repo root:

```bash
rg "capability-planner|spec-artifact|context-orchestrator|preview-goal|app-preview-goal|createRunAgent|selectApplicationGenerationRuntime" packages/web-workspace/src/agent-v2-task-engine.ts packages/web-workspace/src/agent-v2-artifact-index.ts packages/web-workspace/src/agent-v2-context-packet.ts packages/web-workspace/src/agent-v2-runtime-core.ts packages/web-workspace/test/agent-v2-import-boundary.test.ts
```

Expected: only `packages/web-workspace/test/agent-v2-import-boundary.test.ts` contains the forbidden strings as boundary test data.

- [ ] Run final verification from `packages/web-workspace`:

```bash
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts test/agent-v2-runtime-core.test.ts test/agent-v2-import-boundary.test.ts
npm run check
npm run build
```

Expected: PASS.

- [ ] Run final root verification from repo root:

```bash
npm run check
```

Expected: PASS.

- [ ] Request final code review using `superpowers:requesting-code-review` with the branch diff from merge base to `HEAD`.

- [ ] Fix Critical and Important final-review findings, then rerun affected tests and the final verification commands.

---

## Self-Review

**Spec coverage:** This plan covers the strengthened Phase 3 option by adding standalone v2 task selection/transitions, v2 artifact indexing, v2-only context packets, a v2 store-backed runtime facade, import-boundary enforcement, and generated source-adjacent files. It does not integrate with the old worker path and intentionally does not read legacy run/session/message/preview-goal state.

**Placeholder scan:** The plan contains no `TBD`, `TODO`, `implement later`, `fill in details`, or open-ended "write tests for the above" steps. Each implementation task includes concrete test code, production code, commands, and expected results.

**Type consistency:** Later tasks use the exact public interfaces introduced by earlier tasks: `selectNextAgentV2Task`, `transitionAgentV2Task`, `buildAgentV2ArtifactIndex`, `filterAgentV2Artifacts`, `buildAgentV2ContextPacket`, `loadAgentV2RuntimeSnapshot`, and `advanceAgentV2Task`.
