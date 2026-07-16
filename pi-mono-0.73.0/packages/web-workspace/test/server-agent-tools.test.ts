import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerDirectProjectTools, createServerDirectSkillTools } from "../src/server-agent-tools.js";
import type { StorageConfig } from "../src/types.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-server-tools-"));
}

function testConfig(root: string): StorageConfig {
	return {
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "postgres",
		postgresUrl: "postgres://pi:pi@postgres:5432/pi_coding",
		workerId: "test-worker",
		workerConcurrency: 2,
		agentV2: {
			queueName: "pi:agent-v2:runs",
			eventStreamMaxLen: 5000,
			eventStreamTtlSeconds: 3600,
		},
		clientIdRequired: true,
		previewBaseUrl: "http://localhost:5173",
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
			projectFile!.prepareArguments?.({
				command: "create",
				filename: "index.html",
				content: placeholder,
			}),
		).toThrow(/Refusing to write an omitted project_file placeholder to index\.html/);
		expect(() =>
			projectFile!.prepareArguments?.({
				command: "rewrite",
				filename: "index.html",
				content: placeholder,
			}),
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

	it("rejects omitted project_file placeholders embedded inside generated file content", () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		expect(() =>
			projectFile!.prepareArguments?.({
				command: "rewrite",
				filename: "index.html",
				content: [
					"<!doctype html>",
					"<html>",
					"[project_file content omitted: 44099 chars, 1550 lines from index.html]",
					"</html>",
				].join("\n"),
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
		const getResult = await projectFile!.execute("tc-get", {
			command: "get",
			filename: "index.html",
		});

		expect(createResult.details).toMatchObject({
			filename: "index.html",
			action: "created",
		});
		expect(updateResult.details).toMatchObject({
			filename: "index.html",
			action: "updated",
		});
		expect(getResult.content[0]).toEqual({
			type: "text",
			text: "<h1>new</h1>",
		});
	});

	it("blocks implementation writes until required spec reads are completed", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(
			testConfig(root),
			{
				clientId: "client-a",
				sessionId: "s1",
				title: "Demo",
			},
			undefined,
			{
				specExecution: {
					requiredBeforeImplementation: true,
					requiredReads: ["docs/spec.md", "docs/plan.md", "docs/tasks.md"],
				},
			},
		);
		const projectFile = tools.find((tool) => tool.name === "project_file");

		await expect(
			projectFile!.execute("tc-rewrite", {
				command: "rewrite",
				filename: "index.html",
				content: "<h1>too early</h1>",
			}),
		).rejects.toThrow(
			/Read required files first with project_file get: docs\/spec\.md, docs\/plan\.md, docs\/tasks\.md/,
		);
	});

	it("allows implementation writes after every required spec read is completed", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(
			testConfig(root),
			{
				clientId: "client-a",
				sessionId: "s1",
				title: "Demo",
			},
			undefined,
			{
				specExecution: {
					requiredBeforeImplementation: true,
					requiredReads: ["docs/spec.md", "docs/plan.md", "docs/tasks.md"],
				},
			},
		);
		const projectFile = tools.find((tool) => tool.name === "project_file");

		await projectFile!.execute("tc-spec", {
			command: "create",
			filename: "docs/spec.md",
			content: "# Spec\n",
		});
		await projectFile!.execute("tc-plan", {
			command: "create",
			filename: "docs/plan.md",
			content: "# Plan\n",
		});
		await projectFile!.execute("tc-tasks", {
			command: "create",
			filename: "docs/tasks.md",
			content: "# Tasks\n",
		});
		await projectFile!.execute("tc-read-spec", {
			command: "get",
			filename: "docs/spec.md",
		});
		await projectFile!.execute("tc-read-plan", {
			command: "get",
			filename: "docs/plan.md",
		});
		await projectFile!.execute("tc-read-tasks", {
			command: "get",
			filename: "docs/tasks.md",
		});
		const result = await projectFile!.execute("tc-rewrite", {
			command: "rewrite",
			filename: "index.html",
			content: "<h1>ready</h1>",
		});

		expect(result.details).toMatchObject({
			filename: "index.html",
			action: "created",
		});
	});

	it("allows implementation writes when required spec reads were completed in prior history", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(
			testConfig(root),
			{
				clientId: "client-a",
				sessionId: "s1",
				title: "Demo",
			},
			undefined,
			{
				specExecution: {
					requiredBeforeImplementation: true,
					requiredReads: ["docs/spec.md", "docs/plan.md", "docs/tasks.md"],
					completedReads: ["docs/spec.md", "docs/plan.md", "docs/tasks.md"],
				},
			},
		);
		const projectFile = tools.find((tool) => tool.name === "project_file");

		const result = await projectFile!.execute("tc-rewrite", {
			command: "rewrite",
			filename: "index.html",
			content: "<h1>ready from history</h1>",
		});

		expect(result.details).toMatchObject({
			filename: "index.html",
			action: "created",
		});
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
		const getResult = await projectFile!.execute("tc-get", {
			command: "get",
			filename: "n.txt",
		});

		expect(getResult.content[0]).toEqual({ type: "text", text: "你好 mimo" });
		expect(getResult.details).toMatchObject({
			command: "get",
			filename: "attachments/n.txt",
		});
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
		const getResult = await projectFile!.execute("tc-get", {
			command: "get",
			filename: "n.txt",
		});

		expect(getResult.content[0]).toEqual({ type: "text", text: "你好 mimo" });
		expect(getResult.details).toMatchObject({
			command: "get",
			filename: "attachments/n.md",
		});
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

		expect(result.content[0]).toMatchObject({
			type: "text",
			text: "created: index.html",
		});
		expect(result.details).toMatchObject({
			filename: "index.html",
			action: "created",
		});
		expect(existsSync(join(String(result.details.projectRoot), "index.html"))).toBe(true);

		const listResult = await projectFile!.execute("tc2", { command: "list" });
		expect(listResult.content[0]).toMatchObject({
			type: "text",
			text: "index.html",
		});
	});

	it("caches repeated project_file reads until a project_file write invalidates the cache", async () => {
		const root = tempRoot();
		const tools = createServerDirectProjectTools(testConfig(root), {
			clientId: "client-a",
			sessionId: "s1",
			title: "Demo",
		});
		const projectFile = tools.find((tool) => tool.name === "project_file");

		const createResult = await projectFile!.execute("tc-create", {
			command: "create",
			filename: "index.html",
			content: "initial",
		});
		const firstGet = await projectFile!.execute("tc-get-1", {
			command: "get",
			filename: "index.html",
		});
		writeFileSync(join(String(createResult.details.projectRoot), "index.html"), "external");
		const cachedGet = await projectFile!.execute("tc-get-2", {
			command: "get",
			filename: "index.html",
		});
		await projectFile!.execute("tc-rewrite", {
			command: "rewrite",
			filename: "index.html",
			content: "rewritten",
		});
		const refreshedGet = await projectFile!.execute("tc-get-3", {
			command: "get",
			filename: "index.html",
		});

		expect(firstGet.content[0]).toEqual({ type: "text", text: "initial" });
		expect(cachedGet.content[0]).toEqual({ type: "text", text: "initial" });
		expect(refreshedGet.content[0]).toEqual({
			type: "text",
			text: "rewritten",
		});
	});

	it("caches repeated skill_load and skill_resource reads for the same tool instance", async () => {
		const root = tempRoot();
		const config = testConfig(root);
		const skillDir = join(config.skillsDir, "demo-skill");
		mkdirSync(join(skillDir, "references"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: demo-skill\ndescription: Demo skill\n---\nFirst skill body",
		);
		writeFileSync(join(skillDir, "references", "guide.md"), "First guide");
		const tools = createServerDirectSkillTools(config);
		const skillLoad = tools.find((tool) => tool.name === "skill_load");
		const skillResource = tools.find((tool) => tool.name === "skill_resource");

		const firstLoad = await skillLoad!.execute("tc-load-1", {
			name: "demo-skill",
		});
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: demo-skill\ndescription: Demo skill\n---\nChanged skill body",
		);
		const cachedLoad = await skillLoad!.execute("tc-load-2", {
			name: "demo-skill",
		});
		const firstResource = await skillResource!.execute("tc-resource-1", {
			name: "demo-skill",
			path: "references/guide.md",
		});
		writeFileSync(join(skillDir, "references", "guide.md"), "Changed guide");
		const cachedResource = await skillResource!.execute("tc-resource-2", {
			name: "demo-skill",
			path: "references/guide.md",
		});

		expect(firstLoad.content[0].text).toContain("First skill body");
		expect(cachedLoad.content[0].text).toContain("First skill body");
		expect(cachedLoad.content[0].text).not.toContain("Changed skill body");
		expect(firstResource.content[0]).toEqual({
			type: "text",
			text: "First guide",
		});
		expect(cachedResource.content[0]).toEqual({
			type: "text",
			text: "First guide",
		});
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
			previewUrl: "http://127.0.0.1:5173/preview/project-client-a-s1/",
		});
	});
});
