# Application Generation Agent v2 Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v2-native tool governance, validation gate, repair action model, and task execution facade for Application Generation Agent v2 without depending on legacy application-generation internals.

**Architecture:** Phase 4 adds focused `agent-v2-*` modules under `packages/web-workspace/src`. Legacy infrastructure modules may only be reused behind reviewed v2 adapters; old planning, prompt, context, spec artifact, and preview-goal repair modules are forbidden dependencies. The execution facade operates on Phase 3 v2 runtime state and writes task/artifact/validation/diagnostic state back to v2 store APIs.

**Tech Stack:** TypeScript ESM (`moduleResolution: Node16`), `@mariozechner/pi-web-workspace`, RuntimeStore v2 tables, Vitest via `tsx`, source-adjacent generated `.js/.js.map` files.

## Global Constraints

- All implementation happens in `C:\VibeCoding\pm-coding-agent-v2-phase4\pi-mono-0.73.0` on branch `codex/app-agent-v2-phase4`.
- Use codegraph before code exploration or code changes; repair or initialize codegraph before falling back to shell reads.
- v2 correctness, diagnosability, task state machine quality, and validation/repair loop quality take priority over compatibility with old generation behavior.
- Do not import or call legacy application-generation internals from new Phase 4 modules:
  - `apps/pi-coding-web/src/runtime/capability-planner.ts`
  - `apps/pi-coding-web/src/runtime/spec-artifact.ts`
  - `apps/pi-coding-web/src/runtime/context-orchestrator.ts`
  - old preview-goal continuation repair logic
  - `apps/pi-coding-web/src/worker/main.ts:createRunAgent`
- Do not read legacy `sessions`, `messages`, `runs`, `run_events`, `app_preview_goals`, or app preview goal events as v2 state.
- Reuse old modules only after adapter review. If the old module carries old agent semantics or weak contracts, refactor or add a v2 adapter instead of reusing it directly.
- Do not run root `npm run dev`, root `npm run build`, or root `npm run test`. Root `npm run check` is allowed as final verification. Package-level `npm run check`, `npm run build`, and focused Vitest commands are allowed.
- Use TDD for each implementation task: write failing tests first, implement production code, run focused tests, commit.
- Use `apply_patch` for manual code edits. Generated `.js/.js.map` files may be produced by the TypeScript compiler.

---

## File Structure

- `packages/web-workspace/src/agent-v2-store.ts`
  Add validation record types, validation columns, builder, and row conversion.
- `packages/web-workspace/src/runtime-store.ts`
  Add validation persistence methods to `RuntimeStore`.
- `packages/web-workspace/src/runtime-db.ts`
  Implement SQLite validation upsert/list methods.
- `packages/web-workspace/src/postgres-runtime-store.ts`
  Implement PostgreSQL validation upsert/list methods.
- `packages/web-workspace/src/agent-v2-tool-governance.ts`
  Define v2 tool registry, phase allowlist, contracts, and structured tool failure helpers.
- `packages/web-workspace/src/agent-v2-file-adapter.ts`
  Wrap `WorkspaceFileService` as a v2 file IO adapter and emit artifact candidates.
- `packages/web-workspace/src/agent-v2-validation-gate.ts`
  Wrap static validation/build/preview primitives and produce structured validation results.
- `packages/web-workspace/src/agent-v2-repair-engine.ts`
  Convert validation failures into bounded repair actions.
- `packages/web-workspace/src/agent-v2-execution-core.ts`
  Execute the next v2 task through v2 adapters and persist state transitions.
- `packages/web-workspace/src/index.ts`
  Re-export public Phase 4 APIs.
- `packages/web-workspace/test/agent-v2-validation-store.test.ts`
  Store contract tests for validation rows.
- `packages/web-workspace/test/agent-v2-tool-governance.test.ts`
  Tool registry and phase allowlist tests.
- `packages/web-workspace/test/agent-v2-file-adapter.test.ts`
  File adapter behavior and artifact candidate tests.
- `packages/web-workspace/test/agent-v2-validation-gate.test.ts`
  Static validation mapping and failure taxonomy tests.
- `packages/web-workspace/test/agent-v2-repair-engine.test.ts`
  Repair action and max-attempt tests.
- `packages/web-workspace/test/agent-v2-execution-core.test.ts`
  v2 task execution facade integration tests.
- `packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts`
  Import-boundary test for Phase 4 modules.
- `packages/web-workspace/src/*.js` and `packages/web-workspace/src/*.js.map`
  Generated source-adjacent JavaScript and maps.

---

### Task 1: v2 Validation Store Surface

**Files:**
- Modify: `packages/web-workspace/src/agent-v2-store.ts`
- Modify: `packages/web-workspace/src/runtime-store.ts`
- Modify: `packages/web-workspace/src/runtime-db.ts`
- Modify: `packages/web-workspace/src/postgres-runtime-store.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-validation-store.test.ts`

**Interfaces:**
- Consumes: existing `agent_v2_validations` schema in SQLite/PostgreSQL.
- Produces:
  - `type AgentV2ValidationStatus = "passed" | "failed" | "blocked" | "warning"`
  - `interface AgentV2ValidationRecord`
  - `interface UpsertAgentV2ValidationInput`
  - `function buildAgentV2Validation(input: UpsertAgentV2ValidationInput): AgentV2ValidationRecord`
  - `function toAgentV2ValidationRecord(row: AgentV2ValidationRow): AgentV2ValidationRecord`
  - `RuntimeStore.upsertAgentV2Validation(input)`
  - `RuntimeStore.listAgentV2Validations(clientId, runId)`

- [ ] **Step 1: Write failing validation store tests**

Create `packages/web-workspace/test/agent-v2-validation-store.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RuntimeDbStore } from "../src/runtime-db.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("agent v2 validation store", () => {
	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("upserts and lists validation records in deterministic order", () => {
		const store = createStore();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});

		store.upsertAgentV2Validation({
			clientId: "client-a",
			runId: "run-a",
			validationId: "validate-static",
			taskId: "validate",
			artifactId: "index-html",
			status: "failed",
			summary: "Static quality gate failed",
			details: { failures: [{ code: "static.loading_visible", path: "index.html" }] },
			createdAt: "2026-07-08T00:01:00.000Z",
			updatedAt: "2026-07-08T00:01:00.000Z",
		});
		store.upsertAgentV2Validation({
			clientId: "client-a",
			runId: "run-a",
			validationId: "validate-smoke",
			status: "passed",
			summary: "Smoke gate passed",
			details: { checkedFiles: ["index.html"] },
			createdAt: "2026-07-08T00:02:00.000Z",
			updatedAt: "2026-07-08T00:02:00.000Z",
		});

		expect(store.listAgentV2Validations("client-a", "run-a")).toEqual([
			expect.objectContaining({
				validationId: "validate-static",
				taskId: "validate",
				artifactId: "index-html",
				status: "failed",
				details: { failures: [{ code: "static.loading_visible", path: "index.html" }] },
			}),
			expect.objectContaining({
				validationId: "validate-smoke",
				status: "passed",
				details: { checkedFiles: ["index.html"] },
			}),
		]);
	});
});

function createStore(): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-validation-store-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-store.test.ts
```

