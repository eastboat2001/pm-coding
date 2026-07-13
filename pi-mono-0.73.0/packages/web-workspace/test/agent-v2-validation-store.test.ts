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

	it("appends immutable validation attempts and lists them in deterministic order", () => {
		const store = createStore();
		store.createAgentV2Run({
			clientId: "client-a",
			runId: "run-a",
			input: { prompt: "Build a static app" },
			model: { provider: "test" },
			createdAt: "2026-07-08T00:00:00.000Z",
		});

		store.appendAgentV2ValidationAttempt({
			clientId: "client-a",
			runId: "run-a",
			validationId: "validate-static",
			attempt: 1,
			taskId: "validate",
			artifactId: "index-html",
			status: "failed",
			summary: "Static quality gate failed",
			details: { failures: [{ code: "static.loading_visible", path: "index.html" }] },
			createdAt: "2026-07-08T00:01:00.000Z",
			updatedAt: "2026-07-08T00:01:00.000Z",
		});
		const second = store.appendAgentV2ValidationAttempt({
			clientId: "client-a",
			runId: "run-a",
			validationId: "validate-static",
			attempt: 2,
			status: "passed",
			summary: "Static quality gate passed after repair",
			details: { repaired: true },
			createdAt: "2026-07-08T00:01:30.000Z",
			updatedAt: "2026-07-08T00:01:30.000Z",
		});
		expect(second).toMatchObject({ validationId: "validate-static", attempt: 2, status: "passed" });
		store.appendAgentV2ValidationAttempt({
			clientId: "client-a",
			runId: "run-a",
			validationId: "validate-smoke",
			attempt: 1,
			status: "passed",
			summary: "Smoke gate passed",
			details: { checkedFiles: ["index.html"] },
			createdAt: "2026-07-08T00:02:00.000Z",
			updatedAt: "2026-07-08T00:02:00.000Z",
		});

		expect(store.listAgentV2Validations("client-a", "run-a")).toEqual([
			expect.objectContaining({
				validationId: "validate-static",
				attempt: 1,
				taskId: "validate",
				artifactId: "index-html",
				status: "failed",
				details: { failures: [{ code: "static.loading_visible", path: "index.html" }] },
			}),
			expect.objectContaining({
				validationId: "validate-static",
				attempt: 2,
				status: "passed",
				details: { repaired: true },
			}),
			expect.objectContaining({
				validationId: "validate-smoke",
				status: "passed",
				details: { checkedFiles: ["index.html"] },
			}),
		]);
	});

	it("returns an identical replay and rejects conflicting content for the same attempt", () => {
		const store = createStore();
		store.createAgentV2Run({ clientId: "client-a", runId: "run-a", input: {}, model: {} });
		const input = {
			clientId: "client-a",
			runId: "run-a",
			validationId: "static",
			attempt: 1,
			status: "failed" as const,
			summary: "failed",
			details: { code: "x", nested: { z: 1, a: 2 } },
			createdAt: "2026-07-08T00:00:00.000Z",
			updatedAt: "2026-07-08T00:00:00.000Z",
		};
		const first = store.appendAgentV2ValidationAttempt(input);
		expect(
			store.appendAgentV2ValidationAttempt({
				...input,
				details: { nested: { a: 2, z: 1 }, code: "x" },
			}),
		).toEqual(first);
		expect(() => store.appendAgentV2ValidationAttempt({ ...input, summary: "different" })).toThrow(
			"Agent v2 validation attempt conflict",
		);
		expect(store.listAgentV2Validations("client-a", "run-a")).toHaveLength(1);
	});

	it("requires a positive attempt", () => {
		const store = createStore();
		store.createAgentV2Run({ clientId: "client-a", runId: "run-a", input: {}, model: {} });
		expect(() =>
			store.appendAgentV2ValidationAttempt({
				clientId: "client-a",
				runId: "run-a",
				validationId: "static",
				attempt: 0,
				status: "passed",
				summary: "bad attempt",
				details: {},
			}),
		).toThrow();
	});
});

function createStore(): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-validation-store-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return store;
}
