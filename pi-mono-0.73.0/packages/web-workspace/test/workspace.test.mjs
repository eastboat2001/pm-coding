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
	WorkspaceSkillService,
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
		skillsDir: join(root, "data", "skills"),
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
			skillsDir: "runtime/skills",
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
	assert.equal(config.skillsDir, resolve(root, "runtime/skills"));
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
	assert.equal(config.skillsDir, resolve(root, "data/skills"));
	assert.equal(config.serverSessionSyncEnabled, false);
	assert.equal(config.defaultModelProvider, "");
	assert.equal(config.defaultModelId, "");
	assert.equal(config.handoffDefaultThinkingLevel, "high");
});

await test("WorkspaceSkillService loads global skills and hides disabled skills from prompt metadata", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const skillDir = join(config.skillsDir, "ui-polish");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ui-polish
description: Use this skill when improving generated UI spacing, visual hierarchy, and responsive polish. Do not use for backend-only, data-only, or pure documentation tasks.
---

# UI Polish

Use stronger layout hierarchy.
`,
		"utf8",
	);
	mkdirSync(join(config.skillsDir, "private-skill"), { recursive: true });
	writeFileSync(
		join(config.skillsDir, "private-skill", "SKILL.md"),
		`---
name: private-skill
description: Use this skill when testing hidden skills. Do not use for visible model invocation.
disable-model-invocation: true
---

# Private
`,
		"utf8",
	);

	const service = new WorkspaceSkillService(config);
	const list = service.list();

	assert.deepEqual(
		list.skills.map((skill) => skill.name),
		["private-skill", "ui-polish"],
	);
	assert.deepEqual(
		list.promptSkills.map((skill) => skill.name),
		["ui-polish"],
	);
	assert.equal(list.diagnostics.length, 0);

	const loaded = service.load({ name: "ui-polish" });
	assert.equal(loaded.name, "ui-polish");
	assert.match(loaded.content, /Use stronger layout hierarchy/);
	assert.equal(loaded.location, "skill://ui-polish/SKILL.md");
});

await test("WorkspaceSkillService reads only text resources inside a skill directory", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const skillDir = join(config.skillsDir, "ui-polish");
	mkdirSync(join(skillDir, "references"), { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ui-polish
description: Improve generated UI spacing.
---

# UI Polish
`,
		"utf8",
	);
	writeFileSync(join(skillDir, "references", "rules.md"), "# Rules\n\nUse clear spacing.", "utf8");
	writeFileSync(join(skillDir, "image.png"), "not really an image", "utf8");

	const service = new WorkspaceSkillService(config);
	const resource = service.readResource({ name: "ui-polish", path: "references/rules.md" });

	assert.equal(resource.name, "ui-polish");
	assert.equal(resource.path, "references/rules.md");
	assert.match(resource.content, /Use clear spacing/);
	assert.throws(() => service.readResource({ name: "ui-polish", path: "../outside.md" }), /escapes skill root/);
	assert.throws(() => service.readResource({ name: "ui-polish", path: "image.png" }), /not an allowed text resource/);
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

await test("WorkspaceSessionService deletes only project directories whose metadata matches the full session id", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceSessionService(config);
	const targetSessionId = "abcdef12-target";
	const otherSessionId = "abcdef12-other";
	const targetProjectDir = join(config.projectsRootDir, "target-app-abcdef12");
	const otherProjectDir = join(config.projectsRootDir, "other-app-abcdef12");
	mkdirSync(targetProjectDir, { recursive: true });
	mkdirSync(otherProjectDir, { recursive: true });
	writeFileSync(
		join(targetProjectDir, ".pi-project.json"),
		JSON.stringify({
			projectId: "target-app-abcdef12",
			sessionId: targetSessionId,
			title: "Target App",
			status: "running",
			mode: "static",
			previewUrl: "",
			projectRoot: targetProjectDir,
			serveRoot: targetProjectDir,
			fileCount: 1,
			updatedAt: "2026-06-03T00:00:00.000Z",
		}),
		"utf8",
	);
	writeFileSync(
		join(otherProjectDir, ".pi-project.json"),
		JSON.stringify({
			projectId: "other-app-abcdef12",
			sessionId: otherSessionId,
			title: "Other App",
			status: "running",
			mode: "static",
			previewUrl: "",
			projectRoot: otherProjectDir,
			serveRoot: otherProjectDir,
			fileCount: 1,
			updatedAt: "2026-06-03T00:00:00.000Z",
		}),
		"utf8",
	);

	service.writeSession(
		targetSessionId,
		{ id: targetSessionId, title: "Target App", messages: [] },
		{ id: targetSessionId, title: "Target App" },
	);

	assert.equal(service.deleteSession(targetSessionId), true);
	assert.equal(existsSync(targetProjectDir), false);
	assert.equal(existsSync(otherProjectDir), true);
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

await test("WorkspaceFileService lists current project files without write-side effects", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { sessionId: "session-files", title: "Demo App" };

	service.handle({ ...context, command: "create", filename: "src/main.js", content: "console.log('ok');" });
	service.handle({ ...context, command: "create", filename: "src/components/App.vue", content: "<template></template>" });
	const siblingDir = join(config.projectsRootDir, "legacy-session-");
	mkdirSync(siblingDir, { recursive: true });

	const listed = service.listProjectFiles(context);
	const missing = service.listProjectFiles({ sessionId: "session-missing", title: "Missing App" });

	assert.deepEqual(listed.files, ["src/components/App.vue", "src/main.js"]);
	assert.equal(listed.fileCount, 2);
	assert.equal(existsSync(siblingDir), true);
	assert.deepEqual(missing.files, []);
	assert.equal(existsSync(join(config.projectsRootDir, "missing-app-session-")), false);
});

