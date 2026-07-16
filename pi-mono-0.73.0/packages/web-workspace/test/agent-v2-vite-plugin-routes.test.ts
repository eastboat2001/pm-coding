import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentV2Readiness, AgentV2ReadinessGate } from "../src/agent-v2-readiness.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import type { AgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import type { AgentV2RunEventReadRequest, AgentV2RunTransportEvent } from "../src/agent-v2-run-events.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { JsonObject, StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const PREFIX = "/api/agent-v2/runs";
const LEGACY_RUN_API_PREFIXES = ["/api/runtime/runs", "/api/pi-runs", "/api/runs"] as const;
const LEGACY_SESSION_API_PREFIXES = ["/api/pi-sessions"] as const;
const cleanupRoots: string[] = [];
const cleanupStores: RuntimeDbStore[] = [];

afterEach(() => {
	for (const store of cleanupStores.splice(0)) store.close();
	for (const root of cleanupRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent v2 Vite runtime routes", () => {
	it("does not expose Langfuse endpoint paths through storage status", async () => {
		const config = createTestConfig();
		config.langfuseHost = "https://langfuse.internal/super-secret-host-path";
		config.langfuseOtelEndpoint = "https://otel.internal/super-secret-otel-path";
		const harness = await createHarness({ config });

		const response = await dispatch(harness.middleware, { method: "GET", url: "/api/pi-storage/status" });
		expect(response.statusCode).toBe(200);
		expect(response.body).not.toContain("super-secret");
		expect(JSON.parse(response.body)).toMatchObject({
			langfuseHost: "https://langfuse.internal",
			langfuseOtelEndpoint: "https://otel.internal",
		});
	});

	it("returns 503 for status and run mutations after dependency loss, then recovers", async () => {
		let now = 1_000;
		let dependencyReady = true;
		const api = new RecordingAgentV2RunApi();
		const gate = new AgentV2ReadinessGate(
			new AgentV2Readiness([
				{
					name: "store",
					async check() {
						if (!dependencyReady) throw new Error("postgres://user:secret@internal/db");
					},
				},
			]),
			{ now: () => now, successTtlMs: 1_000 },
		);
		const harness = await createHarness({ agentV2RunApi: api, agentV2ReadinessGate: gate });

		now = 2_001;
		dependencyReady = false;
		await gate.check(new AbortController().signal, { force: true });
		const statusUnavailable = await dispatch(harness.middleware, { method: "GET", url: "/api/pi-storage/status" });
		const startUnavailable = await dispatch(harness.middleware, {
			method: "POST",
			url: `${PREFIX}/start`,
			body: { input: { objective: "Build", sessionId: "session-a", title: "App" }, model: { id: "test" } },
		});
		expect(statusUnavailable.statusCode).toBe(503);
		expect(JSON.parse(statusUnavailable.body).readiness.ready).toBe(false);
		expect(startUnavailable.statusCode).toBe(503);
		expect(api.calls).toEqual([]);
		expect(startUnavailable.body).not.toContain("secret");

		dependencyReady = true;
		const statusRecovered = await dispatch(harness.middleware, { method: "GET", url: "/api/pi-storage/status" });
		expect(statusRecovered.statusCode).toBe(200);
		expect(JSON.parse(statusRecovered.body).readiness.ready).toBe(true);
	});

	it("starts a v2 run and returns the v2 snapshot", async () => {
		const api = new RecordingAgentV2RunApi();
		api.startRunResult = runSnapshot({
			runId: "run-started",
			input: { objective: "Build a dashboard", sessionId: "session-a", title: "Dashboard" },
		});
		const harness = await createHarness({ agentV2RunApi: api });

		const response = await dispatch(harness.middleware, {
			method: "POST",
			url: `${PREFIX}/start`,
			body: {
				input: { objective: "Build a dashboard", sessionId: "session-a", title: "Dashboard" },
				model: { id: "test-model" },
			},
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual(api.startRunResult);
		expect(api.calls).toContainEqual({
			method: "startRun",
			clientId: CLIENT_ID,
			request: {
				input: { objective: "Build a dashboard", sessionId: "session-a", title: "Dashboard" },
				model: { id: "test-model" },
			},
		});
	});

	it("returns 400 when v2 start input lacks executable session context", async () => {
		const harness = await createHarness({ agentV2RunApi: createRealAgentV2RunApiForRouteTest() });

		const response = await dispatch(harness.middleware, {
			method: "POST",
			url: `${PREFIX}/start`,
			body: { input: { objective: "Build a dashboard" }, model: { id: "test-model" } },
		});

		expect(response.statusCode).toBe(400);
		expect(JSON.parse(response.body).error).toContain("sessionId");
	});

	it("keeps HTTP start/cancel free of direct queue, cancel and event append seams", () => {
		const source = readFileSync(join(process.cwd(), "src", "agent-v2-run-api-service.ts"), "utf8");
		expect(source).not.toContain("agent-v2-run-queue");
		expect(source).not.toMatch(/\.enqueue\s*\(/u);
		expect(source).not.toMatch(/\.requestCancel\s*\(/u);
		expect(source).not.toMatch(/\.append\s*\(/u);
		expect(source).toContain("commitAgentV2RunStart");
		expect(source).toContain("commitAgentV2RunCancel");
	});

	it("types planning_ready as a public transport event without changing durable event names", () => {
		const event: AgentV2RunTransportEvent = {
			type: "agent_v2.planning_ready",
			phase: "implementation",
			at: "2026-07-14T01:00:00.000Z",
		};
		expect(event).toEqual({
			type: "agent_v2.planning_ready",
			phase: "implementation",
			at: "2026-07-14T01:00:00.000Z",
		});
	});

	it("lists, gets, and cancels runs through the v2 service", async () => {
		const api = new RecordingAgentV2RunApi();
		api.listRunsResult = [runSnapshot({ runId: "run-a" })];
		api.getRunResult = runSnapshot({ runId: "run-a", status: "running", phase: "implementation" });
		api.cancelRunResult = runSnapshot({ runId: "run-a", status: "cancelled", phase: "cancelled" });
		const harness = await createHarness({ agentV2RunApi: api });

		const listResponse = await dispatch(harness.middleware, { method: "GET", url: PREFIX });
		const getResponse = await dispatch(harness.middleware, { method: "GET", url: `${PREFIX}/run-a` });
		const cancelResponse = await dispatch(harness.middleware, { method: "POST", url: `${PREFIX}/run-a/cancel` });

		expect(JSON.parse(listResponse.body)).toEqual({ runs: api.listRunsResult });
		expect(JSON.parse(getResponse.body)).toEqual(api.getRunResult);
		expect(JSON.parse(cancelResponse.body)).toEqual(api.cancelRunResult);
		expect(api.calls.map((call) => call.method)).toEqual(["listRuns", "getRun", "cancelRun"]);
	});

	it("replays durable v2 events as JSON", async () => {
		const api = new RecordingAgentV2RunApi();
		api.listRunEventsResult = [runEvent(2), runEvent(3)];
		const harness = await createHarness({ agentV2RunApi: api });

		const response = await dispatch(harness.middleware, {
			method: "GET",
			url: `${PREFIX}/run-a/events?afterSeq=1`,
		});

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({ events: [runEvent(2), runEvent(3)] });
		expect(api.calls).toContainEqual({ method: "listRunEvents", clientId: CLIENT_ID, runId: "run-a", afterSeq: 1 });
	});

	it("returns 404 for JSON v2 event replay when the run is missing", async () => {
		const api = new RecordingAgentV2RunApi();
		api.getRunResult = undefined;
		api.listRunEventsResult = [runEvent(2)];
		const harness = await createHarness({ agentV2RunApi: api });

		const response = await dispatch(harness.middleware, {
			method: "GET",
			url: `${PREFIX}/missing-run/events?afterSeq=1`,
		});

		expect(response.statusCode).toBe(404);
		expect(JSON.parse(response.body)).toEqual({ error: "Agent v2 run not found." });
		expect(api.calls.map((call) => call.method)).toEqual(["getRun"]);
	});

	it("streams durable and live v2 events as SSE", async () => {
		const api = new RecordingAgentV2RunApi();
		api.getRunResult = runSnapshot({ runId: "run-a" });
		const eventLog = new RecordingAgentV2RunEventLog([runEvent(2)]);
		const eventBus = new ScriptedAgentV2RunEventBus([{ events: [runEvent(3)] }, { waitForAbort: true }]);
		const harness = await createHarness({
			agentV2RunApi: api,
			agentV2RunEventLog: eventLog,
			agentV2RunEventBus: eventBus,
		});

		const request = dispatchStreaming(harness.middleware, {
			method: "GET",
			url: `${PREFIX}/run-a/events?afterSeq=1`,
			headers: { accept: "text/event-stream", "x-pi-client-id": CLIENT_ID },
		});

		await waitUntil(() => sseDataEvents(request.response.body).length === 2);

		expect(sseDataEvents(request.response.body)).toEqual([runEvent(2), runEvent(3)]);
		expect(sseEventIds(request.response.body)).toEqual([2, 3]);
		expect(request.response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
		expect(eventLog.listCalls).toEqual([{ clientId: CLIENT_ID, runId: "run-a", afterSeq: 1 }]);
		expect(eventBus.readCalls[0]).toMatchObject({ clientId: CLIENT_ID, runId: "run-a", afterSeq: 2, blockMs: 1000 });

		request.close();
		await request.done;
	});

	it("keeps retired generation routes as data-free tombstones", async () => {
		const harness = await createHarness();
		const response = await dispatch(harness.middleware, { method: "GET", url: "/api/runtime/runs/old-run/events" });

		expect(response.statusCode).toBe(410);
		expect(JSON.parse(response.body)).toEqual({
			error: "Application Generation Agent v1 runtime routes have been removed.",
		});
	});

	it("returns fixed 410 responses for legacy run routes", async () => {
		const harness = await createHarness();
		const cases = LEGACY_RUN_API_PREFIXES.flatMap((prefix) => [
			{ label: `${prefix} list`, method: "GET", url: prefix },
			{ label: `${prefix} get`, method: "GET", url: `${prefix}/legacy-run` },
			{ label: `${prefix} status`, method: "GET", url: `${prefix}/legacy-run/status` },
			{ label: `${prefix} events JSON`, method: "GET", url: `${prefix}/legacy-run/events?afterSeq=1` },
			{
				label: `${prefix} events SSE`,
				method: "GET",
				url: `${prefix}/legacy-run/events?afterSeq=1`,
				headers: { accept: "text/event-stream" },
			},
			{ label: `${prefix} cancel`, method: "POST", url: `${prefix}/legacy-run/cancel` },
		]);

		for (const route of cases) {
			const response = await dispatch(harness.middleware, route);
			expect(response.statusCode, route.label).toBe(410);
			expect(JSON.parse(response.body), route.label).toEqual({
				error: "Application Generation Agent v1 runtime routes have been removed.",
			});
			expect(response.headers.get("Content-Type"), route.label).toBe("application/json; charset=utf-8");
		}
	});

	it("returns fixed legacy removal responses", async () => {
		const harness = await createHarness();

		const runResponse = await dispatch(harness.middleware, {
			method: "POST",
			url: "/api/runtime/runs/start",
			body: { message: { role: "user", content: "legacy start" } },
		});
		const goalResponse = await dispatch(harness.middleware, {
			method: "GET",
			url: "/api/runtime/runs/goals/app-preview?sessionId=session-a",
		});

		expect(runResponse.statusCode).toBe(410);
		expect(JSON.parse(runResponse.body)).toEqual({
			error: "Application Generation Agent v1 runtime routes have been removed.",
		});
		expect(goalResponse.statusCode).toBe(404);
		expect(JSON.parse(goalResponse.body)).toEqual({ error: "Legacy app-preview-goal routes have been removed." });
		expect(() => harness.closeServer()).not.toThrow();
	});

	it("returns fixed 410 responses for legacy session routes", async () => {
		const harness = await createHarness();
		const sessionCases = LEGACY_SESSION_API_PREFIXES.flatMap((prefix) => [
			{ label: `${prefix} get`, method: "GET", url: `${prefix}/session-a` },
			{ label: `${prefix} list`, method: "GET", url: `${prefix}` },
			{
				label: `${prefix} events SSE`,
				method: "GET",
				url: `${prefix}/session-a/events`,
				headers: { accept: "text/event-stream" },
			},
		]);

		for (const route of sessionCases) {
			const response = await dispatch(harness.middleware, route);
			expect(response.statusCode, route.label).toBe(410);
			expect(JSON.parse(response.body), route.label).toEqual({
				error: "Application Generation Agent v1 runtime session routes have been removed.",
			});
			expect(response.headers.get("Content-Type"), route.label).toBe("application/json; charset=utf-8");
		}
	});

	it("does not expose legacy app-preview-goal routes", async () => {
		const harness = await createHarness();

		const getResponse = await dispatch(harness.middleware, {
			method: "GET",
			url: "/api/runtime/runs/goals/app-preview?sessionId=session-a",
		});
		const postResponse = await dispatch(harness.middleware, {
			method: "POST",
			url: "/api/runtime/runs/goals/app-preview",
			body: { sessionId: "session-a", source: "manual" },
		});

		expect(getResponse.statusCode).toBe(404);
		expect(postResponse.statusCode).toBe(404);
		expect(JSON.parse(getResponse.body)).toEqual({ error: "Legacy app-preview-goal routes have been removed." });
		expect(JSON.parse(postResponse.body)).toEqual({ error: "Legacy app-preview-goal routes have been removed." });
	});

	it("selects diagnostic export clients only from the normalized client header", async () => {
		const exportJson = vi.fn(async (request: { clientId: string }) => ({
			version: 1 as const,
			exportedAt: "2026-07-15T00:00:00.000Z",
			query: { clientId: request.clientId },
			runtime: {},
			diagnostics: {},
		}));
		const diagnosticExports = {
			export: exportJson,
			exportArchive: vi.fn(),
		} as unknown as TestServices["diagnosticExports"];
		const harness = await createHarness({ diagnosticExports });

		await dispatch(harness.middleware, {
			method: "GET",
			url: "/api/pi-logs/export?sessionId=session-a&clientId=22222222-2222-4222-8222-222222222222&format=json",
			includeClientHeader: false,
		});
		await dispatch(harness.middleware, {
			method: "GET",
			url: "/api/pi-logs/export?sessionId=session-a&clientId=22222222-2222-4222-8222-222222222222&format=json",
			headers: { "x-pi-client-id": CLIENT_ID.toUpperCase() },
		});

		expect(exportJson).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientId: "" }));
		expect(exportJson).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientId: CLIENT_ID }));

		const strictConfig = createTestConfig();
		strictConfig.clientIdRequired = true;
		const strictExport = vi.fn();
		const strictHarness = await createHarness({
			config: strictConfig,
			diagnosticExports: {
				export: strictExport,
				exportArchive: vi.fn(),
			} as unknown as TestServices["diagnosticExports"],
		});
		const strictQueryOnly = await dispatch(strictHarness.middleware, {
			method: "GET",
			url: "/api/pi-logs/export?sessionId=session-a&clientId=22222222-2222-4222-8222-222222222222&format=json",
			includeClientHeader: false,
		});

		expect(strictQueryOnly.statusCode).toBe(401);
		expect(strictExport).not.toHaveBeenCalled();
	});
});

type ConfiguredTestServices = Parameters<typeof createConfiguredStoragePluginForTest>[0];
type TestServices = Omit<ConfiguredTestServices, "agentV2RunApi" | "agentV2RunEventBus" | "agentV2RunEventLog"> & {
	agentV2RunApi?: ConfiguredTestServices["agentV2RunApi"] | RecordingAgentV2RunApi;
	agentV2RunEventBus?: AgentV2RunEventBus;
	agentV2RunEventLog?: RecordingAgentV2RunEventLog;
	agentV2ReadinessGate?: AgentV2ReadinessGate;
};
type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

async function createHarness(
	overrides: {
		config?: StorageConfig;
		diagnosticExports?: ConfiguredTestServices["diagnosticExports"];
		agentV2RunApi?: ConfiguredTestServices["agentV2RunApi"] | RecordingAgentV2RunApi;
		agentV2RunEventBus?: AgentV2RunEventBus;
		agentV2RunEventLog?: RecordingAgentV2RunEventLog;
		agentV2ReadinessGate?: AgentV2ReadinessGate;
	} = {},
) {
	let middleware: Middleware | undefined;
	const closeListeners: Array<() => void> = [];
	const services: TestServices = {
		config: overrides.config ?? createTestConfig(),
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
			flushLangfuse: vi.fn(async () => undefined),
		} as unknown as TestServices["diagnostics"],
		sessions: { ensureDirs: vi.fn() } as unknown as TestServices["sessions"],
		files: {} as TestServices["files"],
		previews: { servePreviewRequest: vi.fn(() => false) } as unknown as TestServices["previews"],
		tasks: {} as TestServices["tasks"],
		skills: {} as TestServices["skills"],
		runtimeDb: {
			ensureAgentV2Schema: vi.fn(),
			ping: vi.fn(async () => undefined),
		} as unknown as TestServices["runtimeDb"],
		diagnosticExports: overrides.diagnosticExports ?? ({} as TestServices["diagnosticExports"]),
		agentV2RunApi: overrides.agentV2RunApi ?? new RecordingAgentV2RunApi(),
		agentV2RunEventBus: overrides.agentV2RunEventBus ?? new ScriptedAgentV2RunEventBus([{ waitForAbort: true }]),
		agentV2RunEventLog: overrides.agentV2RunEventLog ?? new RecordingAgentV2RunEventLog([]),
		agentV2ReadinessGate: overrides.agentV2ReadinessGate,
	};
	const plugin = createConfiguredStoragePluginForTest(services as unknown as ConfiguredTestServices);
	const configureServer = plugin.configureServer as (server: {
		httpServer: { once(event: "close", listener: () => void): void };
		middlewares: { use(handler: Middleware): void };
	}) => Promise<void>;
	await configureServer({
		httpServer: {
			once(event, listener) {
				if (event === "close") closeListeners.push(listener);
			},
		},
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});
	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return {
		middleware,
		closeServer() {
			for (const listener of closeListeners) listener();
		},
	};
}

function dispatch(middleware: Middleware, options: DispatchOptions): Promise<FakeResponse> {
	const request = dispatchStreaming(middleware, options);
	return request.done.then(() => request.response);
}

function dispatchStreaming(middleware: Middleware, options: DispatchOptions) {
	const request = new FakeRequest(options);
	const response = new FakeResponse();
	let nextCalled = false;
	const done = Promise.resolve(
		middleware(request as unknown as Connect.IncomingMessage, response as unknown as ServerResponse, () => {
			nextCalled = true;
		}),
	);
	setTimeout(() => request.finishBody(), 0);
	return { close: () => request.emit("close"), done, nextCalled: () => nextCalled, request, response };
}

interface DispatchOptions {
	method: string;
	url: string;
	body?: JsonObject;
	headers?: Record<string, string>;
	includeClientHeader?: boolean;
}

class FakeRequest extends EventEmitter {
	readonly headers: Record<string, string>;
	readonly method: string;
	readonly url: string;
	private readonly body: JsonObject | undefined;

	constructor(options: DispatchOptions) {
		super();
		this.method = options.method;
		this.url = options.url;
		this.headers = {
			...(options.includeClientHeader === false ? {} : { "x-pi-client-id": CLIENT_ID }),
			...(options.headers ?? {}),
		};
		this.body = options.body;
	}

	setEncoding(_encoding: BufferEncoding): this {
		return this;
	}

	finishBody(): void {
		const body = this.body === undefined ? "" : JSON.stringify(this.body);
		if (body.length > 0) this.emit("data", body);
		this.emit("end");
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
		if (chunk !== undefined) this.write(chunk);
		this.ended = true;
		return this;
	}
}

class RecordingAgentV2RunApi {
	calls: JsonObject[] = [];
	startRunResult = runSnapshot({ runId: "run-started" });
	listRunsResult: AgentV2RunSnapshot[] = [];
	getRunResult: AgentV2RunSnapshot | undefined = runSnapshot({ runId: "run-a" });
	cancelRunResult = runSnapshot({ runId: "run-a", status: "cancelled", phase: "cancelled" });
	listRunEventsResult: AgentV2RunEventRecord[] = [];

	async startRun(clientId: string, request: JsonObject): Promise<AgentV2RunSnapshot> {
		this.calls.push({ method: "startRun", clientId, request });
		return this.startRunResult;
	}

	async listRuns(clientId: string): Promise<AgentV2RunSnapshot[]> {
		this.calls.push({ method: "listRuns", clientId });
		return this.listRunsResult;
	}

	async getRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		this.calls.push({ method: "getRun", clientId, runId });
		return this.getRunResult;
	}

	async cancelRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot> {
		this.calls.push({ method: "cancelRun", clientId, runId });
		return this.cancelRunResult;
	}

	async listRunEvents(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		this.calls.push({ method: "listRunEvents", clientId, runId, afterSeq });
		return this.listRunEventsResult;
	}
}

