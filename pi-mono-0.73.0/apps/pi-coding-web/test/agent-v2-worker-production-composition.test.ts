import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai/types";
import { AgentV2RunApiService, RuntimeDbStore } from "@mariozechner/pi-web-workspace";
import {
	AgentV2RunEventLog,
	AgentV2WorkerService,
	InMemoryAgentV2RunQueue,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import { loadStorageConfig } from "@mariozechner/pi-web-workspace/runtime-infra";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentV2WorkerExecution } from "../src/worker/main.js";

const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "run-production-composition";
const SESSION_ID = "session-production-composition";
const PROVIDER = "custom-provider:provider-a";
const MODEL_ID = "custom-model";
const SERVER_BASE_URL = "https://server-owned.example/v1";
const CLIENT_BASE_URL = "https://client-controlled.invalid/v1";
const SERVER_API_KEY = "server-owned-test-key";
const RAW_PROVIDER_SUMMARY = "RAW_PROVIDER_SUMMARY_MUST_NOT_REENTER_PROMPTS_OR_STORAGE";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent v2 worker production composition", () => {
	it("crosses the real worker factory and PI completion seam with trusted server settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-worker-composition-"));
		roots.push(root);
		const config = loadStorageConfig(root);
		const store = new RuntimeDbStore(config.runtimeDbFile);
		stores.push(store);
		store.ensureAgentV2Schema();
		mkdirSync(join(config.clientsRootDir, CLIENT_ID, "sessions", SESSION_ID, "project"), { recursive: true });

		const eventLog = new AgentV2RunEventLog({ store });
		const api = new AgentV2RunApiService({
			store,
			events: eventLog,
			queueName: "agent-v2-production-composition",
			createRunId: () => RUN_ID,
			now: timestampSequence("2026-07-14T01:00:00.000Z", "2026-07-14T01:00:01.000Z"),
		});

		await expect(
			api.startRun(CLIENT_ID, {
				runId: "run-client-model-rejected",
				input: startInput(),
				model: { provider: PROVIDER, id: MODEL_ID, baseUrl: CLIENT_BASE_URL },
			}),
		).rejects.toThrow(/model/i);

		const run = await api.startRun(CLIENT_ID, {
			input: startInput(),
			model: { provider: PROVIDER, id: MODEL_ID },
		});
		const queue = new InMemoryAgentV2RunQueue();
		await queue.enqueue({ clientId: CLIENT_ID, runId: RUN_ID });

		const readSettingsFile = vi.fn(() => JSON.stringify(serverSettings()));
		const getEnvApiKey = vi.fn(() => undefined);
		let responseIndex = 0;
		const complete = vi.fn(async (): Promise<AssistantMessage> => {
			const text =
				responseIndex++ === 0
					? JSON.stringify({
							version: 1,
							taskId: "implement",
							summary: RAW_PROVIDER_SUMMARY,
							files: [{ path: "index.html", content: '<!doctype html><div id="loading">Loading...</div>' }],
						})
					: JSON.stringify({
							version: 1,
							taskId: "repair:validate:1",
							summary: RAW_PROVIDER_SUMMARY,
							files: [{ path: "index.html", content: "<!doctype html><main>Ready</main>" }],
							addressedDiagnosticIds: ["agent_v2.validation_failed:validate:1"],
						});
			return assistantMessage(text);
		});
		const execution = createAgentV2WorkerExecution(config, store, {
			settingsSources: {
				readSettingsFile,
				getEnvApiKey,
				getBuiltinProviders: () => [],
			},
			complete,
			previewReadinessChecker: {
				check: async () => ({ ready: true, reasonCode: "ready" as const }),
			},
		});
		const worker = new AgentV2WorkerService({
			store,
			queue,
			events: eventLog,
			execution,
			workerId: "worker-production-composition",
		});

		await expect(worker.processOne()).resolves.toBe(true);

		expect(readSettingsFile).toHaveBeenCalledTimes(1);
		expect(getEnvApiKey).not.toHaveBeenCalled();
		expect(complete).toHaveBeenCalledTimes(2);
		for (const [model, _context, options] of complete.mock.calls) {
			expect(model).toMatchObject({
				provider: PROVIDER,
				id: MODEL_ID,
				api: "openai-completions",
				baseUrl: SERVER_BASE_URL,
			});
			expect(model.baseUrl).not.toBe(CLIENT_BASE_URL);
			expect(options).toMatchObject({ apiKey: SERVER_API_KEY, maxRetries: 0 });
		}

		const implementationPrompt = promptText(complete.mock.calls[0]?.[1]);
		const repairPrompt = promptText(complete.mock.calls[1]?.[1]);
		for (const expected of ["Build the production composition fixture", "src/brief.txt"]) {
			expect(implementationPrompt).toContain(expected);
			expect(repairPrompt).toContain(expected);
		}
		expect(implementationPrompt).toContain("contentProjection\":\"product_blueprint");
		expect(implementationPrompt).not.toContain("committed composition input");
		expect(repairPrompt).not.toContain("committed composition input");
		for (const expected of ["index.html", "Loading...", "static.loading_visible"]) {
			expect(repairPrompt).toContain(expected);
		}
		expect(repairPrompt).not.toContain(RAW_PROVIDER_SUMMARY);
		expect(implementationPrompt).not.toContain(CLIENT_BASE_URL);
		expect(repairPrompt).not.toContain(CLIENT_BASE_URL);

		expect(await api.getRun(CLIENT_ID, RUN_ID)).toMatchObject({
			status: "succeeded",
			phase: "delivery",
			model: { provider: PROVIDER, id: MODEL_ID },
			workerId: "worker-production-composition",
		});
		expect(run.model).toEqual({ provider: PROVIDER, id: MODEL_ID });
		expect(store.listAgentV2Artifacts(CLIENT_ID, RUN_ID)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "index.html",
					sourceTaskId: "repair:validate:1",
					validationStatus: "passed",
				}),
			]),
		);
		expect(store.listAgentV2Validations(CLIENT_ID, RUN_ID)).toEqual([
			expect.objectContaining({ attempt: 1, status: "failed", taskId: "validate" }),
			expect.objectContaining({ attempt: 2, status: "passed", taskId: "revalidate:validate:2" }),
		]);
		expect(
			JSON.stringify({
				run: await api.getRun(CLIENT_ID, RUN_ID),
				events: store.listAgentV2RunEvents(CLIENT_ID, RUN_ID, 0),
				diagnostics: store.listAgentV2Diagnostics(CLIENT_ID, RUN_ID),
			}),
		).not.toContain(RAW_PROVIDER_SUMMARY);
	});
});

function startInput() {
	return {
		objective: "Build the production composition fixture",
		sessionId: SESSION_ID,
		title: "Production Composition",
		projectFiles: [{ filename: "src/brief.txt", content: "committed composition input" }],
		attachments: [],
	};
}

function serverSettings() {
	return {
		customProviders: [
			{
				id: "provider-a",
				name: "Provider A",
				type: "openai-completions",
				baseUrl: SERVER_BASE_URL,
				apiKey: SERVER_API_KEY,
				models: [
					{
						id: MODEL_ID,
						name: "Custom Model",
						api: "openai-completions",
						provider: PROVIDER,
						baseUrl: SERVER_BASE_URL,
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 16_000,
						maxTokens: 2_000,
					},
				],
			},
		],
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL_ID,
		usage: {
			input: 11,
			output: 7,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 18,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function promptText(context: { messages: readonly unknown[] } | undefined): string {
	const message = context?.messages[0];
	if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") {
		throw new Error("Expected one text user prompt");
	}
	return message.content;
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps[timestamps.length - 1] ?? "2026-07-14T01:00:00.000Z";
}
