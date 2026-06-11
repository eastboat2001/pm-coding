import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import { createStartupDiagnosticEvents } from "../src/vite-plugin.js";

describe("storage config diagnostics", () => {
	it("records when the default .env file is missing and includes run dependencies in startup diagnostics", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-config-diagnostics-"));
		const config = loadStorageConfig(root);

		expect(config.envFile).toBe(resolve(root, ".env"));
		expect(config.envFileExists).toBe(false);
		expect(config.runsEnabled).toBe(true);
		expect(config.logStdoutEnabled).toBe(true);

		const events = createStartupDiagnosticEvents(config);

		expect(events).toEqual([
			expect.objectContaining({
				level: "info",
				category: "system",
				eventType: "system.startup.config",
				data: expect.objectContaining({
					envFile: resolve(root, ".env"),
					envFileExists: false,
					runsEnabled: true,
					redisUrl: "redis://127.0.0.1:6379",
					runQueueName: "pi:runs",
				}),
			}),
			expect.objectContaining({
				level: "warn",
				category: "system",
				eventType: "system.config.env_missing",
				data: expect.objectContaining({
					envFile: resolve(root, ".env"),
					message: "PI configuration file was not found; defaults are in use.",
				}),
			}),
		]);
	});

	it("uses a stable default worker id and allows env override", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-config-worker-id-"));
		const previousWorkerId = process.env.PI_WORKER_ID;
		try {
			delete process.env.PI_WORKER_ID;
			expect(loadStorageConfig(root).workerId).toBe("pi-worker");

			process.env.PI_WORKER_ID = "worker-custom";
			expect(loadStorageConfig(root).workerId).toBe("worker-custom");
		} finally {
			if (previousWorkerId === undefined) {
				delete process.env.PI_WORKER_ID;
			} else {
				process.env.PI_WORKER_ID = previousWorkerId;
			}
		}
	});
});
