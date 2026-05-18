import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	loadStorageConfig,
	WorkspaceFileService,
	WorkspacePreviewService,
	WorkspaceSessionService,
} from "../dist/index.js";

function tempRoot() {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-"));
}

function testConfig(root, overrides = {}) {
	return {
		sessionsDir: join(root, "data", "sessions"),
		settingsFile: join(root, "data", "settings.json"),
		projectsRootDir: join(root, "data", "projects"),
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		serverSessionSyncEnabled: false,
		defaultModelProvider: "anthropic",
		defaultModelId: "claude-sonnet-4-5-20250929",
		...overrides,
	};
}

async function test(name, fn) {
	await fn();
	console.log(`ok - ${name}`);
}

await test("loadStorageConfig resolves relative paths from the app root and strips preview trailing slash", () => {
	const root = tempRoot();
	writeFileSync(
		join(root, "pi-storage.config.json"),
		JSON.stringify({
			sessionsDir: "runtime/sessions",
			settingsFile: "runtime/settings.json",
			projectsRootDir: "runtime/projects",
			previewBaseUrl: "http://localhost:5173/",
			serverSessionSyncEnabled: true,
			defaultModelProvider: "openai",
			defaultModelId: "gpt-5.1",
		}),
		"utf8",
	);

	const config = loadStorageConfig(root);

	assert.equal(config.sessionsDir, resolve(root, "runtime/sessions"));
	assert.equal(config.settingsFile, resolve(root, "runtime/settings.json"));
	assert.equal(config.projectsRootDir, resolve(root, "runtime/projects"));
	assert.equal(config.previewBaseUrl, "http://localhost:5173");
	assert.equal(config.serverSessionSyncEnabled, true);
	assert.equal(config.defaultModelProvider, "openai");
	assert.equal(config.defaultModelId, "gpt-5.1");
});

await test("loadStorageConfig supports legacy storageDir defaults", () => {
	const root = tempRoot();
	writeFileSync(join(root, "pi-storage.config.json"), JSON.stringify({ storageDir: "runtime" }), "utf8");

	const config = loadStorageConfig(root);

	assert.equal(config.sessionsDir, resolve(root, "runtime/sessions"));
	assert.equal(config.settingsFile, resolve(root, "runtime/settings.json"));
	assert.equal(config.projectsRootDir, resolve(root, "data/projects"));
	assert.equal(config.serverSessionSyncEnabled, false);
	assert.equal(config.defaultModelProvider, "anthropic");
	assert.equal(config.defaultModelId, "claude-sonnet-4-5-20250929");
});

await test("WorkspaceSessionService merges and deletes server-backed provider keys in settings", () => {
	const root = tempRoot();
	const service = new WorkspaceSessionService(testConfig(root));

	service.writeSettings({ providerKeys: { anthropic: "sk-ant-test" } });
	service.writeSettings({ providerKeys: { openai: "sk-openai-test" } });
	service.writeSettings({ providerKeys: { anthropic: null } });

	const settings = service.readSettings();
	assert.deepEqual(settings.providerKeys, { openai: "sk-openai-test" });
});

await test("WorkspaceSessionService stores server-backed custom providers in settings", () => {
	const root = tempRoot();
	const service = new WorkspaceSessionService(testConfig(root));
	const providers = [
		{
			id: "provider-1",
			name: "Local Anthropic",
			type: "anthropic-messages",
			baseUrl: "http://localhost:3000",
			apiKey: "test-key",
			models: [{ id: "model-1", name: "Model 1", provider: "Local Anthropic" }],
		},
	];

	service.writeSettings({ customProviders: providers });

	const settings = service.readSettings();
	assert.deepEqual(settings.customProviders, providers);
});

await test("WorkspaceFileService creates, rewrites, updates, lists, reads, and deletes files inside a session project", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));
	const context = { sessionId: "session-123456789", title: "Demo App" };

	const created = service.handle({ ...context, command: "create", filename: "src/main.js", content: "console.log('a');" });
	assert.equal(created.action, "created");

	const rewritten = service.handle({ ...context, command: "rewrite", filename: "src/main.js", content: "console.log('b');" });
	assert.equal(rewritten.action, "updated");

	const updated = service.handle({ ...context, command: "update", filename: "src/main.js", old_str: "'b'", new_str: "'c'" });
	assert.equal(updated.action, "updated");

	const read = service.handle({ ...context, command: "get", filename: "src/main.js" });
	assert.equal(read.content, "console.log('c');");

	const listed = service.handle({ ...context, command: "list" });
	assert.deepEqual(listed.files, ["src\\main.js"]);

	const deleted = service.handle({ ...context, command: "delete", filename: "src/main.js" });
	assert.equal(deleted.action, "deleted");
});

await test("WorkspaceFileService rejects project paths that escape the workspace", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));

	assert.throws(() =>
		service.handle({
			sessionId: "session-123456789",
			title: "Demo App",
			command: "create",
			filename: "../outside.txt",
			content: "no",
		}),
	/Project path component is empty\./);
});

await test("WorkspacePreviewService serves dist when a project was built", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { sessionId: "session-abcdef", title: "Built App" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "echo build" } }),
	});
	mkdirSync(join(String(created.projectRoot), "dist"), { recursive: true });
	writeFileSync(join(String(created.projectRoot), "dist", "index.html"), "<h1>Built</h1>", "utf8");

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "running");
	assert.equal(result.serveRoot, join(String(created.projectRoot), "dist"));
	assert.equal(result.previewUrl, "http://localhost:5173/preview/built-app-session-/");
	assert.match(readFileSync(join(String(created.projectRoot), ".pi-project.json"), "utf8"), /"status": "running"/);
});
