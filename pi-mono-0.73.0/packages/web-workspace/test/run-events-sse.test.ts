import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import type { AgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import type { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import type { AgentV2RunEventReadRequest } from "../src/agent-v2-run-events.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const RUNS_API_PREFIX = "/api/agent-v2/runs";
const testRoots: string[] = [];

afterEach(() => {
	for (const root of testRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("agent v2 runtime run SSE events", () => {
	it("sends durable catch-up events before live bus events", async () => {
		const run = runSnapshot();
		const bus = new ScriptedAgentV2RunEventBus([{ events: [runEvent(3)] }, { waitForAbort: true }]);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(run),
			},
			runEventLog: {
				list: vi.fn().mockResolvedValue([runEvent(1), runEvent(2)]),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);

		await waitUntil(() => sseDataEvents(request.response.body).length === 3);

		expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([1, 2, 3]);
		expect(bus.readCalls[0]).toMatchObject({
			clientId: CLIENT_ID,
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
		const run = runSnapshot();
		const bus = new ScriptedAgentV2RunEventBus([{ events: [runEvent(3), runEvent(4)] }, { waitForAbort: true }]);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(run),
			},
			runEventLog: {
				list: vi.fn().mockResolvedValue([runEvent(3)]),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=2`);

		await waitUntil(() => sseDataEvents(request.response.body).some((event) => event.seq === 4));

		expect(sseDataEvents(request.response.body).map((event) => event.seq)).toEqual([3, 4]);
		expect(bus.readCalls[0]?.afterSeq).toBe(3);

		request.close();
		await request.done;
	});

	it("returns 404 JSON without SSE headers when the v2 run does not exist", async () => {
		const bus = new ScriptedAgentV2RunEventBus([]);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(undefined),
			},
			runEventLog: {
				list: vi.fn(),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/missing-run/events?stream=1&afterSeq=0`);
		await request.done;

		expect(request.response.statusCode).toBe(404);
		expect(JSON.parse(request.response.body)).toEqual({ error: "Agent v2 run not found." });
		expect(request.response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
		expect(bus.readCalls).toEqual([]);
	});

	it("emits an SSE error event when live bus reads fail after headers are written", async () => {
		const run = runSnapshot();
		const bus = new ScriptedAgentV2RunEventBus([{ error: new Error("redis unavailable") }]);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(run),
			},
			runEventLog: {
				list: vi.fn().mockResolvedValue([]),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await request.done;

		expect(request.response.statusCode).toBe(200);
		expect(request.response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		expect(request.response.body).toContain(
			'event: error\ndata: {"message":"Agent v2 runtime event stream unavailable."}\n\n',
		);
		expect(request.response.ended).toBe(true);
	});

	it("aborts the live bus read and releases the stream loop when the request closes", async () => {
		const run = runSnapshot();
		const bus = new ScriptedAgentV2RunEventBus([{ waitForAbort: true }]);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(run),
			},
			runEventLog: {
				list: vi.fn().mockResolvedValue([]),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await waitUntil(() => bus.readCalls.length >= 1);

		request.close();
		await request.done;

		expect(bus.readCalls[0]?.signal?.aborted).toBe(true);
		expect(bus.completedReads).toBe(1);
	});

	it("backs off after empty live bus reads and still exits promptly when the request closes", async () => {
		const run = runSnapshot();
		const bus = new EmptyAgentV2RunEventBus(3);
		const harness = createSseHarness({
			agentV2RunApi: {
				getRun: vi.fn().mockResolvedValue(run),
			},
			runEventLog: {
				list: vi.fn().mockResolvedValue([]),
			},
			agentV2RunEventBus: bus,
		});

		const request = dispatch(harness.middleware, `${RUNS_API_PREFIX}/${run.runId}/events?stream=1&afterSeq=0`);
		await waitUntil(() => bus.readCalls.length === 1);
		await delay(25);

		expect(bus.readCalls.length).toBeLessThan(3);
		expect(request.response.body).not.toContain("Agent v2 runtime event stream unavailable.");

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

function createSseHarness(options: {
	agentV2RunApi: Partial<AgentV2RunApiService>;
	runEventLog: Pick<AgentV2RunEventLog, "list">;
	agentV2RunEventBus: AgentV2RunEventBus;
}) {
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
		runtimeDb: { ensureAgentV2Schema: vi.fn() } as unknown as TestServices["runtimeDb"],
		diagnosticExports: {} as TestServices["diagnosticExports"],
		agentV2RunApi: options.agentV2RunApi as TestServices["agentV2RunApi"],
		agentV2RunEventBus: options.agentV2RunEventBus,
		agentV2RunEventLog: options.runEventLog,
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

type BusReadStep = { events: AgentV2RunEventRecord[] } | { error: Error } | { waitForAbort: true };

class ScriptedAgentV2RunEventBus implements AgentV2RunEventBus {
	async project(): Promise<"projected"> {
		return "projected";
	}
	readonly readCalls: AgentV2RunEventReadRequest[] = [];
	completedReads = 0;

	constructor(private readonly steps: BusReadStep[]) {}

	async publish(_event: AgentV2RunEventRecord): Promise<void> {}

	async read(request: AgentV2RunEventReadRequest): Promise<AgentV2RunEventRecord[]> {
		this.readCalls.push(request);
		const step = this.steps.shift() ?? { waitForAbort: true };
		try {
			if ("events" in step) return step.events;
			if ("error" in step) throw step.error;
			if (request.signal?.aborted) return [];
			return await new Promise<AgentV2RunEventRecord[]>((resolve) => {
				request.signal?.addEventListener("abort", () => resolve([]), { once: true });
			});
		} finally {
			this.completedReads += 1;
		}
	}

	async purge(): Promise<{ streamsDeleted: number }> {
		return { streamsDeleted: 0 };
	}

	async close(): Promise<void> {}
}

class EmptyAgentV2RunEventBus implements AgentV2RunEventBus {
	async project(): Promise<"projected"> {
		return "projected";
	}
	readonly readCalls: AgentV2RunEventReadRequest[] = [];

	constructor(private readonly failAfterReads: number) {}

	async publish(_event: AgentV2RunEventRecord): Promise<void> {}

	async read(request: AgentV2RunEventReadRequest): Promise<AgentV2RunEventRecord[]> {
		this.readCalls.push(request);
		if (this.readCalls.length >= this.failAfterReads) {
			throw new Error("empty read busy loop");
		}
		return [];
	}

	async purge(): Promise<{ streamsDeleted: number }> {
		return { streamsDeleted: 0 };
	}

	async close(): Promise<void> {}
}

function createTestConfig(): StorageConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-web-workspace-v2-sse-"));
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
		workerId: "test-worker",
		workerConcurrency: 1,
		agentV2: {
			queueName: "pi:agent-v2:runs",
			eventStreamMaxLen: 5000,
			eventStreamTtlSeconds: 3600,
		},
		clientIdRequired: false,
		previewBaseUrl: "",
		previewInternalOrigin: "http://127.0.0.1:5173",
		containerBuild: {
			engine: "docker",
			image: "node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752",
			proxyImage: "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
			timeoutMs: 120000,
			cpus: 1,
			memoryMb: 512,
			pidsLimit: 128,
			maxLogChars: 12000,
			registryOrigins: ["https://registry.npmjs.org"],
		},
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

function runSnapshot(overrides: Partial<AgentV2RunSnapshot> = {}): AgentV2RunSnapshot {
	return {
		clientId: CLIENT_ID,
		runId: "run-a",
		status: "running",
		phase: "implementation",
		attempt: 1,
		input: { prompt: "Build an app", sessionId: "session-a", title: "App" },
		model: { id: "test-model" },
		createdAt: "2026-07-08T09:00:00.000Z",
		updatedAt: "2026-07-08T09:00:00.000Z",
		...overrides,
	};
}

function runEvent(seq: number, overrides: Partial<AgentV2RunEventRecord> = {}): AgentV2RunEventRecord {
	return {
		clientId: CLIENT_ID,
		runId: "run-a",
		seq,
		type: "agent_v2.phase_changed",
		payload: {
			type: "agent_v2.phase_changed",
			phase: "implementation",
			status: "running",
			at: `2026-07-08T09:00:0${seq}.000Z`,
		},
		createdAt: `2026-07-08T09:00:0${seq}.000Z`,
		...overrides,
	};
}

function sseDataEvents(body: string): AgentV2RunEventRecord[] {
	return body
		.split("\n\n")
		.filter((chunk) => chunk.startsWith("data: "))
		.map((chunk) => JSON.parse(chunk.slice("data: ".length)) as AgentV2RunEventRecord);
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