Expected: FAIL because `upsertAgentV2Validation` and `listAgentV2Validations` do not exist.

- [ ] **Step 3: Implement validation types in `agent-v2-store.ts`**

Add the validation interfaces and builders near existing artifact/document/diagnostic types:

```ts
export type AgentV2ValidationStatus = "passed" | "failed" | "blocked" | "warning";

export interface AgentV2ValidationRecord extends JsonObject {
	clientId: string;
	runId: string;
	validationId: string;
	taskId?: string;
	artifactId?: string;
	status: AgentV2ValidationStatus;
	summary: string;
	details: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export interface UpsertAgentV2ValidationInput extends JsonObject {
	clientId: string;
	runId: string;
	validationId: string;
	taskId?: string;
	artifactId?: string;
	status: AgentV2ValidationStatus;
	summary: string;
	details: Record<string, unknown>;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentV2ValidationRow {
	client_id: string;
	run_id: string;
	validation_id: string;
	task_id: string | null;
	artifact_id: string | null;
	status: AgentV2ValidationStatus;
	summary: string;
	details_json: unknown;
	created_at: TimestampValue;
	updated_at: TimestampValue;
}

export const AGENT_V2_VALIDATION_COLUMNS =
	"client_id, run_id, validation_id, task_id, artifact_id, status, summary, details_json, created_at, updated_at";

export function buildAgentV2Validation(input: UpsertAgentV2ValidationInput): AgentV2ValidationRecord {
	const createdAt = input.createdAt ?? new Date().toISOString();
	const updatedAt = input.updatedAt ?? createdAt;
	return {
		clientId: input.clientId,
		runId: input.runId,
		validationId: input.validationId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.artifactId ? { artifactId: input.artifactId } : {}),
		status: input.status,
		summary: input.summary,
		details: input.details ?? {},
		createdAt,
		updatedAt,
	};
}

export function toAgentV2ValidationRecord(row: AgentV2ValidationRow): AgentV2ValidationRecord {
	return {
		clientId: row.client_id,
		runId: row.run_id,
		validationId: row.validation_id,
		...(row.task_id ? { taskId: row.task_id } : {}),
		...(row.artifact_id ? { artifactId: row.artifact_id } : {}),
		status: row.status,
		summary: row.summary,
		details: parseJsonObject(row.details_json),
		createdAt: toTimestamp(row.created_at),
		updatedAt: toTimestamp(row.updated_at),
	};
}
```

- [ ] **Step 4: Add RuntimeStore validation methods**

Modify `packages/web-workspace/src/runtime-store.ts`:

```ts
upsertAgentV2Validation(input: UpsertAgentV2ValidationInputFromStore): MaybePromise<AgentV2ValidationRecord>;
listAgentV2Validations(clientId: string, runId: string): MaybePromise<AgentV2ValidationRecord[]>;
```

Import the new store types alongside existing v2 store imports.

- [ ] **Step 5: Implement SQLite and PostgreSQL methods**

In both stores, add methods matching the existing artifact/document style:

