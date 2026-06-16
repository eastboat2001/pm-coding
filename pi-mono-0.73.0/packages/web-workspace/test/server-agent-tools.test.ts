import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerDirectProjectTools } from "../src/server-agent-tools.js";
import type { StorageConfig } from "../src/types.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-server-tools-"));
}

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runsEnabled: false,
		workerId: "test-worker",
		workerConcurrency: 2,
		runQueueName: "pi:runs",
		runEventRetentionDays: 30,
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

describe("server-direct agent project tools", () => {
	it("rejects omitted project_file placeholders as create or rewrite content", () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");
		const placeholder = "[project_file content omitted: 44099 chars, 1550 lines from index.html]";

		expect(() =>
			projectFile!.prepareArguments?.({ command: "create", filename: "index.html", content: placeholder }),
		).toThrow(/Refusing to write an omitted project_file placeholder to index\.html/);
		expect(() =>
			projectFile!.prepareArguments?.({ command: "rewrite", filename: "index.html", content: placeholder }),
		).toThrow(/Refusing to write an omitted project_file placeholder to index\.html/);
	});

	it("rejects omitted project_file placeholders as update replacement content", () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		expect(() =>
			projectFile!.prepareArguments?.({
				command: "update",
				filename: "index.html",
				old_str: "<h1>old</h1>",
				new_str: "[project_file content omitted: 44099 chars, 1550 lines from index.html]",
			}),
		).toThrow(/Refusing to write an omitted project_file placeholder to index\.html/);
	});

	it("allows normal project_file create and update operations", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		const createArgs = projectFile!.prepareArguments?.({
			command: "create",
			filename: "index.html",
			content: "<h1>old</h1>",
		});
		const createResult = await projectFile!.execute("tc-create", createArgs!);
		const updateArgs = projectFile!.prepareArguments?.({
			command: "update",
			filename: "index.html",
			old_str: "old",
			new_str: "new",
		});
		const updateResult = await projectFile!.execute("tc-update", updateArgs!);
		const getResult = await projectFile!.execute("tc-get", { command: "get", filename: "index.html" });

		expect(createResult.details).toMatchObject({ filename: "index.html", action: "created" });
		expect(updateResult.details).toMatchObject({ filename: "index.html", action: "updated" });
		expect(getResult.content[0]).toEqual({ type: "text", text: "<h1>new</h1>" });
	});

	it("reads archived attachments when the model asks for the original attachment filename", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		await projectFile!.execute("tc-create", {
			command: "create",
			filename: "attachments/n.txt",
			content: "你好 mimo",
		});
		const getResult = await projectFile!.execute("tc-get", { command: "get", filename: "n.txt" });

		expect(getResult.content[0]).toEqual({ type: "text", text: "你好 mimo" });
		expect(getResult.details).toMatchObject({ command: "get", filename: "attachments/n.txt" });
	});

	it("reads legacy markdown attachment archives when the model asks for the original filename", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		await projectFile!.execute("tc-create", {
			command: "create",
			filename: "attachments/n.md",
			content: "你好 mimo",
		});
		const getResult = await projectFile!.execute("tc-get", { command: "get", filename: "n.txt" });

		expect(getResult.content[0]).toEqual({ type: "text", text: "你好 mimo" });
		expect(getResult.details).toMatchObject({ command: "get", filename: "attachments/n.md" });
	});

	it("creates project files without browser fetch", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const tools = createServerDirectProjectTools(config, {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
			activeSkillNames: [],
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		expect(projectFile).toBeDefined();
		const result = await projectFile!.execute("tc1", {
			command: "create",
			filename: "index.html",
			content: "<h1>ok</h1>",
		});

		expect(result.content[0]).toMatchObject({ type: "text", text: "created: index.html" });
		expect(result.details).toMatchObject({ filename: "index.html", action: "created" });
		expect(existsSync(join(String(result.details.projectRoot), "index.html"))).toBe(true);

		const listResult = await projectFile!.execute("tc2", { command: "list" });
		expect(listResult.content[0]).toMatchObject({ type: "text", text: "index.html" });
	});

	it("exposes preview through server-direct project tasks using the configured preview base URL", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");
		const projectTask = tools.find((tool) => tool.name === "project_task");

		expect(projectTask).toBeDefined();
		expect(JSON.stringify(projectTask!.parameters)).toContain('"preview"');

		await projectFile!.execute("tc1", {
			command: "create",
			filename: "index.html",
			content: "<h1>ok</h1>",
		});
		const result = await projectTask!.execute("tc2", { task: "preview" });

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("Preview URL: http://localhost:5173/preview/project-client-a-s1/"),
		});
		expect(result.details).toMatchObject({
			task: "preview",
			status: "running",
			previewUrl: "http://localhost:5173/preview/project-client-a-s1/",
		});
	});

	it("uses the local PI dev port for server-direct previews when no base URL is configured", async () => {
		const root = tempRoot();
		const config = { ...testConfig(root), previewBaseUrl: "" };
		const tools = createServerDirectProjectTools(config, {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");
		const projectTask = tools.find((tool) => tool.name === "project_task");

		await projectFile!.execute("tc1", {
			command: "create",
			filename: "index.html",
			content: "<h1>ok</h1>",
		});
		const result = await projectTask!.execute("tc2", { task: "preview" });

		expect(result.details).toMatchObject({
			task: "preview",
			status: "running",
			previewUrl: "http://localhost:5173/preview/project-client-a-s1/",
		});
	});
});