class RecordingAgentV2RunEventLog {
	readonly listCalls: Array<{ clientId: string; runId: string; afterSeq: number }> = [];

	constructor(private readonly events: AgentV2RunEventRecord[]) {}

	async list(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		this.listCalls.push({ clientId, runId, afterSeq });
		return this.events.filter((event) => event.seq > afterSeq);
	}
}

type BusReadStep = { events: AgentV2RunEventRecord[] } | { waitForAbort: true };

class ScriptedAgentV2RunEventBus implements AgentV2RunEventBus {
	async ping(_signal: AbortSignal): Promise<void> {}

	async project(): Promise<"projected"> {
		return "projected";
	}
	readonly readCalls: AgentV2RunEventReadRequest[] = [];

	constructor(private readonly steps: BusReadStep[]) {}

	async publish(_event: AgentV2RunEventRecord): Promise<void> {}

	async read(request: AgentV2RunEventReadRequest): Promise<AgentV2RunEventRecord[]> {
		this.readCalls.push(request);
		const step = this.steps.shift() ?? { waitForAbort: true };
		if ("events" in step) return step.events;
		if (request.signal?.aborted) return [];
		return await new Promise<AgentV2RunEventRecord[]>((resolve) => {
			request.signal?.addEventListener("abort", () => resolve([]), { once: true });
		});
	}

