import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentV2FileAdapter } from "../src/agent-v2-file-adapter.js";
import type { StorageConfig } from "../src/types.js";

const cleanupRoots: string[] = [];

describe("agent v2 file adapter", () => {
	afterEach(() => {
		for (const root of cleanupRoots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("writes files through a v2 contract and returns artifact candidates", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});

		const result = adapter.writeFile({
			path: "index.html",
			content: "<!doctype html><main>Ready</main>",
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		expect(result.artifact).toMatchObject({
			artifactId: "file:index.html",
			path: "index.html",
			mediaType: "text/html",
			sourceTaskId: "implement",
			validationStatus: "not_started",
		});
		expect(result.action).toBe("created");
		expect(adapter.listFiles().files).toEqual(["index.html"]);
	});

	it("maps path escape failures to structured tool failures", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});

		expect(() =>
			adapter.writeFile({
				path: "../outside.txt",
				content: "bad",
				mode: "create",
				taskId: "implement",
				now: "2026-07-08T00:01:00.000Z",
			}),
		).toThrow("file.path_invalid");
	});

	it("computes patch artifact checksum from the persisted file content", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});
		const path = "src/large-file.ts";
		const original = `${"a".repeat(540_000)}const value = "old";\n`;

		adapter.writeFile({
			path,
			content: original,
			mode: "create",
			taskId: "seed",
			now: "2026-07-08T00:01:00.000Z",
		});

		const result = adapter.patchFile({
			path,
			oldText: 'const value = "old";',
			newText: 'const value = "new";',
			taskId: "patch",
			now: "2026-07-08T00:02:00.000Z",
		});

		const persisted = readFileSync(projectFile(root, path), "utf8");
		expect(persisted.endsWith('const value = "new";\n')).toBe(true);
		expect(result.artifact.checksum).toBe(sha256(persisted));
	});

	it("normalizes nested public paths to forward slashes", () => {
		const root = tempRoot();
		const adapter = createAgentV2FileAdapter({
			config: testConfig(root),
			context: { clientId: "client-a", sessionId: "session-a", title: "Demo" },
		});

		const write = adapter.writeFile({
			path: "src\\nested\\foo.ts",
			content: 'export const value = "a";\n',
			mode: "create",
			taskId: "implement",
			now: "2026-07-08T00:01:00.000Z",
		});

		expect(write.path).toBe("src/nested/foo.ts");
		expect(write.artifact.path).toBe("src/nested/foo.ts");
		expect(write.artifact.artifactId).toBe("file:src/nested/foo.ts");
		expect(adapter.listFiles().files).toEqual(["src/nested/foo.ts"]);
		expect(adapter.readFile("src\\nested\\foo.ts").path).toBe("src/nested/foo.ts");

		const patch = adapter.patchFile({
			path: "src\\nested\\foo.ts",
			oldText: '"a"',
			newText: '"b"',
			taskId: "patch",
			now: "2026-07-08T00:02:00.000Z",
		});

		expect(patch.path).toBe("src/nested/foo.ts");
		expect(patch.artifact.path).toBe("src/nested/foo.ts");
		expect(patch.artifact.artifactId).toBe("file:src/nested/foo.ts");
		expect(adapter.readFile("src/nested/foo.ts").content).toContain('"b"');
	});
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-file-adapter-"));
	cleanupRoots.push(root);
	return root;
}

function projectFile(root: string, path: string): string {
	return join(root, "data", "clients", "client-a", "sessions", "session-a", "project", ...path.split("/"));
}

function sha256(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "postgres",
		postgresUrl: "postgres://pi:pi@postgres:5432/pi_coding",
		runsEnabled: false,
		workerId: "test-worker",
		workerConcurrency: 2,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "pi:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 5000,
		runEventStreamTtlSeconds: 3600,
		runEventCheckpointIntervalMs: 400,
		runEventCheckpointMinChars: 256,
		clientIdRequired: true,
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "data", "logs", "pi-diagnostics.sqlite"),
		loggingEnabled: true,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 12000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 20000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 20000,
		modelStreamIdleTimeoutMs: 60000,
		modelMaxOutputTokens: 12000,
		contextProviderPayloadBudgetChars: 90000,
		logRetentionDays: 30,
		logMaxEvents: 50000,
		logCleanupIntervalMs: 3600000,
		logVacuumIntervalMs: 86400000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 5000,
		langfuseBatchSize: 50,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
	};
}
