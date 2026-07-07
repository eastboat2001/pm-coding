import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import type { WorkerAgentInput } from "../../../packages/web-workspace/src/index.js";
import { afterEach, describe, expect, it } from "vitest";
import { selectApplicationGenerationRuntime } from "../src/agent-v2/runtime-entry.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";
import { createRunAgent } from "../src/worker/main.js";

describe("application generation runtime entry", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = undefined;
		delete process.env.PI_APP_AGENT_VERSION;
	});

	it("selects v2 by default", () => {
		expect(selectApplicationGenerationRuntime({})).toMatchObject({
			version: "v2",
			v1Disabled: true,
			platformContract: STATIC_PREVIEW_CONTRACT,
		});
		expect(selectApplicationGenerationRuntime({}).buildPlanningBootstrap).toEqual(expect.any(Function));
	});

	it("rejects v1 as a product runtime", () => {
		expect(() => selectApplicationGenerationRuntime({ requestedVersion: "v1" })).toThrow(
			"v1 is retired",
		);
	});

	it("does not expose v1 as a stable version option", () => {
		expect(selectApplicationGenerationRuntime({ requestedVersion: "v2" })).toMatchObject({
			version: "v2",
			v1Disabled: true,
		});
	});

	it("returns a fresh selection object for each successful call", () => {
		const first = selectApplicationGenerationRuntime({});
		const mutated = {
			...first,
			reason: "mutated",
		};
		const second = selectApplicationGenerationRuntime({});

		expect(mutated.reason).toBe("mutated");
		expect(second.reason).toContain("replacement default");
		expect(second).not.toBe(first);
	});

	it("rejects retired v1 before createRunAgent constructs the worker agent", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-runtime-entry-"));
		process.env.PI_APP_AGENT_VERSION = "v1";

		expect(() =>
			createRunAgent(createWorkerInput(), {
				config: loadStorageConfig(dir),
				diagnostics: { writeEvents: () => ({ accepted: 0, dropped: 0 }) },
				skills: { load: () => ({ name: "unused", content: "unused" }) },
				promptSkills: [],
				defaultSkills: [],
			}),
		).toThrow("v1 is retired");
	});
});

function createWorkerInput(): WorkerAgentInput {
	return {
		run: {
			runId: "run-1",
			clientId: "client-a",
			sessionId: "session-1",
			status: "running",
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "medium",
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
		},
		session: {
			sessionId: "session-1",
			clientId: "client-a",
			title: "Runtime guard",
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "medium",
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
		},
		messages: [
			{
				messageId: 1,
				clientId: "client-a",
				sessionId: "session-1",
				role: "user",
				payload: { content: "hello" },
				createdAt: "2026-06-11T00:00:00.000Z",
			},
		],
		model: {
			id: "test-model",
			name: "Test Model",
			api: "openai-completions",
			provider: "Test Provider",
			baseUrl: "http://127.0.0.1:8000/v1",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
		},
		thinkingLevel: "medium",
		signal: new AbortController().signal,
	};
}
