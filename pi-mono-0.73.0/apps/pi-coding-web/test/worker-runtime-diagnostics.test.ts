import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
	createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
// Import workspace runtime sources directly so this test cannot pass against stale dist output.
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import { RuntimeDbStore } from "../../../packages/web-workspace/src/runtime-db.js";
import { InMemoryRunQueue } from "../../../packages/web-workspace/src/run-queue.js";
import { WorkspaceRunWorkerService } from "../../../packages/web-workspace/src/run-worker-service.js";
import type { JsonObject, WorkerAgentInput } from "../../../packages/web-workspace/src/types.js";
import { createRunAgent } from "../src/worker/main.js";

describe("worker runtime diagnostics", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = undefined;
	});

	it("wraps worker model streams with provider diagnostics", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-diagnostics-"));
		const diagnostics = new RecordingDiagnostics();
		const input = createWorkerInput();
		const model = input.model as Model<any>;
		const agent = createRunAgent(input, {
			config: loadStorageConfig(dir),
			diagnostics,
			skills: { load: () => ({ name: "unused", content: "unused" }) },
			promptSkills: [],
			defaultSkills: [],
			streamFn: async (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
				await options?.onPayload?.({ messages: [{ role: "user", content: "hello" }] }, model);
				await options?.onResponse?.({ status: 200, headers: { "x-request-id": "worker-upstream" } }, model);
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = createAssistantMessage();
					stream.push({ type: "start", partial: message });
					stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});

		await agent.prompt(input.messages.at(-1)!);

		expect(diagnostics.events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.request.start",
					provider: "Test Provider",
					model: "test-model",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.payload",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "provider.response",
				}),
				expect.objectContaining({
					clientId: "client-a",
					sessionId: "session-1",
					traceId: "session-1",
					eventType: "model.stream.summary",
					data: expect.objectContaining({ textChars: 4 }),
				}),
			]),
		);
	});

	it("uses worker config for stalled provider stream idle timeout", async () => {
		vi.useFakeTimers();
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-idle-timeout-"));
		const diagnostics = new RecordingDiagnostics();
		const input = createWorkerInput();
		const config = { ...loadStorageConfig(dir), modelStreamIdleTimeoutMs: 25 } as ReturnType<typeof loadStorageConfig> & {
			modelStreamIdleTimeoutMs: number;
		};
		const stalledStream = createAssistantMessageEventStream();
		let promptPromise: Promise<void> | undefined;

		try {
			const agent = createRunAgent(input, {
				config,
				diagnostics,
				skills: { load: () => ({ name: "unused", content: "unused" }) },
				promptSkills: [],
				defaultSkills: [],
				streamFn: async () => stalledStream,
			});

			promptPromise = agent.prompt(input.messages.at(-1)!);
			await vi.advanceTimersByTimeAsync(25);
			await Promise.resolve();

			const status = await Promise.race([promptPromise.then(() => "resolved"), Promise.resolve("pending")]);
			expect(status).toBe("resolved");
			expect(diagnostics.events).toContainEqual(
				expect.objectContaining({
					eventType: "model.stream.summary",
					level: "error",
					data: expect.objectContaining({
						stopReason: "error",
						errorMessage: expect.stringContaining("Model stream stalled for 25ms without events"),
					}),
				}),
			);
		} finally {
			if (promptPromise) {
				const message = createAssistantMessage({ text: "cleanup" });
				stalledStream.push({ type: "done", reason: "stop", message });
				await promptPromise.catch(() => {});
			}
			vi.useRealTimers();
		}
	});

	it("retries production stream error final events before persisting assistant errors", async () => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-runtime-retry-"));
		const diagnostics = new RecordingDiagnostics();
		const config = loadStorageConfig(dir);
		const db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		const queue = new InMemoryRunQueue();
		let streamAttempts = 0;

		try {
			db.ensureSchema();
			const run = createQueuedRun(db);
			await queue.enqueue({ clientId: run.clientId, runId: run.runId });

			const worker = new WorkspaceRunWorkerService({
				db,
				queue,
				workerId: "worker-1",
				diagnostics,
				retry: { sleep: async () => {} },
				createAgent(input) {
					return createRunAgent(input, {
						config,
						diagnostics,
						skills: { load: () => ({ name: "unused", content: "unused" }) },
						promptSkills: [],
						defaultSkills: [],
						streamFn: async (_model: Model<any>, _context: Context, _options?: SimpleStreamOptions) => {
							streamAttempts += 1;
							const stream = createAssistantMessageEventStream();
							queueMicrotask(() => {
								if (streamAttempts === 1) {
									stream.push({
										type: "error",
										reason: "error",
										error: createAssistantMessage({
											stopReason: "error",
											errorMessage: "503 service unavailable",
										}),
									});
									return;
								}
								const message = createAssistantMessage({ text: "done" });
								stream.push({ type: "start", partial: message });
								stream.push({ type: "text_delta", contentIndex: 0, delta: "done", partial: message });
								stream.push({ type: "done", reason: "stop", message });
							});
							return stream;
						},
					});
				},
			});

			await expect(worker.processOne()).resolves.toBe(true);

			expect(streamAttempts).toBe(2);
			expect(db.getRun(run.clientId, run.runId)?.status).toBe("completed");
			const messages = db.listMessages(run.clientId, run.sessionId);
			expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
			expect(JSON.stringify(messages)).not.toContain("503 service unavailable");
			expect(diagnostics.events).toContainEqual(
				expect.objectContaining({
					eventType: "agent.retry_scheduled",
					level: "warn",
					category: "agent",
					data: expect.objectContaining({
						runId: run.runId,
						reasonCode: "transient_provider_error",
					}),
				}),
			);
		} finally {
			await queue.close();
			db.close();
		}
	});
});

class RecordingDiagnostics {
	events: JsonObject[] = [];

	writeEvents(input: { events: JsonObject[] }): JsonObject {
		this.events.push(...input.events);
		return { accepted: input.events.length, dropped: 0 };
	}
}

function createWorkerInput(): WorkerAgentInput {
	return {
		run: {
			runId: "run-1",
			clientId: "client-a",
			sessionId: "session-1",
			status: "running",
			model: createModel(),
			thinkingLevel: "medium",
			createdAt: "2026-06-11T00:00:00.000Z",
			updatedAt: "2026-06-11T00:00:00.000Z",
		},
		session: {
			sessionId: "session-1",
			clientId: "client-a",
			title: "Diagnostics",
			model: createModel(),
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
		model: createModel(),
		thinkingLevel: "medium",
		signal: new AbortController().signal,
	};
}

function createQueuedRun(db: RuntimeDbStore) {
	const model = createModel();
	db.upsertClient("client-a");
	const session = db.createSession({
		clientId: "client-a",
		sessionId: "session-1",
		title: "Diagnostics",
		model,
		thinkingLevel: "medium",
	});
	db.appendMessage({
		clientId: session.clientId,
		sessionId: session.sessionId,
		role: "user",
		payload: { content: "hello" },
	});
	return db.createRun({
		clientId: session.clientId,
		sessionId: session.sessionId,
		runId: "run-1",
		model,
		thinkingLevel: "medium",
	});
}

function createModel(): Model<"openai-completions"> {
	return {
		id: "test-model",
		name: "Test Model",
		api: "openai-completions",
		provider: "Test Provider",
		baseUrl: "http://127.0.0.1:8000/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 32768,
		maxTokens: 4096,
	};
}

function createAssistantMessage(
	options: { text?: string; stopReason?: "stop" | "error"; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: options.text ?? "" }],
		api: "openai-completions",
		provider: "Test Provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		timestamp: Date.now(),
	};
}
