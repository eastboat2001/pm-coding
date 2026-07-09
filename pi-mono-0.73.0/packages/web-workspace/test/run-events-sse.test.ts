import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNS_API_PREFIX } from "../src/constants.js";
import { RunApiError } from "../src/run-api-service.js";
import type { RunEventBus, RunEventReadRequest } from "../src/run-event-bus.js";
import type { RuntimeRunEventRecord, RuntimeRunRecord, StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const testRoots: string[] = [];

afterEach(() => {
	for (const root of testRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("runtime run SSE events", () => {
	it("sends durable catch-up events before live bus events", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([{ events: [runEvent(3)] }, { waitForAbort: true }]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([runEvent(1), runEvent(2)]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);

		await waitUntil(() => sseDataEvents(request.response.body).length === 3);

		expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(bus.readCalls[0]).toMatchObject({
			clientId: CLIENT_ID,
			sessionId: "session-a",
			runId: "run-a",
			afterSeq: 2,
			blockMs: 15000,
		});
		expect(request.response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		expect(request.response.headers.get("X-Accel-Buffering")).toBe("no");
		expect(request.response.headers.get("Cache-Control")).toContain("no-transform");

		request.close();
		await request.done;
	});

	it("deduplicates live events at or before the last sent durable sequence", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([{ events: [runEvent(3), runEvent(4)] }, { waitForAbort: true }]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([runEvent(3)]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=2`);

		await waitUntil(() => sseDataEvents(request.response.body).some((event) => event.seq === 4));

		expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([3, 4]);
		expect(bus.readCalls[0]?.afterSeq).toBe(3);

		request.close();
		await request.done;
	});

	it("compacts superseded live message updates before sending SSE events", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([
			{
				events: [
					runEvent(1, {
						type: "message_update",
						payload: { type: "message_update", message: { role: "assistant", content: "partial" } },
					}),
					runEvent(2, {
						type: "message_update",
						payload: { type: "message_update", message: { role: "assistant", content: "final" } },
					}),
					runEvent(3, {
						type: "message_end",
						payload: { type: "message_end", message: { role: "assistant", content: "final" } },
					}),
					runEvent(4, { type: "tool_execution_start", payload: { type: "tool_execution_start" } }),
				],
			},
			{ waitForAbort: true },
		]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);

		await waitUntil(() => bus.readCalls.length >= 2);

		expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([3, 4]);
		expect(bus.readCalls[1]?.afterSeq).toBe(4);

		request.close();
		await request.done;
	});

	it("returns 404 JSON without SSE headers when run ownership validation fails", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockRejectedValue(new RunApiError("Run not found.", 404)),
				listDurableRunEvents: vi.fn(),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await request.done;

		expect(request.response.statusCode).toBe(404);
		expect(JSON.parse(request.response.body)).toEqual({ error: "Run not found." });
		expect(request.response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(bus.readCalls).toEqual([]);
	});

	it("emits an SSE error event when live bus reads fail after headers are written", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([{ error: new Error("redis unavailable") }]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await request.done;

		expect(request.response.statusCode).toBe(200);
		expect(request.response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		expect(request.response.body).toContain(
			'event: error\ndata: {"message":"Runtime event stream unavailable."}\n\n',
		);
		expect(request.response.ended).toBe(true);
	});

	it("aborts the live bus read and releases the stream loop when the request closes", async () => {
		const run = runRecord();
		const bus = new ScriptedRunEventBus([{ waitForAbort: true }]);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await waitUntil(() => bus.readCalls.length >= 1);

		request.close();
		await request.done;

		expect(bus.readCalls[0]?.signal?.aborted).toBe(true);
		expect(bus.completedReads).toBe(1);
	});

	it("backs off after empty live bus reads and still exits promptly when the request closes", async () => {
		const run = runRecord();
		const bus = new EmptyRunEventBus(3);
		const harness = createSseHarness({
			runApi: {
				getRunForEvents: vi.fn().mockResolvedValue(run),
				listDurableRunEvents: vi.fn().mockResolvedValue([]),
			},
			runEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await waitUntil(() => bus.readCalls.length === 1);
		await delay(25);

		expect(bus.readCalls.length).toBeLessThan(3);
		expect(request.response.body).not.toContain("Runtime event stream unavailable.");

		request.close();
		await expect(withTimeout(request.done, 200)).resolves.toBe("completed");
	});
});

type TestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

function createSseHarness(options: { runApi: Partial<TestServices["runApi"]>; runEventBus: RunEventBus }) {
	let middleware: Middleware | undefined;
	const services = {
		config: createTestConfig(),
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
		} as unknown as TestServices["diagnostics"],
		sessions: {
			ensureDirs: vi.fn(),
			readSettings: vi.fn(),
			writeSettings: vi.fn(),
		} as unknown as TestServices["sessions"],
		files: {} as TestServices["files"],
		previews: { servePreviewRequest: vi.fn(() => false) } as unknown as TestServices["previews"],
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: { ensureSchema: vi.fn() } as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		runApi: options.runApi as TestServices["runApi"],
		runEventBus: options.runEventBus,
	} satisfies TestServices;
	const plugin = createConfiguredStoragePluginForTest(services);
	const configureServer = plugin.configureServer as (server: {
		middlewares: { use(handler: Middleware): void };
	}) => void;

	configureServer({
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});

	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return { middleware };
}

function dispatch(middleware: Middleware, url: string) {
	const request = new FakeRequest(url);
	const response = new FakeResponse();
	let nextCalled = false;
	const done = Promise.resolve(
		middleware(request as unknown as Connect.IncomingMessage, response as unknown as ServerResponse, () => {
			nextCalled = true;
		}),
	);
	return {
		close() {
			request.emit("close");
		},
		done,
		nextCalled: () => nextCalled,
		request,
		response,
	};
}

class FakeRequest extends EventEmitter {
	readonly headers = { accept: "text/event-stream", "x-pi-client-id": CLIENT_ID };
	readonly method = "GET";

	constructor(readonly url: string) {
		super();
	}
}

class FakeResponse {
	statusCode = 200;
	destroyed = false;
	ended = false;
	body = "";
	readonly headers = new Map<string, number | string | readonly string[]>();

	setHeader(name: string, value: number | string | readonly string[]): this {
		this.headers.set(name, value);
		return this;
	}

	flushHeaders(): void {}

	write(chunk: unknown): boolean {
		this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
		return true;
	}

	end(chunk?: unknown): this {
		if (chunk !== undefined) {
			this.write(chunk);
		}
		this.ended = true;
		return this;
	}
}

type BusReadStep = { events: RuntimeRunEventRecord[] } | { error: Error } | { waitForAbort: true };

class ScriptedRunEventBus implements RunEventBus {
	readonly readCalls: RunEventReadRequest[] = [];
	completedReads = 0;

	constructor(private readonly steps: BusReadStep[]) {}

	async publish(_event: RuntimeRunEventRecord): Promise<void> {}

	async read(request: RunEventReadRequest): Promise<RuntimeRunEventRecord[]> {
		this.readCalls.push(request);
		const step = this.steps.shift() ?? { waitForAbort: true };
		try {
			if ("events" in step) return step.events;
			if ("error" in step) throw step.error;
			if (request.signal?.aborted) return [];
			return await new Promise<RuntimeRunEventRecord[]>((resolve) => {
				request.signal?.addEventListener("abort", () => resolve([]), { once: true });
			});
		} finally {
			this.completedReads += 1;
		}
	}

	async close(): Promise<void> {}
}

class EmptyRunEventBus implements RunEventBus {
	readonly readCalls: RunEventReadRequest[] = [];

	constructor(private readonly failAfterReads: number) {}

	async publish(_event: RuntimeRunEventRecord): Promise<void> {}

	async read(request: RunEventReadRequest): Promise<RuntimeRunEventRecord[]> {
		this.readCalls.push(request);
		if (this.readCalls.length >= this.failAfterReads) {
			throw new Error("empty read busy loop");
		}
		return [];
	}

	async close(): Promise<void> {}
}

function createTestConfig(): StorageConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-web-workspace-sse-"));
	testRoots.push(root);
	return {
		settingsFile: join(root, "settings.json"),
		clientsRootDir: join(root, "clients"),
		skillsDir: join(root, "skills"),
		defaultSkillsDir: join(root, "default-skills"),
		runtimeDbFile: join(root, "runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "sqlite",
		postgresUrl: "postgres://user:pass@example.com:5432/pi",
		runsEnabled: true,
		workerId: "test-worker",
		workerConcurrency: 1,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "test-runs",
		agentV2RunQueueName: "pi:agent-v2:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 100,
		runEventStreamTtlSeconds: 60,
		agentV2RunEventStreamMaxLen: 5000,
		agentV2RunEventStreamTtlSeconds: 3600,
		runEventCheckpointIntervalMs: 100,
		runEventCheckpointMinChars: 16,
		clientIdRequired: false,
		previewBaseUrl: "",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 1_000,
		projectBuildTimeoutMs: 1_000,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "logs.sqlite"),
		loggingEnabled: false,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 1_000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 1_000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 1_000,
		modelStreamIdleTimeoutMs: 60_000,
		modelMaxOutputTokens: 12_000,
		contextProviderPayloadBudgetChars: 90_000,
		logRetentionDays: 30,
		logMaxEvents: 1_000,
		logCleanupIntervalMs: 3_600_000,
		logVacuumIntervalMs: 86_400_000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 1_000,
		langfuseBatchSize: 10,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web-test",
		otelDeploymentEnvironment: "",
	};
}

function runRecord(overrides: Partial<RuntimeRunRecord> = {}): RuntimeRunRecord {
	return {
		runId: "run-a",
		sessionId: "session-a",
		clientId: CLIENT_ID,
		status: "running",
		model: {},
		thinkingLevel: "high",
		updatedAt: "2026-06-30T00:00:00.000Z",
		...overrides,
	};
}

function runEvent(seq: number, overrides: Partial<RuntimeRunEventRecord> = {}): RuntimeRunEventRecord {
	return {
		eventId: seq,
		runId: "run-a",
		sessionId: "session-a",
		clientId: CLIENT_ID,
		seq,
		type: "message.delta",
		payload: { text: `event ${seq}` },
		createdAt: `2026-06-30T00:00:0${seq}.000Z`,
		...overrides,
	};
}

function sseDataEvents(body: string): RuntimeRunEventRecord[] {
	return body
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => JSON.parse(chunk.slice("data: ".length)) as RuntimeRunEventRecord);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error(`Timed out waiting for predicate. Last check: ${predicate()}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<"completed"> {
	await Promise.race([
		promise,
		delay(timeoutMs).then(() => {
			throw new Error(`Timed out after ${timeoutMs}ms`);
		}),
	]);
	return "completed";
}