await test("WorkspaceFileService previews a current project text file without write-side effects", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { sessionId: "session-preview", title: "Preview App" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const siblingDir = join(config.projectsRootDir, "legacy-session-");
	mkdirSync(siblingDir, { recursive: true });

	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });

	assert.equal(preview.filename, "src/main.ts");
	assert.equal(preview.content, "export const answer = 42;\n");
	assert.equal(preview.language, "typescript");
	assert.equal(preview.binary, false);
	assert.equal(preview.truncated, false);
	assert.equal(preview.hash.length, 64);
	assert.equal(existsSync(siblingDir), true);
	assert.throws(() => service.readProjectFilePreview({ ...context, filename: "../outside.txt" }), /Project path component/);
});

await test("WorkspaceFileService saves a text file preview with hash conflict protection", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { sessionId: "session-save", title: "Save App" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });
	const saved = service.saveProjectFile({
		...context,
		filename: "src/main.ts",
		content: "export const answer = 43;\n",
		baseHash: preview.hash,
	});
	const read = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });

	assert.equal(saved.filename, "src/main.ts");
	assert.equal(saved.content, "export const answer = 43;\n");
	assert.equal(saved.hash, read.hash);
	assert.notEqual(saved.hash, preview.hash);
	assert.equal(read.content, "export const answer = 43;\n");
});

await test("WorkspaceFileService rejects saving when the base hash is stale", () => {
	const root = tempRoot();
	const config = testConfig(root);
	const service = new WorkspaceFileService(config);
	const context = { sessionId: "session-save-conflict", title: "Save Conflict" };

	service.handle({ ...context, command: "create", filename: "src/main.ts", content: "export const answer = 42;\n" });
	const preview = service.readProjectFilePreview({ ...context, filename: "src/main.ts" });
	service.handle({ ...context, command: "rewrite", filename: "src/main.ts", content: "export const answer = 99;\n" });

	assert.throws(
		() =>
			service.saveProjectFile({
				...context,
				filename: "src/main.ts",
				content: "export const answer = 43;\n",
				baseHash: preview.hash,
			}),
		/File has changed since it was opened/,
	);
	assert.equal(service.readProjectFilePreview({ ...context, filename: "src/main.ts" }).content, "export const answer = 99;\n");
});

await test("WorkspaceFileService rejects update when old_str is not unique", () => {
	const root = tempRoot();
	const service = new WorkspaceFileService(testConfig(root));
	const context = { sessionId: "session-123456789", title: "Demo App" };

	service.handle({
		...context,
		command: "create",
		filename: "src/main.js",
		content: "const label = 'Save';\nconst buttonLabel = 'Save';\n",
	});

	assert.throws(
		() =>
			service.handle({
				...context,
				command: "update",
				filename: "src/main.js",
				old_str: "'Save'",
				new_str: "'Submit'",
			}),
		/old_str must match exactly one location/,
	);

	const read = service.handle({ ...context, command: "get", filename: "src/main.js" });
	assert.equal(read.content, "const label = 'Save';\nconst buttonLabel = 'Save';\n");
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
			skillsDir: join(root, "runtime", "skills"),
		}),
		"utf8",
	);

	const plugin = configuredStoragePlugin(configFile);
	const viteConfig = plugin.config?.();
	const ignored = viteConfig?.server?.watch?.ignored;

	assert.ok(Array.isArray(ignored));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "sessions")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "projects")) + "/**"));
	assert.ok(ignored.includes(normalizeWatchPath(join(root, "runtime", "skills")) + "/**"));
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

