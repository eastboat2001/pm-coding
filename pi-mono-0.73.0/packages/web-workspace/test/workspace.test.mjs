import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import {
	configuredStoragePlugin,
	isUnsafeProjectCommand,
	loadStorageConfig,
	WorkspaceCommandService,
	WorkspaceFileService,
	WorkspacePreviewService,
	WorkspaceSessionService,
	WorkspaceTaskService,
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
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
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
			handoffDefaultThinkingLevel: "medium",
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
	assert.equal(config.handoffDefaultThinkingLevel, "medium");
});

await test("loadStorageConfig supports legacy storageDir defaults", () => {
	const root = tempRoot();
	writeFileSync(join(root, "pi-storage.config.json"), JSON.stringify({ storageDir: "runtime" }), "utf8");

	const config = loadStorageConfig(root);

	assert.equal(config.sessionsDir, resolve(root, "runtime/sessions"));
	assert.equal(config.settingsFile, resolve(root, "runtime/settings.json"));
	assert.equal(config.projectsRootDir, resolve(root, "data/projects"));
	assert.equal(config.serverSessionSyncEnabled, false);
	assert.equal(config.defaultModelProvider, "");
	assert.equal(config.defaultModelId, "");
	assert.equal(config.handoffDefaultThinkingLevel, "high");
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

await test("WorkspaceCommandService rejects commands that can stop the PI server", async () => {
	const root = tempRoot();
	const service = new WorkspaceCommandService(testConfig(root));
	const context = { sessionId: "session-command-safety", title: "Command Safety" };
	const command = "taskkill /F /IM node.exe 2>nul & echo Stopped";

	assert.equal(isUnsafeProjectCommand(command), true);
	await assert.rejects(
		() => service.run({ ...context, command }),
		/Refusing to run a command that can stop the PI server/,
	);
});

await test("configuredStoragePlugin ignores generated storage directories in the Vite watcher", async () => {
	const root = tempRoot();
	const configFile = join(root, "pi-storage.config.json");
	writeFileSync(
		configFile,
		JSON.stringify({
			sessionsDir: join(root, "runtime", "sessions"),
			settingsFile: join(root, "runtime", "settings.json"),
			projectsRootDir: join(root, "runtime", "projects"),
		}),
		"utf8",
	);

	const plugin = configuredStoragePlugin(configFile);
	const viteConfig = plugin.config?.();
	const ignored = viteConfig?.server?.watch?.ignored;

	assert.ok(Array.isArray(ignored));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "sessions")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "projects")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "settings.json"))));
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
	assert.equal(result.mode, "static");
	assert.equal(result.serveRoot, join(String(created.projectRoot), "dist"));
	assert.equal(result.previewUrl, "http://localhost:5173/preview/built-app-session-/");
	assert.match(readFileSync(join(String(created.projectRoot), ".pi-project.json"), "utf8"), /"status": "running"/);
});

await test("WorkspaceTaskService previews static root without running package scripts", async () => {
	const root = tempRoot();
	const config = testConfig(root);
	const fileService = new WorkspaceFileService(config);
	const taskService = new WorkspaceTaskService(config);
	const context = { sessionId: "session-static-script", title: "Static Script" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "index.html",
		content: "<h1>Static root</h1>",
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({
			scripts: {
				build:
					"node -e \"require('node:fs').mkdirSync('dist',{recursive:true});require('node:fs').writeFileSync('dist/index.html','<h1>Build script ran</h1>')\"",
			},
		}),
	});

	const result = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "running");
	assert.equal(result.mode, "static");
	assert.equal(result.previewUrl, "http://localhost:5173/preview/static-script-session-/");
	assert.equal(result.serveRoot, String(created.projectRoot));
	assert.equal(existsSync(join(String(created.projectRoot), "dist", "index.html")), false);
	assert.match(result.logs.join(""), /does not run package scripts/);
});

await test("WorkspacePreviewService rejects build source entries before build_static", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { sessionId: "session-vite-source", title: "Vite Source" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "vite build" }, dependencies: { "@vitejs/plugin-react": "latest" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "index.html",
		content: '<div id="root"></div><script type="module" src="/src/main.tsx"></script>',
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "src/main.tsx",
		content: "console.log('tsx source');",
	});

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /project_task build_static/);
});

await test("WorkspaceTaskService rejects Node services without a static entry", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const taskService = new WorkspaceTaskService(config);
	const context = { sessionId: "session-node-service", title: "Node Service" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { start: "node server.js" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "server.js",
		content: "require('node:http').createServer((_req, res) => res.end('no')).listen(process.env.PORT)",
	});

	const result = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /Static preview requires an index\.html/);
	assert.match(result.logs.join(""), /Node services are not started/);
});

await test("WorkspaceTaskService build_static runs the configured build and exposes static output", async () => {
	const root = tempRoot();
	const config = testConfig(root, {
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
	});
	const fileService = new WorkspaceFileService(config);
	const commands = [];
	const taskService = new WorkspaceTaskService(config, undefined, async (command, cwd, _timeoutMs, logs) => {
		commands.push(command);
		logs.push(`ran: ${command}\n`);
		if (command === "npm run build") {
			mkdirSync(join(cwd, "dist"), { recursive: true });
			writeFileSync(join(cwd, "dist", "index.html"), "<h1>Built static</h1>", "utf8");
		}
	});
	const context = { sessionId: "session-build-static", title: "Build Static" };

	const created = fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { build: "vite build" } }),
	});
	fileService.handle({
		...context,
		command: "create",
		filename: "src/main.js",
		content: "console.log('source');",
	});

	const build = await taskService.run({ ...context, task: "build_static" });
	const preview = await taskService.run({ ...context, task: "preview" }, { headers: { host: "localhost:5173" } });

	assert.equal(build.status, "passed");
	assert.equal(build.valid, true);
	assert.deepEqual(commands, ["npm install", "npm run build"]);
	assert.equal(build.serveRoot, join(String(created.projectRoot), "dist"));
	assert.equal(existsSync(join(String(created.projectRoot), "dist", "index.html")), true);
	assert.match(build.logs.join(""), /Static build completed/);
	assert.equal(preview.status, "running");
	assert.equal(preview.serveRoot, join(String(created.projectRoot), "dist"));
});

await test("WorkspacePreviewService does not return a clickable URL for an unpreviewable project", async () => {
	const root = tempRoot();
	const config = testConfig(root, { projectInstallCommand: "", projectBuildCommand: "" });
	const fileService = new WorkspaceFileService(config);
	const previewService = new WorkspacePreviewService(config);
	const context = { sessionId: "session-unpreviewable", title: "Unpreviewable" };

	fileService.handle({
		...context,
		command: "create",
		filename: "package.json",
		content: JSON.stringify({ scripts: { test: "node test.js" } }),
	});

	const result = await previewService.preview(context, { headers: { host: "localhost:5173" } });

	assert.equal(result.status, "failed");
	assert.equal(result.previewUrl, "");
	assert.match(result.logs.join(""), /Static preview requires an index\.html/);
});

function normalizeWatchPath(path) {
	return resolve(path).replace(/\\/g, "/");
}
