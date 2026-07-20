import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildAgentV2PlanningBootstrap,
	persistAgentV2PlanningBootstrap,
	toAgentV2PlanningCommit,
} from "../src/agent-v2-planning-bootstrap.js";
import { AGENT_V2_RUN_EVENT_TYPES, type AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

describe("agent v2 planning bootstrap", () => {
	const cleanupRoots: string[] = [];
	const cleanupStores: RuntimeDbStore[] = [];

	afterEach(() => {
		for (const store of cleanupStores.splice(0)) store.close();
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("persists capability, spec, plan, task graph, and artifact index for a v2 run", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-plan",
			input: { objective: "Build a dashboard with login auth simulated in static preview." },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-07T00:00:00.000Z",
		});

		const bootstrap = buildAgentV2PlanningBootstrap({
			run,
			now: () => "2026-07-07T00:01:00.000Z",
		});
		await persistAgentV2PlanningBootstrap(store, bootstrap);

		expect(store.listAgentV2Documents("client-a", "run-v2-plan").map((doc) => doc.documentId)).toEqual([
			"capability_decision",
			"product_blueprint",
			"spec",
			"plan",
			"tasks",
		]);
		expect(store.listAgentV2Tasks("client-a", "run-v2-plan").map((task) => task.taskId)).toEqual([
			"capability",
			"spec",
			"plan",
			"implement",
			"validate",
			"deliver",
		]);
		expect(store.listAgentV2Artifacts("client-a", "run-v2-plan").map((artifact) => artifact.path)).toEqual([
			"agent-v2/capability-decision.json",
			"agent-v2/product-blueprint.md",
			"agent-v2/spec.md",
			"agent-v2/plan.md",
			"agent-v2/tasks.json",
		]);
		expect(store.listAgentV2Diagnostics("client-a", "run-v2-plan")).toEqual([
			expect.objectContaining({
				diagnosticId: "capability-routing",
				category: "planning",
				severity: "info",
				phase: "capability_routing",
				taskId: "capability",
			}),
		]);
	});

	it("repeats persistence safely for the same bootstrap without duplicating diagnostics", async () => {
		const store = createTempRuntimeDbStoreWithV2Schema(cleanupRoots, cleanupStores);
		const run = store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-v2-retry",
			input: { objective: "Build a dashboard with login auth simulated in static preview." },
			model: { provider: "test", model: "local" },
			createdAt: "2026-07-07T00:00:00.000Z",
		});

		const bootstrap = buildAgentV2PlanningBootstrap({
			run,
			now: () => "2026-07-07T00:01:00.000Z",
		});

		await persistAgentV2PlanningBootstrap(store, bootstrap);
		await expect(persistAgentV2PlanningBootstrap(store, bootstrap)).resolves.toMatchObject({
			documents: expect.arrayContaining([
				expect.objectContaining({ documentId: "capability_decision" }),
				expect.objectContaining({ documentId: "product_blueprint" }),
				expect.objectContaining({ documentId: "spec" }),
				expect.objectContaining({ documentId: "plan" }),
				expect.objectContaining({ documentId: "tasks" }),
			]),
			artifacts: expect.arrayContaining([
				expect.objectContaining({ artifactId: "capability_decision" }),
				expect.objectContaining({ artifactId: "product_blueprint", sourceTaskId: "spec" }),
				expect.objectContaining({ artifactId: "spec" }),
				expect.objectContaining({ artifactId: "plan" }),
				expect.objectContaining({ artifactId: "tasks", sourceTaskId: "plan" }),
			]),
		});

		expect(store.listAgentV2Diagnostics("client-a", "run-v2-retry")).toEqual([
			expect.objectContaining({
				diagnosticId: "capability-routing",
				category: "planning",
				severity: "info",
				phase: "capability_routing",
				taskId: "capability",
			}),
		]);
	});

	it("converts the pure bootstrap to a complete deterministic durable commit", () => {
		const run = planningRun([{ kind: "project_file", ordinal: 0, logicalPath: "a.txt", checksum: "sha256:a" }]);
		const bootstrap = buildAgentV2PlanningBootstrap({
			run,
			now: () => "2026-07-07T00:01:00.000Z",
		});
		const first = toAgentV2PlanningCommit(bootstrap);
		const replay = toAgentV2PlanningCommit(
			buildAgentV2PlanningBootstrap({ run, now: () => "2026-07-07T00:01:00.000Z" }),
		);

		expect(first).toMatchObject({
			bootstrapVersion: "agent-v2-planning-v2",
			documents: bootstrap.documents,
			tasks: bootstrap.tasks,
			artifacts: bootstrap.artifacts,
			diagnostics: bootstrap.diagnostics,
		});
		expect(first.bootstrapChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(replay.bootstrapChecksum).toBe(first.bootstrapChecksum);
	});

	it("binds the bootstrap checksum to ordered canonical input reference metadata and bytes", () => {
		const commit = (references: Array<Record<string, unknown>>) =>
			toAgentV2PlanningCommit(
				buildAgentV2PlanningBootstrap({
					run: planningRun(references),
					now: () => "2026-07-07T00:01:00.000Z",
				}),
			).bootstrapChecksum;
		const first = { kind: "project_file", ordinal: 0, logicalPath: "a.txt", checksum: "sha256:a" };
		const second = { kind: "project_file", ordinal: 1, logicalPath: "b.txt", checksum: "sha256:b" };

		expect(commit([first, second])).not.toBe(commit([second, first]));
		expect(commit([first])).not.toBe(commit([{ ...first, checksum: "sha256:changed" }]));
	});

	it("exposes planning_ready as a public v2 transport event type", () => {
		expect(AGENT_V2_RUN_EVENT_TYPES).toContain("agent_v2.planning_ready");
	});

	it("does not fall back to legacy prompt when objective is absent", () => {
		const run = { ...planningRun([]), input: { prompt: "legacy prompt" } } as unknown as AgentV2RunSnapshot;
		expect(() => buildAgentV2PlanningBootstrap({ run, now: () => "2026-07-07T00:01:00.000Z" })).toThrow(/objective/i);
	});
});

function planningRun(inputReferences: Array<Record<string, unknown>>) {
	return {
		clientId: "client-a",
		runId: "run-checksum",
		status: "queued" as const,
		phase: "intake" as const,
		attempt: 1,
		input: {
			sessionId: "session-a",
			title: "Example",
			objective: "Build a dashboard",
			inputReferences,
		},
		model: { provider: "test", id: "local" },
		createdAt: "2026-07-07T00:00:00.000Z",
		updatedAt: "2026-07-07T00:00:00.000Z",
	};
}

function createTempRuntimeDbStoreWithV2Schema(cleanupRoots: string[], cleanupStores: RuntimeDbStore[]): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-planning-bootstrap-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}
