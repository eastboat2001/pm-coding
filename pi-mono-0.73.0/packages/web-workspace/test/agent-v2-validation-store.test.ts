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