```ts
upsertAgentV2Validation(input: UpsertAgentV2ValidationInput): AgentV2ValidationRecord {
	const validation = buildAgentV2Validation(input);
	this.open()
		.prepare(
			`INSERT INTO agent_v2_validations (
				client_id, run_id, validation_id, task_id, artifact_id, status, summary, details_json, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(client_id, run_id, validation_id) DO UPDATE SET
				task_id = excluded.task_id,
				artifact_id = excluded.artifact_id,
				status = excluded.status,
				summary = excluded.summary,
				details_json = excluded.details_json,
				updated_at = excluded.updated_at`,
		)
		.run(
			validation.clientId,
			validation.runId,
			validation.validationId,
			validation.taskId ?? null,
			validation.artifactId ?? null,
			validation.status,
			validation.summary,
			stringifyAgentV2Json(validation.details),
			validation.createdAt,
			validation.updatedAt,
		);
	return requiredRecord(
		this.listAgentV2Validations(validation.clientId, validation.runId).find(
			(record) => record.validationId === validation.validationId,
		),
		"agent v2 validation",
	);
}
```

Use `$1`-style placeholders and `RETURNING ${AGENT_V2_VALIDATION_COLUMNS}` in PostgreSQL, matching existing `upsertAgentV2Task` style.

- [ ] **Step 6: Re-export validation types**

Modify `packages/web-workspace/src/index.ts` to export the new validation types and helpers.

- [ ] **Step 7: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-store.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

Run from repo root:

```powershell
git add packages/web-workspace/src/agent-v2-store.ts packages/web-workspace/src/runtime-store.ts packages/web-workspace/src/runtime-db.ts packages/web-workspace/src/postgres-runtime-store.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-validation-store.test.ts
git commit -m "feat: add agent v2 validation store"
```

---

### Task 2: v2 Tool Governance

**Files:**
- Create: `packages/web-workspace/src/agent-v2-tool-governance.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-tool-governance.test.ts`

**Interfaces:**
- Consumes: `AgentV2Phase` from `agent-v2-types.ts`.
- Produces:
  - `AgentV2ToolName`
  - `AgentV2ToolContract`
  - `AgentV2ToolFailure`
  - `AgentV2ToolRegistry`
  - `createAgentV2ToolRegistry`
  - `assertAgentV2ToolAllowed`
  - `createAgentV2ToolFailure`

- [ ] **Step 1: Write failing tool governance tests**

Create `packages/web-workspace/test/agent-v2-tool-governance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
	assertAgentV2ToolAllowed,
	createAgentV2ToolFailure,
	createAgentV2ToolRegistry,
} from "../src/agent-v2-tool-governance.js";

describe("agent v2 tool governance", () => {
	it("resolves registered tools and enforces phase allowlists", () => {
		const registry = createAgentV2ToolRegistry();

		expect(registry.get("file.write")).toMatchObject({
			name: "file.write",
			sideEffects: "workspace_files",
		});
		expect(() => assertAgentV2ToolAllowed(registry, "file.write", "implementation")).not.toThrow();
		expect(() => assertAgentV2ToolAllowed(registry, "file.write", "validation")).toThrow(
			"Agent v2 tool file.write is not allowed during phase validation",
		);
	});

	it("fails closed for unknown tools", () => {
		const registry = createAgentV2ToolRegistry();
		expect(() => assertAgentV2ToolAllowed(registry, "legacy.project_task" as never, "implementation")).toThrow(
			"Agent v2 tool is not registered: legacy.project_task",
		);
	});

	it("creates stable structured tool failures", () => {
		expect(
			createAgentV2ToolFailure({
				code: "tool.not_allowed_in_phase",
				message: "Tool not allowed",
				retryable: false,
				taskId: "validate",
				path: "index.html",
				data: { tool: "file.write" },
			}),
		).toEqual({
			code: "tool.not_allowed_in_phase",
			message: "Tool not allowed",
			retryable: false,
			taskId: "validate",
			path: "index.html",
			data: { tool: "file.write" },
		});
	});
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-tool-governance.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement `agent-v2-tool-governance.ts`**

Create the module:

```ts
import type { AgentV2Phase } from "./agent-v2-types.js";

export type AgentV2ToolName =
	| "file.list"
	| "file.read"
	| "file.write"
	| "file.patch"
	| "validation.static_build"
	| "validation.static_quality"
	| "validation.static_smoke"
	| "preview.publish";

export type AgentV2ToolSideEffect =
	| "none"
	| "workspace_files"
	| "validation_records"
	| "preview_metadata";

export interface AgentV2ToolContract {
	name: AgentV2ToolName;
	allowedPhases: AgentV2Phase[];
	inputSchemaId: string;
	outputSchemaId: string;
	sideEffects: AgentV2ToolSideEffect;
}

export interface AgentV2ToolFailure {
	code: string;
	message: string;
	retryable: boolean;
	phase?: AgentV2Phase;
	taskId?: string;
	artifactId?: string;
	path?: string;
	data: Record<string, unknown>;
}

export type AgentV2ToolRegistry = ReadonlyMap<AgentV2ToolName, AgentV2ToolContract>;

const DEFAULT_CONTRACTS: AgentV2ToolContract[] = [
	{
		name: "file.list",
		allowedPhases: ["implementation", "repair", "validation", "delivery"],
		inputSchemaId: "agent-v2.file.list.input.v1",
		outputSchemaId: "agent-v2.file.list.output.v1",
		sideEffects: "none",
	},
	{
		name: "file.read",
		allowedPhases: ["implementation", "repair", "validation", "delivery"],
		inputSchemaId: "agent-v2.file.read.input.v1",
		outputSchemaId: "agent-v2.file.read.output.v1",
		sideEffects: "none",
	},
	{
		name: "file.write",
		allowedPhases: ["implementation", "repair"],
		inputSchemaId: "agent-v2.file.write.input.v1",
		outputSchemaId: "agent-v2.file.write.output.v1",
		sideEffects: "workspace_files",
	},
	{
		name: "file.patch",
		allowedPhases: ["implementation", "repair"],
		inputSchemaId: "agent-v2.file.patch.input.v1",
		outputSchemaId: "agent-v2.file.patch.output.v1",
		sideEffects: "workspace_files",
	},
	{
		name: "validation.static_build",
		allowedPhases: ["validation", "repair"],
		inputSchemaId: "agent-v2.validation.static_build.input.v1",
		outputSchemaId: "agent-v2.validation.result.output.v1",
		sideEffects: "validation_records",
	},
	{
		name: "validation.static_quality",
		allowedPhases: ["validation", "repair"],
		inputSchemaId: "agent-v2.validation.static_quality.input.v1",
		outputSchemaId: "agent-v2.validation.result.output.v1",
		sideEffects: "validation_records",
	},
	{
		name: "validation.static_smoke",
		allowedPhases: ["validation", "repair"],
		inputSchemaId: "agent-v2.validation.static_smoke.input.v1",
		outputSchemaId: "agent-v2.validation.result.output.v1",
		sideEffects: "validation_records",
	},
	{
		name: "preview.publish",
		allowedPhases: ["preview", "delivery"],
		inputSchemaId: "agent-v2.preview.publish.input.v1",
		outputSchemaId: "agent-v2.preview.publish.output.v1",
		sideEffects: "preview_metadata",
	},
];

export function createAgentV2ToolRegistry(
	contracts: readonly AgentV2ToolContract[] = DEFAULT_CONTRACTS,
): AgentV2ToolRegistry {
	return new Map(contracts.map((contract) => [contract.name, { ...contract, allowedPhases: [...contract.allowedPhases] }]));
}

export function assertAgentV2ToolAllowed(
	registry: AgentV2ToolRegistry,
	toolName: AgentV2ToolName,
	phase: AgentV2Phase,
): AgentV2ToolContract {
	const contract = registry.get(toolName);
	if (!contract) throw new Error(`Agent v2 tool is not registered: ${toolName}`);
	if (!contract.allowedPhases.includes(phase)) {
		throw new Error(`Agent v2 tool ${toolName} is not allowed during phase ${phase}`);
	}
	return contract;
}

export function createAgentV2ToolFailure(input: AgentV2ToolFailure): AgentV2ToolFailure {
	return {
		code: input.code,
		message: input.message,
		retryable: input.retryable,
		...(input.phase ? { phase: input.phase } : {}),
		...(input.taskId ? { taskId: input.taskId } : {}),
		...(input.artifactId ? { artifactId: input.artifactId } : {}),
		...(input.path ? { path: input.path } : {}),
		data: input.data ?? {},
	};
}
```

- [ ] **Step 4: Re-export APIs**

Modify `packages/web-workspace/src/index.ts` to export the new types/functions.

- [ ] **Step 5: Run focused tests and typecheck**

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-tool-governance.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add packages/web-workspace/src/agent-v2-tool-governance.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-tool-governance.test.ts
git commit -m "feat: add agent v2 tool governance"
```

---

### Task 3: v2 File Adapter

**Files:**
- Create: `packages/web-workspace/src/agent-v2-file-adapter.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-file-adapter.test.ts`

**Interfaces:**
- Consumes: `WorkspaceFileService`, `StorageConfig`, `AgentV2ToolFailure`.
- Produces:
  - `AgentV2FileAdapter`
  - `createAgentV2FileAdapter`
  - `AgentV2FileArtifactCandidate`
  - `AgentV2FileWriteResult`

- [ ] **Step 1: Write failing file adapter tests**

Create `packages/web-workspace/test/agent-v2-file-adapter.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import type { StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];

describe("agent v2 file adapter", () => {
	afterEach(() => {
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("writes files through a v2 contract and returns artifact candidates", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});

		const result = adapter.writeFile({
			path: "index.html",
			content: "<!doctype html><main>Ready</main>",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		expect(result.artifact).toMatchObject({
			artifactId: "file:index.html",
			path: "index.html",
			mediaType: "text/html",
			sourceTaskId: "implement",
			validationStatus: "not_started",
		});
		expect(result.action).toBe("created");
		expect(adapter.listFiles().files).toEqual(["index.html"]);
	});

	it("maps path escape failures to structured tool failures", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});

		expect(() =>
			adapter.writeFile({
				path: "../outside.txt",
				content: "bad",
				mode: "create",
				taskId: "implement",
				now: "2026-07-08T00:01:00.000Z",
			}),
		).toThrow("file.path_invalid");
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-file-adapter-"));
	cleanupRoots.push(root);
	return root;
}

function testConfig(root: string): StorageConfig {
	return {
		storageDir: root,
		projectsDir: join(root, "projects"),
		skillsDir: join(root, "skills"),
		workspaceEnvPath: "",
		previewBaseUrl: "http://localhost:4173",
		previewBasePath: "/preview",
		diagnosticLogDir: join(root, "logs"),
		diagnosticLoggingEnabled: false,
		diagnosticLogMaxEvents: 100,
		diagnosticLogRetentionMs: 60_000,
		diagnosticLogMaxDataChars: 2000,
		langfuseEnabled: false,
		langfuseBaseUrl: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseFlushAt: 1,
		langfuseFlushIntervalMs: 1000,
		otelEnabled: false,
		otelEndpoint: "",
		otelHeaders: {},
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 0,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 0,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 0,
		contextProviderPayloadBudgetChars: 0,
		modelStreamIdleTimeoutMs: 0,
		modelMaxOutputTokens: 0,
	};
}
```

- [ ] **Step 2: Run focused test and verify failure**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-file-adapter.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement file adapter**

Create `packages/web-workspace/src/agent-v2-file-adapter.ts`:

```ts
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { createAgentV2ToolFailure } from "./agent-v2-tool-governance.js";
import type { AgentV2ArtifactRecord } from "./agent-v2-store.js";
import type { StorageConfig } from "./types.js";
import { WorkspaceFileService } from "./workspace-file-service.js";

export interface AgentV2FileAdapterContext {
	clientId: string;
	sessionId: string;
	title: string;
}

export interface CreateAgentV2FileAdapterInput {
	config: StorageConfig;
	context: AgentV2FileAdapterContext;
	files?: WorkspaceFileService;
}

export type AgentV2FileWriteMode = "create" | "rewrite";

export interface AgentV2FileArtifactCandidate
	extends Omit<AgentV2ArtifactRecord, "clientId" | "runId" | "createdAt" | "updatedAt"> {}

export interface AgentV2FileWriteResult {
	path: string;
	action: "created" | "updated";
	artifact: AgentV2FileArtifactCandidate;
}

export interface AgentV2FileAdapter {
	listFiles(): { files: string[] };
	readFile(path: string): { path: string; content: string; truncated: boolean };
	writeFile(input: {
		path: string;
		content: string;
		mode: AgentV2FileWriteMode;
		taskId: string;
		now: string;
	}): AgentV2FileWriteResult;
	patchFile(input: {
		path: string;
		oldText: string;
		newText: string;
		taskId: string;
		now: string;
	}): AgentV2FileWriteResult;
}

export function createAgentV2FileAdapter(input: CreateAgentV2FileAdapterInput): AgentV2FileAdapter {
	const files = input.files ?? new WorkspaceFileService(input.config);
	const base = {
		clientId: input.context.clientId,
		sessionId: input.context.sessionId,
		title: input.context.title,
	};

	const artifactFor = (path: string, content: string, taskId: string): AgentV2FileArtifactCandidate => ({
		artifactId: `file:${path}`,
		kind: "source",
		path,
		mediaType: mediaTypeForPath(path),
		checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		version: "v2",
		sourceTaskId: taskId,
		validationStatus: "not_started",
		metadataJson: {},
	});

	const mapError = (error: unknown, path?: string): never => {
		const message = error instanceof Error ? error.message : String(error);
		if (/Project path component|outside|path/i.test(message)) {
			throw new Error(
				JSON.stringify(
					createAgentV2ToolFailure({
						code: "file.path_invalid",
						message,
						retryable: false,
						path,
						data: {},
					}),
				),
			);
		}
		throw error;
	};

	return {
		listFiles() {
			const result = files.handle({ ...base, command: "list" });
			return { files: "files" in result && Array.isArray(result.files) ? result.files : [] };
		},
		readFile(path) {
			try {
				const result = files.handle({ ...base, command: "get", filename: path });
				return {
					path: String(result.filename ?? path),
					content: typeof result.content === "string" ? result.content : "",
					truncated: Boolean(result.truncated),
				};
			} catch (error) {
				return mapError(error, path);
			}
		},
		writeFile(write) {
			try {
				const result = files.handle({
					...base,
					command: write.mode,
					filename: write.path,
					content: write.content,
				});
				return {
					path: String(result.filename ?? write.path),
					action: result.action === "created" ? "created" : "updated",
					artifact: artifactFor(String(result.filename ?? write.path), write.content, write.taskId),
				};
			} catch (error) {
				return mapError(error, write.path);
			}
		},
		patchFile(patch) {
			try {
				const before = this.readFile(patch.path);
				const result = files.handle({
					...base,
					command: "update",
					filename: patch.path,
					old_str: patch.oldText,
					new_str: patch.newText,
				});
				const content = before.content.replace(patch.oldText, patch.newText);
				return {
					path: String(result.filename ?? patch.path),
					action: "updated",
					artifact: artifactFor(String(result.filename ?? patch.path), content, patch.taskId),
				};
			} catch (error) {
				return mapError(error, patch.path);
			}
		},
	};
}

function mediaTypeForPath(path: string): string {
	const ext = extname(path).toLowerCase();
	if (ext === ".html") return "text/html";
	if (ext === ".css") return "text/css";
	if (ext === ".js" || ext === ".mjs") return "text/javascript";
	if (ext === ".json") return "application/json";
	if (ext === ".md") return "text/markdown";
	return "text/plain";
}
```

- [ ] **Step 4: Re-export APIs**

Modify `packages/web-workspace/src/index.ts`.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-file-adapter.test.ts
npm run check
```

Expected: PASS. If `StorageConfig` in tests requires additional fields, add only the missing config fields and keep the adapter API unchanged.

- [ ] **Step 6: Commit Task 3**

```powershell
git add packages/web-workspace/src/agent-v2-file-adapter.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-file-adapter.test.ts
git commit -m "feat: add agent v2 file adapter"
```

---

### Task 4: v2 Validation Gate

**Files:**
- Create: `packages/web-workspace/src/agent-v2-validation-gate.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-validation-gate.test.ts`

**Interfaces:**
- Consumes: `WorkspaceTaskService`, `UpsertAgentV2ValidationInput`, `AgentV2ToolFailure`.
- Produces:
  - `AgentV2ValidationFailure`
  - `AgentV2ValidationGateResult`
  - `runAgentV2StaticValidationGate`

- [ ] **Step 1: Write failing validation gate tests**

Create `packages/web-workspace/test/agent-v2-validation-gate.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import { runAgentV2StaticValidationGate } from "../src/agent-v2-validation-gate.js";
import type { StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];

describe("agent v2 validation gate", () => {
	afterEach(() => {
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("maps visible loading placeholders to structured validation failures", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: `<!doctype html><div id="load" class="loading">Loading...</div>`,
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("failed");
		expect(result.failures).toEqual([
			expect.objectContaining({ code: "static.loading_visible", retryable: true, path: "index.html" }),
		]);
		expect(result.validation).toMatchObject({
			validationId: "static:validate",
			status: "failed",
			taskId: "validate",
			summary: "Static validation failed",
		});
	});

	it("passes a basic static app", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const context = { clientId: "client-a", sessionId: "session-a", title: "Demo" };
		const files = createAgentV2FileAdapter({ config, context });
		files.writeFile({
			path: "index.html",
			content: "<!doctype html><main><h1>Ready</h1></main>",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		const result = await runAgentV2StaticValidationGate({
			config,
			context,
			runId: "run-a",
			taskId: "validate",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("passed");
		expect(result.failures).toEqual([]);
		expect(result.validation).toMatchObject({ status: "passed", summary: "Static validation passed" });
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-validation-gate-"));
	cleanupRoots.push(root);
	return root;
}

function testConfig(root: string): StorageConfig {
	return {
		storageDir: root,
		projectsDir: join(root, "projects"),
		skillsDir: join(root, "skills"),
		workspaceEnvPath: "",
		previewBaseUrl: "http://localhost:4173",
		previewBasePath: "/preview",
		diagnosticLogDir: join(root, "logs"),
		diagnosticLoggingEnabled: false,
		diagnosticLogMaxEvents: 100,
		diagnosticLogRetentionMs: 60_000,
		diagnosticLogMaxDataChars: 2000,
		langfuseEnabled: false,
		langfuseBaseUrl: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseFlushAt: 1,
		langfuseFlushIntervalMs: 1000,
		otelEnabled: false,
		otelEndpoint: "",
		otelHeaders: {},
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 0,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 0,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 0,
		contextProviderPayloadBudgetChars: 0,
		modelStreamIdleTimeoutMs: 0,
		modelMaxOutputTokens: 0,
	};
}
```

- [ ] **Step 2: Run focused test and verify failure**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-gate.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement validation gate**

Create `packages/web-workspace/src/agent-v2-validation-gate.ts`:

```ts
import type { UpsertAgentV2ValidationInput } from "./agent-v2-store.js";
import { createAgentV2ToolFailure, type AgentV2ToolFailure } from "./agent-v2-tool-governance.js";
import type { ProjectTaskResult, StorageConfig } from "./types.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

export interface AgentV2ValidationGateContext {
	clientId: string;
	sessionId: string;
	title: string;
}

export interface RunAgentV2StaticValidationGateInput {
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	taskId: string;
	now: string;
	tasks?: WorkspaceTaskService;
}

export type AgentV2ValidationFailure = AgentV2ToolFailure & {
	source: "static_validate" | "static_quality" | "static_smoke" | "preview";
};

export interface AgentV2ValidationGateResult {
	status: "passed" | "failed";
	failures: AgentV2ValidationFailure[];
	validation: UpsertAgentV2ValidationInput;
	rawResult: ProjectTaskResult;
}

export async function runAgentV2StaticValidationGate(
	input: RunAgentV2StaticValidationGateInput,
): Promise<AgentV2ValidationGateResult> {
	const tasks = input.tasks ?? new WorkspaceTaskService(input.config);
	const rawResult = await tasks.run({
		clientId: input.context.clientId,
		sessionId: input.context.sessionId,
		title: input.context.title,
		task: "validate",
	});
	const rawErrors = Array.isArray(rawResult.errors) ? rawResult.errors.map(String) : [];
	const failures = rawErrors.map((message) => classifyStaticValidationFailure(message, input.taskId));
	const status = failures.length === 0 ? "passed" : "failed";
	return {
		status,
		failures,
		validation: {
			clientId: input.context.clientId,
			runId: input.runId,
			validationId: `static:${input.taskId}`,
			taskId: input.taskId,
			status,
			summary: status === "passed" ? "Static validation passed" : "Static validation failed",
			details: {
				failures,
				rawStatus: rawResult.status,
				projectRoot: rawResult.projectRoot,
				serveRoot: rawResult.serveRoot,
				fileCount: rawResult.fileCount,
			},
			createdAt: input.now,
			updatedAt: input.now,
		},
		rawResult,
	};
}

function classifyStaticValidationFailure(message: string, taskId: string): AgentV2ValidationFailure {
	const code = codeForStaticValidationMessage(message);
	return {
		...createAgentV2ToolFailure({
			code,
			message,
			retryable: code !== "static.preview_missing_entry",
			taskId,
			path: pathForStaticValidationMessage(message),
			data: { sourceMessage: message },
		}),
		source: code.includes("smoke") || code.includes("script") ? "static_smoke" : "static_quality",
	};
}

function codeForStaticValidationMessage(message: string): string {
	if (/loading/i.test(message)) return "static.loading_visible";
	if (/--|placeholder/i.test(message)) return "static.metric_placeholder";
	if (/script|evaluation|failed during/i.test(message)) return "static.script_error";
	if (/index\.html|entry file|requires an index/i.test(message)) return "static.preview_missing_entry";
	return "static.validation_failed";
}

function pathForStaticValidationMessage(message: string): string | undefined {
	const indexMatch = message.match(/index\.html/i);
	return indexMatch ? "index.html" : undefined;
}
```

- [ ] **Step 4: Re-export APIs**

Modify `packages/web-workspace/src/index.ts`.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-gate.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```powershell
git add packages/web-workspace/src/agent-v2-validation-gate.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-validation-gate.test.ts
git commit -m "feat: add agent v2 validation gate"
```

---

### Task 5: v2 Repair Engine

**Files:**
- Create: `packages/web-workspace/src/agent-v2-repair-engine.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-repair-engine.test.ts`

**Interfaces:**
- Consumes: `AgentV2ValidationFailure`.
- Produces:
  - `AgentV2RepairAction`
  - `planAgentV2RepairActions`

- [ ] **Step 1: Write failing repair engine tests**

Create `packages/web-workspace/test/agent-v2-repair-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { planAgentV2RepairActions } from "../src/agent-v2-repair-engine.js";
import type { AgentV2ValidationFailure } from "../src/agent-v2-validation-gate.js";

describe("agent v2 repair engine", () => {
	it("plans task-scoped repair actions for repairable static failures", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "index.html" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.loading_visible:index.html",
				taskId: "validate",
				type: "file_patch",
				retryable: true,
				reason: "Visible loading state must be hidden or resolved before delivery.",
				targetPath: "index.html",
				validationCode: "static.loading_visible",
			},
		]);
	});

	it("blocks when max repair attempts are exhausted", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error" })],
			attempt: 3,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			expect.objectContaining({
				type: "block_task",
				retryable: false,
				validationCode: "repair.max_attempts_exceeded",
			}),
		]);
	});
});

function failure(input: Partial<AgentV2ValidationFailure> & { code: string }): AgentV2ValidationFailure {
	return {
		code: input.code,
		message: input.message ?? input.code,
		retryable: input.retryable ?? true,
		taskId: input.taskId ?? "validate",
		path: input.path,
		data: input.data ?? {},
		source: input.source ?? "static_quality",
	};
}
```

- [ ] **Step 2: Run focused test and verify failure**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-repair-engine.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement repair engine**

Create `packages/web-workspace/src/agent-v2-repair-engine.ts`:

```ts
import type { AgentV2ValidationFailure } from "./agent-v2-validation-gate.js";

export type AgentV2RepairActionType = "file_patch" | "rerun_validation" | "block_task";

export interface AgentV2RepairAction {
	actionId: string;
	taskId: string;
	type: AgentV2RepairActionType;
	retryable: boolean;
	reason: string;
	targetPath?: string;
	validationCode: string;
}

export interface PlanAgentV2RepairActionsInput {
	taskId: string;
	failures: AgentV2ValidationFailure[];
	attempt: number;
	maxAttempts: number;
}

export function planAgentV2RepairActions(input: PlanAgentV2RepairActionsInput): AgentV2RepairAction[] {
	if (input.attempt >= input.maxAttempts) {
		return [
			{
				actionId: `repair:${input.taskId}:max_attempts`,
				taskId: input.taskId,
				type: "block_task",
				retryable: false,
				reason: `Repair attempts exhausted (${input.attempt}/${input.maxAttempts}).`,
				validationCode: "repair.max_attempts_exceeded",
			},
		];
	}
	return input.failures.map((failure) => repairActionForFailure(input.taskId, failure));
}

function repairActionForFailure(taskId: string, failure: AgentV2ValidationFailure): AgentV2RepairAction {
	if (!failure.retryable) {
		return {
			actionId: `repair:${taskId}:${failure.code}:block`,
			taskId,
			type: "block_task",
			retryable: false,
			reason: failure.message,
			targetPath: failure.path,
			validationCode: failure.code,
		};
	}
	return {
		actionId: `repair:${taskId}:${failure.code}:${failure.path ?? "run"}`,
		taskId,
		type: failure.path ? "file_patch" : "rerun_validation",
		retryable: true,
		reason: reasonForFailure(failure),
		targetPath: failure.path,
		validationCode: failure.code,
	};
}

function reasonForFailure(failure: AgentV2ValidationFailure): string {
	if (failure.code === "static.loading_visible") {
		return "Visible loading state must be hidden or resolved before delivery.";
	}
	if (failure.code === "static.metric_placeholder") {
		return "Metric placeholders must be replaced with rendered values or an explicit empty state.";
	}
	if (failure.code === "static.script_error") {
		return "Client script errors must be fixed before delivery.";
	}
	return failure.message;
}
```

- [ ] **Step 4: Re-export APIs**

Modify `packages/web-workspace/src/index.ts`.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-repair-engine.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```powershell
git add packages/web-workspace/src/agent-v2-repair-engine.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-repair-engine.test.ts
git commit -m "feat: add agent v2 repair engine"
```

---

### Task 6: v2 Execution Core Facade

**Files:**
- Create: `packages/web-workspace/src/agent-v2-execution-core.ts`
- Modify: `packages/web-workspace/src/index.ts`
- Create: `packages/web-workspace/test/agent-v2-execution-core.test.ts`

**Interfaces:**
- Consumes:
  - `loadAgentV2RuntimeSnapshot`
  - `advanceAgentV2Task`
  - `selectNextAgentV2Task`
  - `runAgentV2StaticValidationGate`
  - `planAgentV2RepairActions`
  - validation store methods
- Produces:
  - `executeAgentV2NextTask(input): Promise<AgentV2ExecutionStepResult>`

- [ ] **Step 1: Write failing execution core tests**

Create `packages/web-workspace/test/agent-v2-execution-core.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
import { executeAgentV2NextTask } from "../src/agent-v2-execution-core.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeStore } from "../src/runtime-store.js";
import type { StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

describe("agent v2 execution core", () => {
	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("advances planning tasks without reading legacy runtime state", async () => {
		const root = tempRoot();
		const store = createStore(root);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "Build a static board" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		await persistAgentV2PlanningBootstrap(store, buildAgentV2PlanningBootstrap({ run }));

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-a",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("task_succeeded");
		expect(result.taskId).toBe("capability");
		expect(store.listAgentV2Tasks("client-a", "run-a")[0]).toMatchObject({
			taskId: "capability",
			status: "succeeded",
		});
	});

	it("records failed validation and repair actions without entering delivery", async () => {
		const root = tempRoot();
		const store = createStore(root);
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-validation",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});
		store.upsertAgentV2Task({
			clientId: "client-a",
			runId: "run-validation",
			taskId: "validate",
			kind: "validation",
			title: "Validate static app",
			status: "ready",
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		});

		const result = await executeAgentV2NextTask({
			store: forbidLegacyRuntimeReads(store),
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
			runId: "run-validation",
			now: () => "2026-07-08T00:02:00.000Z",
		});

		expect(result.status).toBe("task_failed");
		expect(store.listAgentV2Validations("client-a", "run-validation")).toEqual([
			expect.objectContaining({ validationId: "static:validate", status: "failed" }),
		]);
		expect(store.listAgentV2Tasks("client-a", "run-validation")[0]).toMatchObject({
			taskId: "validate",
			status: "failed",
			error: expect.objectContaining({ code: "agent_v2.validation_failed" }),
		});
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-execution-core-"));
	cleanupRoots.push(root);
	return root;
}

function createStore(root: string): RuntimeDbStore {
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupStores.push(store);
	return store;
}

function forbidLegacyRuntimeReads(store: RuntimeDbStore): RuntimeStore {
	return new Proxy(store, {
		get(target, property, receiver) {
			if (
				property === "getRun" ||
				property === "listRuns" ||
				property === "listRunsForSession" ||
				property === "listMessages" ||
				property === "iterateMessages" ||
				property === "getAppPreviewGoal" ||
				property === "listAppPreviewGoalEvents"
			) {
				return () => {
					throw new Error(`legacy runtime read is forbidden in phase 4 execution core: ${String(property)}`);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	}) as RuntimeStore;
}

function testConfig(root: string): StorageConfig {
	return {
		storageDir: root,
		projectsDir: join(root, "projects"),
		skillsDir: join(root, "skills"),
		workspaceEnvPath: "",
		previewBaseUrl: "http://localhost:4173",
		previewBasePath: "/preview",
		diagnosticLogDir: join(root, "logs"),
		diagnosticLoggingEnabled: false,
		diagnosticLogMaxEvents: 100,
		diagnosticLogRetentionMs: 60_000,
		diagnosticLogMaxDataChars: 2000,
		langfuseEnabled: false,
		langfuseBaseUrl: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseFlushAt: 1,
		langfuseFlushIntervalMs: 1000,
		otelEnabled: false,
		otelEndpoint: "",
		otelHeaders: {},
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 0,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 0,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 0,
		contextProviderPayloadBudgetChars: 0,
		modelStreamIdleTimeoutMs: 0,
		modelMaxOutputTokens: 0,
	};
}
```

- [ ] **Step 2: Run focused test and verify failure**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-execution-core.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement execution core**

Create `packages/web-workspace/src/agent-v2-execution-core.ts`:

```ts
import { randomUUID } from "node:crypto";
import { advanceAgentV2Task, loadAgentV2RuntimeSnapshot, type AgentV2RuntimeStore } from "./agent-v2-runtime-core.js";
import { planAgentV2RepairActions } from "./agent-v2-repair-engine.js";
import { runAgentV2StaticValidationGate, type AgentV2ValidationGateContext } from "./agent-v2-validation-gate.js";
import type { RuntimeStore } from "./runtime-store.js";
import type { StorageConfig } from "./types.js";

export type AgentV2ExecutionStepStatus =
	| "task_succeeded"
	| "task_failed"
	| "task_blocked"
	| "complete"
	| "no_task";

export interface AgentV2ExecutionStepResult {
	status: AgentV2ExecutionStepStatus;
	taskId?: string;
	diagnosticIds: string[];
}

export interface ExecuteAgentV2NextTaskInput {
	store: AgentV2RuntimeStore &
		Pick<RuntimeStore, "upsertAgentV2Validation" | "appendAgentV2Diagnostic" | "upsertAgentV2Task">;
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	now?: () => string;
	maxRepairAttempts?: number;
}

export async function executeAgentV2NextTask(input: ExecuteAgentV2NextTaskInput): Promise<AgentV2ExecutionStepResult> {
	const now = input.now?.() ?? new Date().toISOString();
	const snapshot = await loadAgentV2RuntimeSnapshot({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
	});
	const selection = snapshot.contextPacket.taskSelection;
	if (!selection.task) {
		return { status: selection.reason === "complete" ? "complete" : "no_task", diagnosticIds: [] };
	}
	const task = selection.task;

	if (task.kind === "validation") {
		return await executeValidationTask(input, task.taskId, now);
	}

	const updated = await advanceAgentV2Task({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
		taskId: task.taskId,
		status: "succeeded",
		now,
		output: { phase4: { deterministic: true, completedBy: "agent-v2-execution-core" } },
	});
	return { status: updated.status === "succeeded" ? "task_succeeded" : "task_failed", taskId: task.taskId, diagnosticIds: [] };
}

async function executeValidationTask(
	input: ExecuteAgentV2NextTaskInput,
	taskId: string,
	now: string,
): Promise<AgentV2ExecutionStepResult> {
	const result = await runAgentV2StaticValidationGate({
		config: input.config,
		context: input.context,
		runId: input.runId,
		taskId,
		now,
	});
	await Promise.resolve(input.store.upsertAgentV2Validation(result.validation));
	if (result.status === "passed") {
		await advanceAgentV2Task({
			store: input.store,
			clientId: input.context.clientId,
			runId: input.runId,
			taskId,
			status: "succeeded",
			now,
			output: { validationId: result.validation.validationId },
		});
		return { status: "task_succeeded", taskId, diagnosticIds: [] };
	}

	const repairActions = planAgentV2RepairActions({
		taskId,
		failures: result.failures,
		attempt: 1,
		maxAttempts: input.maxRepairAttempts ?? 3,
	});
	const diagnosticId = `agent_v2.validation_failed:${taskId}:${randomUUID()}`;
	await Promise.resolve(
		input.store.appendAgentV2Diagnostic({
			diagnosticId,
			clientId: input.context.clientId,
			runId: input.runId,
			severity: "error",
			category: "validation",
			code: "agent_v2.validation_failed",
			phase: "validation",
			taskId,
			message: result.validation.summary,
			data: { failures: result.failures, repairActions },
			createdAt: now,
		}),
	);
	await advanceAgentV2Task({
		store: input.store,
		clientId: input.context.clientId,
		runId: input.runId,
		taskId,
		status: "failed",
		now,
		output: { validationId: result.validation.validationId, repairActions },
		error: {
			code: "agent_v2.validation_failed",
			message: result.validation.summary,
			retryable: repairActions.some((action) => action.retryable),
			data: { validationId: result.validation.validationId },
		},
	});
	return { status: "task_failed", taskId, diagnosticIds: [diagnosticId] };
}
```

- [ ] **Step 4: Re-export APIs**

Modify `packages/web-workspace/src/index.ts`.

- [ ] **Step 5: Run focused tests and typecheck**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-execution-core.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```powershell
git add packages/web-workspace/src/agent-v2-execution-core.ts packages/web-workspace/src/index.ts packages/web-workspace/test/agent-v2-execution-core.test.ts
git commit -m "feat: add agent v2 execution core"
```

---

### Task 7: Phase 4 Import Boundary

**Files:**
- Create: `packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts`

**Interfaces:**
- Consumes: Phase 4 source files.
- Produces: a test that fails if Phase 4 modules import legacy application-generation internals.

- [ ] **Step 1: Write boundary test**

Create `packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

const PHASE4_FILES = [
	"agent-v2-tool-governance.ts",
	"agent-v2-file-adapter.ts",
	"agent-v2-validation-gate.ts",
	"agent-v2-repair-engine.ts",
	"agent-v2-execution-core.ts",
];

const FORBIDDEN = [
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"app-preview-goal",
	"createRunAgent",
	"selectApplicationGenerationRuntime",
	"project_task",
	"project_file",
];

describe("agent v2 phase 4 import boundary", () => {
	it("does not reference legacy application generation internals or old tool contracts", () => {
		for (const file of PHASE4_FILES) {
			const source = readFileSync(join(SRC_ROOT, file), "utf8");
			for (const forbidden of FORBIDDEN) {
				expect(source, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
			}
		}
	});
});
```

- [ ] **Step 2: Run boundary test**

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-phase4-import-boundary.test.ts
```

Expected: PASS. If it fails because a Phase 4 module mentions `project_task` or `project_file`, rename comments/strings and keep old tool contracts out of the v2 surface.

- [ ] **Step 3: Commit Task 7**

```powershell
git add packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts
git commit -m "test: enforce agent v2 phase 4 boundaries"
```

---

### Task 8: Generate Source-Adjacent JavaScript and Final Verification

**Files:**
- Create/modify generated `.js` and `.js.map` files for all Phase 4 `.ts` modules.
- Modify generated store/index `.js` and `.js.map` files as needed.

**Interfaces:**
- Consumes: all TypeScript changes from Tasks 1-7.
- Produces: generated source-adjacent JavaScript files matching package convention.

- [ ] **Step 1: Generate JavaScript files**

Run from `packages/web-workspace`:

```powershell
npx tsc --module Node16 --moduleResolution Node16 --target ES2022 --rootDir src --outDir src --sourceMap true --declaration false --emitDeclarationOnly false --skipLibCheck true src/agent-v2-store.ts src/runtime-store.ts src/runtime-db.ts src/postgres-runtime-store.ts src/agent-v2-tool-governance.ts src/agent-v2-file-adapter.ts src/agent-v2-validation-gate.ts src/agent-v2-repair-engine.ts src/agent-v2-execution-core.ts src/index.ts
```

Expected: command exits 0 and creates/updates source-adjacent `.js/.js.map` files.

- [ ] **Step 2: Run all Phase 4 focused tests**

Run from `packages/web-workspace`:

```powershell
npx tsx ../../node_modules/vitest/dist/cli.js --run test/agent-v2-validation-store.test.ts test/agent-v2-tool-governance.test.ts test/agent-v2-file-adapter.test.ts test/agent-v2-validation-gate.test.ts test/agent-v2-repair-engine.test.ts test/agent-v2-execution-core.test.ts test/agent-v2-phase4-import-boundary.test.ts test/agent-v2-task-engine.test.ts test/agent-v2-artifact-index.test.ts test/agent-v2-context-packet.test.ts test/agent-v2-runtime-core.test.ts test/agent-v2-import-boundary.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run package check and build**

Run from `packages/web-workspace`:

```powershell
npm run check
npm run build
```

Expected: PASS.

- [ ] **Step 4: Run root check**

Run from repo root:

```powershell
npm run check
```

Expected: PASS. Do not run root `npm run build`, root `npm run test`, or root `npm run dev`.

- [ ] **Step 5: Run final import-boundary grep**

Run from repo root:

```powershell
rg "capability-planner|spec-artifact|context-orchestrator|preview-goal|app-preview-goal|createRunAgent|selectApplicationGenerationRuntime|project_task|project_file" packages/web-workspace/src/agent-v2-tool-governance.ts packages/web-workspace/src/agent-v2-file-adapter.ts packages/web-workspace/src/agent-v2-validation-gate.ts packages/web-workspace/src/agent-v2-repair-engine.ts packages/web-workspace/src/agent-v2-execution-core.ts packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts
```

Expected: only `packages/web-workspace/test/agent-v2-phase4-import-boundary.test.ts` contains the forbidden strings as test data.

- [ ] **Step 6: Commit generated files**

Run from repo root:

```powershell
git add packages/web-workspace/src packages/web-workspace/test
git commit -m "chore: generate agent v2 phase 4 source files"
```

---

## Final Review

- [ ] Request code review with `superpowers:requesting-code-review`.
- [ ] Fix Critical and Important findings.
- [ ] Rerun affected tests and final verification commands.
- [ ] Confirm branch status is clean.

## Self-Review

Spec coverage:

- Adapter review requirement is enforced through file adapter/validation gate boundaries and import-boundary tests.
- Validation records become real v2 state through Task 1.
- Tool governance, file IO, validation, repair, and execution facade are covered by Tasks 2-6.
- Old agent internals are blocked by Task 7.
- Generated package convention and verification are covered by Task 8.

Placeholder scan:

- No unresolved placeholder markers remain.

Type consistency:

- `AgentV2ValidationRecord`, `UpsertAgentV2ValidationInput`, `AgentV2ValidationFailure`, `AgentV2RepairAction`, and `AgentV2ExecutionStepResult` are defined before later tasks consume them.
