import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Connect } from "vite";
import { expect, it, vi } from "vitest";
import { AgentV2Readiness, AgentV2ReadinessGate } from "../src/agent-v2-readiness.js";
import { PostgresRuntimeStore } from "../src/postgres-runtime-store.js";
import type { StorageConfig } from "../src/types.js";
import { createConfiguredStoragePluginForTest } from "../src/vite-plugin.js";
import { createPostgresTestSchema } from "./helpers/postgres-test-schema.js";

it("returns 503 after a real PostgreSQL connection becomes unavailable", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-readiness-postgres-"));
	const isolated = await createPostgresTestSchema();
	const store = new PostgresRuntimeStore({ queryable: isolated.pool });
	const gate = new AgentV2ReadinessGate(
		new AgentV2Readiness([{ name: "store", check: async (signal) => await store.ping(signal) }]),
		{ successTtlMs: 0 },
	);
	let middleware: Middleware | undefined;
	const plugin = createConfiguredStoragePluginForTest({
		config: testConfig(root),
		diagnostics: {
			ensureDirs: vi.fn(),
			writeEvents: vi.fn(),
			flushLangfuse: vi.fn(async () => undefined),
		} as never,
		sessions: { ensureDirs: vi.fn() } as never,
		files: {} as never,
		previews: { servePreviewRequest: vi.fn(() => false) } as never,
		tasks: {} as never,
		skills: {} as never,
		runtimeDb: store,
		diagnosticExports: {} as never,
		agentV2ReadinessGate: gate,
	});

	try {
		await (plugin.configureServer as (server: { middlewares: { use(handler: Middleware): void } }) => Promise<void>)({
			middlewares: {
				use(handler) {
					middleware = handler;
				},
			},
		});
		expect((await gate.check(new AbortController().signal, { force: true })).ready).toBe(true);

		await isolated.pool.end();
		const unavailable = await gate.check(new AbortController().signal, { force: true });
		expect(unavailable.ready).toBe(false);
		expect(JSON.stringify(unavailable)).not.toContain(process.env.PI_TEST_POSTGRES_URL ?? "__missing__");
		if (!middleware) throw new Error("readiness route was not registered");
		const response = await dispatch(middleware, "/api/pi-storage/status");
		expect(response.statusCode).toBe(503);
		expect(JSON.parse(response.body).readiness.ready).toBe(false);
	} finally {
		await isolated.admin.query(`DROP SCHEMA "${isolated.schema}" CASCADE`);
		await isolated.admin.end();
		await store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

type Middleware = (
	req: Connect.IncomingMessage,
	res: ServerResponse,
	next: Connect.NextFunction,
) => void | Promise<void>;

async function dispatch(middleware: Middleware, url: string): Promise<FakeResponse> {
	const response = new FakeResponse();
	await middleware(
		{ method: "GET", url, headers: {}, on() {}, off() {} } as never,
		response as never,
		() => undefined,
	);
	return response;
}

class FakeResponse {
	statusCode = 200;
	body = "";
	setHeader(): this {
		return this;
	}
	end(chunk?: unknown): this {
		if (chunk !== undefined) this.body += String(chunk);
		return this;
	}
}

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "settings.json"),
		clientsRootDir: join(root, "clients"),
		skillsDir: join(root, "skills"),
		logsDbFile: join(root, "logs.sqlite"),
		runtimeDbFile: join(root, "runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		agentV2: { queueName: "pi:test:readiness", eventStreamMaxLen: 100, eventStreamTtlSeconds: 60 },
		clientIdRequired: false,
		envFile: "",
		envFileExists: false,
	} as StorageConfig;
}
