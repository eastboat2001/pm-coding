import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentV2PlanningBootstrap, persistAgentV2PlanningBootstrap } from "../src/agent-v2-planning-bootstrap.js";
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
			input: { prompt: "Build a dashboard with login auth simulated in static preview." },
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
			input: { prompt: "Build a dashboard with login auth simulated in static preview." },
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
				expect.objectContaining({ documentId: "spec" }),
				expect.objectContaining({ documentId: "plan" }),
				expect.objectContaining({ documentId: "tasks" }),
			]),
			artifacts: expect.arrayContaining([
				expect.objectContaining({ artifactId: "capability_decision" }),
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
});

function createTempRuntimeDbStoreWithV2Schema(cleanupRoots: string[], cleanupStores: RuntimeDbStore[]): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-planning-bootstrap-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureSchema();
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}