	async purge(): Promise<{ streamsDeleted: number }> {
		return { streamsDeleted: 0 };
	}

	async close(): Promise<void> {}
}

function runSnapshot(overrides: Partial<AgentV2RunSnapshot>): AgentV2RunSnapshot {
	return {
		clientId: CLIENT_ID,
		runId: "run-a",
		status: "queued",
		phase: "intake",
		attempt: 1,
		input: { objective: "Build an app", sessionId: "session-a", title: "App" },
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

function createRealAgentV2RunApiForRouteTest(): AgentV2RunApiService {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-route-service-"));
	const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
	store.ensureAgentV2Schema();
	cleanupRoots.push(root);
	cleanupStores.push(store);
	return new AgentV2RunApiService({
		store,
		queueName: "agent-v2-route-test",
		events: {
			list: vi.fn(async (clientId, runId, afterSeq) => store.listAgentV2RunEvents(clientId, runId, afterSeq)),
		},
		createRunId: () => "run-started",
		now: () => "2026-07-08T09:00:00.000Z",
	});
}

function sseDataEvents(body: string): AgentV2RunEventRecord[] {
	return body
		.split("\n\n")
		.flatMap((chunk) => chunk.split("\n").filter((line) => line.startsWith("data: ")))
		.map((line) => JSON.parse(line.slice("data: ".length)) as AgentV2RunEventRecord);
}

function sseEventIds(body: string): number[] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("id: "))
		.map((line) => Number(line.slice("id: ".length)));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for predicate: ${predicate()}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function createTestConfig(): StorageConfig {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-vite-routes-"));
	cleanupRoots.push(root);
	return {
		settingsFile: join(root, "settings.json"),
		clientsRootDir: join(root, "clients"),
		skillsDir: join(root, "skills"),
		runtimeDbFile: join(root, "runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "sqlite",
		postgresUrl: "postgres://user:pass@example.com:5432/pi",
		workerId: "test-worker",
		workerConcurrency: 1,
		agentV2: {
			queueName: "agent-v2-runs",
			eventStreamMaxLen: 200,
			eventStreamTtlSeconds: 120,
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