await test("WorkspacePreviewService lists generated projects from preview metadata newest first", async () => {
	const root = tempRoot();
	const config = testConfig(root);
	const previewService = new WorkspacePreviewService(config);
	const olderDir = join(config.projectsRootDir, "older-app");
	const newerDir = join(config.projectsRootDir, "newer-app");
	const brokenDir = join(config.projectsRootDir, "broken-app");
	const incompleteDir = join(config.projectsRootDir, "incomplete-app");
	mkdirSync(olderDir, { recursive: true });
	mkdirSync(newerDir, { recursive: true });
	mkdirSync(brokenDir, { recursive: true });
	mkdirSync(incompleteDir, { recursive: true });
	writeFileSync(
		join(olderDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "older-app",
			sessionId: "session-old",
			title: "Older App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/older-app/",
			projectRoot: olderDir,
			serveRoot: olderDir,
			fileCount: 2,
			updatedAt: "2026-05-28T10:00:00.000Z",
			logs: ["old"],
		}),
		"utf8",
	);
	writeFileSync(
		join(newerDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "newer-app",
			sessionId: "session-new",
			title: "Newer App",
			status: "failed",
			mode: "static",
			previewUrl: "",
			projectRoot: newerDir,
			serveRoot: "",
			fileCount: 4,
			updatedAt: "2026-05-29T10:00:00.000Z",
			logs: ["new"],
		}),
		"utf8",
	);
	writeFileSync(join(brokenDir, ".pi-project.json"), "{not json", "utf8");
	writeFileSync(join(incompleteDir, ".pi-project.json"), JSON.stringify({ projectId: "incomplete-app" }), "utf8");

	const result = previewService.listProjects();

	assert.deepEqual(
		result.projects.map((project) => project.projectId),
		["newer-app", "older-app"],
	);
	assert.equal(result.projects[0].title, "Newer App");
	assert.equal(result.projects[0].status, "failed");
	assert.equal(result.projects[0].previewUrl, "");
	assert.equal(result.projects[0].fileCount, 4);
	assert.equal(result.projects[0].sessionId, "session-new");
	assert.equal(result.projects[0].updatedAt, "2026-05-29T10:00:00.000Z");
	assert.equal("projectRoot" in result.projects[0], false);
	assert.equal("serveRoot" in result.projects[0], false);
	assert.equal("logs" in result.projects[0], false);
});

await test("WorkspacePreviewService rewrites running project preview URLs for the current request host", async () => {
	const root = tempRoot();
	const config = testConfig(root, { previewBaseUrl: "" });
	const previewService = new WorkspacePreviewService(config);
	const projectDir = join(config.projectsRootDir, "current-host-app");
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "current-host-app",
			sessionId: "session-current-host",
			title: "Current Host App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/current-host-app/",
			projectRoot: projectDir,
			serveRoot: projectDir,
			fileCount: 1,
			updatedAt: "2026-05-29T10:00:00.000Z",
			logs: [],
		}),
		"utf8",
	);

	const result = previewService.listProjects({ headers: { host: "127.0.0.1:5194" } });

	assert.equal(result.projects[0].previewUrl, "http://127.0.0.1:5194/preview/current-host-app/");
});

await test("WorkspacePreviewService renames generated project metadata", async () => {
	const root = tempRoot();
	const config = testConfig(root, { previewBaseUrl: "" });
	const previewService = new WorkspacePreviewService(config);
	const projectDir = join(config.projectsRootDir, "rename-app");
	const updatedAt = "2026-05-29T10:00:00.000Z";
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		join(projectDir, ".pi-project.json"),
		JSON.stringify({
			version: 1,
			projectId: "rename-app",
			sessionId: "session-rename",
			title: "Original App",
			status: "running",
			mode: "static",
			previewUrl: "http://localhost:5173/preview/rename-app/",
			projectRoot: projectDir,
			serveRoot: projectDir,
			fileCount: 2,
			updatedAt,
			logs: [],
		}),
		"utf8",
	);

	const result = previewService.renameProject("rename-app", "Renamed App", { headers: { host: "127.0.0.1:5194" } });
	const metadata = JSON.parse(readFileSync(join(projectDir, ".pi-project.json"), "utf8"));

	assert.equal(result.title, "Renamed App");
	assert.equal(result.status, "running");
	assert.equal(result.previewUrl, "http://127.0.0.1:5194/preview/rename-app/");
	assert.equal(result.updatedAt, updatedAt);
	assert.equal(metadata.title, "Renamed App");
	assert.equal(metadata.updatedAt, updatedAt);
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
