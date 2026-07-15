import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { describe, expect, it, vi } from "vitest";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import { RedisAgentV2RunEventBus } from "../src/agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "../src/agent-v2-run-event-log.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";

const redisUrl = process.env.PI_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;
const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describeRedis("agent v2 durable SSE healing with real Redis", () => {
	it("delivers a durable-only terminal event to an already-connected client within three seconds", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-durable-live-"));
		const runId = `run-${randomUUID()}`;
		const store = new RuntimeDbStore(join(root, "runtime.sqlite"));
		store.ensureAgentV2Schema();
		store.createAgentV2Run({ clientId: CLIENT_ID, runId, input: { prompt: "build" }, model: { id: "test" } });
		store.appendAgentV2RunEvent({
			clientId: CLIENT_ID,
			runId,
			type: "agent_v2.run_started",
			payload: { type: "agent_v2.run_started", status: "running" },
		});
		const bus = new RedisAgentV2RunEventBus({ redisUrl: redisUrl!, ttlSeconds: 60 });
		const eventLog = new AgentV2RunEventLog({ store });
		const api = new AgentV2RunApiService({ store, events: eventLog, queueName: `pi:test:sse:${randomUUID()}` });
		const middleware = await createMiddleware({ root, store, bus, eventLog, api });
		const request = dispatch(middleware, `/api/agent-v2/runs/${runId}/events?stream=1&afterSeq=0`);

		try {
			await waitUntil(() => sseSequences(request.response.body).includes(1), 2_000);
			const appendedAt = Date.now();
			store.appendAgentV2RunEvent({
				clientId: CLIENT_ID,
				runId,
				type: "agent_v2.run_completed",
				payload: { type: "agent_v2.run_completed", status: "completed" },
			});

			await waitUntil(() => sseSequences(request.response.body).includes(2), 3_000);
			expect(Date.now() - appendedAt).toBeLessThan(3_000);
			expect(sseSequences(request.response.body)).toEqual([1, 2]);
			expect(sseIds(request.response.body)).toEqual([1, 2]);
			await expect(bus.read({ clientId: CLIENT_ID, runId, afterSeq: 0, blockMs: 1 })).resolves.toEqual([]);
		} finally {
			request.close();
			await request.done;
			await bus.purge({ clientId: CLIENT_ID, runId });
			await bus.close();
			store.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

async function createMiddleware(options: {
	root: string;
	store: RuntimeDbStore;
	bus: RedisAgentV2RunEventBus;
	eventLog: AgentV2RunEventLog;
	api: AgentV2RunApiService;
}): Promise<Middleware> {
	let middleware: Middleware | undefined;
	const plugin = createConfiguredStoragePluginForTest({
		config: {
			settingsFile: join(options.root, "settings.json"),
			clientsRootDir: join(options.root, "clients"),
			skillsDir: join(options.root, "skills"),
			defaultSkillsDir: join(options.root, "default-skills"),
			runtimeDbFile: join(options.root, "runtime.sqlite"),
			logsDbFile: join(options.root, "logs.sqlite"),
			redisUrl: redisUrl!,
			agentV2: { queueName: "pi:test:sse", eventStreamMaxLen: 100, eventStreamTtlSeconds: 60 },
			envFile: "",
			envFileExists: false,
		} as StorageConfig,
		diagnostics: {
			ensureDirs: vi.fn(),
			status: vi.fn(() => ({})),
			writeEvents: vi.fn(),
		} as never,
		sessions: { ensureDirs: vi.fn(), readSettings: vi.fn(), writeSettings: vi.fn() } as never,
		files: {} as never,
		previews: { servePreviewRequest: vi.fn(() => false) } as never,
		tasks: {} as never,
		skills: {} as never,
		runtimeDb: options.store,
		diagnosticExports: {} as never,
		agentV2RunApi: options.api,
		agentV2RunEventBus: options.bus,
		agentV2RunEventLog: options.eventLog,
	});
	await (plugin.configureServer as (server: { middlewares: { use(handler: Middleware): void } }) => Promise<void>)({
		middlewares: {
			use(handler) {
				middleware = handler;
			},
		},
	});
	if (!middleware) throw new Error("configured storage plugin did not register middleware");
	return middleware;
}

function dispatch(middleware: Middleware, url: string) {
	const request = new FakeRequest(url);
	const response = new FakeResponse();
	const done = Promise.resolve(
		middleware(request as unknown as Connect.IncomingMessage, response as unknown as ServerResponse, () => undefined),
	);
	return { request, response, done, close: () => request.emit("close") };
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
	body = "";
	setHeader(): this {
		return this;
	}
	flushHeaders(): void {}
	write(chunk: unknown): boolean {
		this.body += String(chunk);
		return true;
	}
	end(chunk?: unknown): this {
		if (chunk !== undefined) this.write(chunk);
		return this;
	}
}

function sseSequences(body: string): number[] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("data: "))
		.map((line) => JSON.parse(line.slice(6)) as { seq?: number })
		.flatMap((event) => (event.seq === undefined ? [] : [event.seq]));
}

function sseIds(body: string): number[] {
	return body
		.split("\n")
		.filter((line) => line.startsWith("id: "))
		.map((line) => Number(line.slice(4)));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
