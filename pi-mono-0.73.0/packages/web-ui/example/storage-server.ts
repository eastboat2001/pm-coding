import type { Connect, Plugin } from "vite";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";

type JsonObject = Record<string, any>;

interface StorageConfig {
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
	previewBaseUrl: string;
	projectInstallCommand: string;
	projectBuildCommand: string;
	projectInstallTimeoutMs: number;
	projectBuildTimeoutMs: number;
}

const API_PREFIX = "/api/pi-storage";
const PROJECTS_API_PREFIX = "/api/pi-projects";
const PREVIEW_PREFIX = "/preview";
const CONFIG_FILE = "pi-storage.config.json";
const PROJECT_MANIFEST_FILE = ".pi-project-files.json";
const PROJECT_METADATA_FILE = ".pi-project.json";

export function configuredStoragePlugin(): Plugin {
	const rootDir = process.cwd();
	const config = loadStorageConfig(rootDir);

	const ensureStorageDirs = () => {
		mkdirSync(config.sessionsDir, { recursive: true });
		mkdirSync(dirname(config.settingsFile), { recursive: true });
		mkdirSync(config.projectsRootDir, { recursive: true });
	};

	const handler: Connect.NextHandleFunction = async (req, res, next) => {
		if (req.url?.startsWith(PREVIEW_PREFIX)) {
			try {
				ensureStorageDirs();
				if (servePreviewRequest(config, req, res)) return;
			} catch (error) {
				sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
				return;
			}
		}

		if (!req.url?.startsWith(API_PREFIX) && !req.url?.startsWith(PROJECTS_API_PREFIX)) {
			next();
			return;
		}

		try {
			ensureStorageDirs();
			const url = new URL(req.url, "http://localhost");
			const isProjectsApi = url.pathname.startsWith(PROJECTS_API_PREFIX);
			const route = url.pathname.slice(isProjectsApi ? PROJECTS_API_PREFIX.length : API_PREFIX.length) || "/";
			const method = req.method || "GET";

			if (isProjectsApi) {
				if (method === "POST" && route === "/workspace/file") {
					const body = await readJsonBody(req);
					const result = handleWorkspaceFile(config, body);
					sendJson(res, result);
					return;
				}

				if (method === "POST" && route === "/workspace/bash") {
					const body = await readJsonBody(req);
					const result = await runWorkspaceCommand(config, body);
					sendJson(res, result);
					return;
				}

				if (method === "POST" && route === "/workspace/preview") {
					const body = await readJsonBody(req);
					const result = await previewWorkspace(config, body, req);
					sendJson(res, result);
					return;
				}

				const logsMatch = route.match(/^\/([^/]+)\/logs$/);
				if (method === "GET" && logsMatch) {
					const projectId = decodeURIComponent(logsMatch[1]);
					sendJson(res, readProjectLogs(config, projectId));
					return;
				}

				sendJson(res, { error: "Not found." }, 404);
				return;
			}

			if (method === "GET" && route === "/status") {
				sendJson(res, {
					configured: true,
					sessionsDir: config.sessionsDir,
					settingsFile: config.settingsFile,
					projectsRootDir: config.projectsRootDir,
					previewBaseUrl: config.previewBaseUrl,
				});
				return;
			}

			if (method === "GET" && route === "/sessions") {
				sendJson(res, { sessions: listSessions(config.sessionsDir) });
				return;
			}

			const sessionMatch = route.match(/^\/sessions\/([^/]+)$/);
			if (sessionMatch) {
				const sessionId = decodeURIComponent(sessionMatch[1]);
				const sessionPath = getSessionPath(config.sessionsDir, sessionId);

				if (method === "GET") {
					if (!existsSync(sessionPath)) {
						sendJson(res, { error: "Session not found." }, 404);
						return;
					}
					const record = readJsonFile(sessionPath);
					sendJson(res, { ...record, project: projectSummary(config.projectsRootDir, record.data) });
					return;
				}

				if (method === "PUT") {
					const body = await readJsonBody(req);
					const data = body.data;
					const metadata = body.metadata;
					if (!isObject(data) || !isObject(metadata)) {
						sendJson(res, { error: "Fields `data` and `metadata` are required." }, 400);
						return;
					}
					if (String(data.id || "") !== sessionId || String(metadata.id || "") !== sessionId) {
						sendJson(res, { error: "Session ID mismatch." }, 400);
						return;
					}

					const record = {
						version: 1,
						savedAt: new Date().toISOString(),
						data,
						metadata,
					};
					writeJsonFile(sessionPath, record);
					const project = persistProjectArtifacts(config.projectsRootDir, sessionId, data, metadata);
					sendJson(res, { ...record, project });
					return;
				}

				if (method === "DELETE") {
					const deleted = deleteSessionAndProjects(config.projectsRootDir, sessionPath, sessionId);
					sendJson(res, { deleted });
					return;
				}
			}

			if (route === "/settings") {
				if (method === "GET") {
					if (!existsSync(config.settingsFile)) {
						sendJson(res, { error: "Settings not found." }, 404);
						return;
					}
					sendJson(res, readJsonFile(config.settingsFile));
					return;
				}

				if (method === "PUT") {
					const body = await readJsonBody(req);
					const existing = existsSync(config.settingsFile) ? readJsonFile(config.settingsFile) : {};
					const record = {
						...(isObject(existing) ? existing : {}),
						version: 1,
						savedAt: new Date().toISOString(),
					};
					if (Object.prototype.hasOwnProperty.call(body, "currentSessionId")) {
						const currentSessionId = body.currentSessionId;
						if (typeof currentSessionId === "string" && currentSessionId.trim()) {
							record.currentSessionId = currentSessionId;
						} else {
							delete record.currentSessionId;
						}
					}
					if (Object.prototype.hasOwnProperty.call(body, "selectedModel")) {
						record.selectedModel = body.selectedModel;
					}
					writeJsonFile(config.settingsFile, record);
					sendJson(res, record);
					return;
				}
			}

			sendJson(res, { error: "Not found." }, 404);
		} catch (error) {
			sendJson(res, { error: error instanceof Error ? error.message : String(error) }, 500);
		}
	};

	return {
		name: "pi-web-ui-configured-storage",
		configureServer(server) {
			server.middlewares.use(handler);
		},
		configurePreviewServer(server) {
			server.middlewares.use(handler);
		},
	};
}

function loadStorageConfig(rootDir: string): StorageConfig {
	const configPath = join(rootDir, CONFIG_FILE);
	const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
	const legacyStorageDir = raw.storageDir ? resolveConfiguredPath(rootDir, raw.storageDir) : undefined;
	return {
		sessionsDir: resolveConfiguredPath(rootDir, raw.sessionsDir || (legacyStorageDir ? join(legacyStorageDir, "sessions") : "data/sessions")),
		settingsFile: resolveConfiguredPath(rootDir, raw.settingsFile || (legacyStorageDir ? join(legacyStorageDir, "settings.json") : "data/settings.json")),
		projectsRootDir: resolveConfiguredPath(rootDir, raw.projectsRootDir || "data/projects"),
		previewBaseUrl: String(raw.previewBaseUrl || "").replace(/\/+$/, ""),
		projectInstallCommand: String(raw.projectInstallCommand || "npm install"),
		projectBuildCommand: String(raw.projectBuildCommand || "npm run build"),
		projectInstallTimeoutMs: Number(raw.projectInstallTimeoutMs || 120000),
		projectBuildTimeoutMs: Number(raw.projectBuildTimeoutMs || 120000),
	};
}

function resolveConfiguredPath(rootDir: string, value: string): string {
	const rawPath = String(value || "").trim();
	if (!rawPath) return resolve(rootDir, "data");
	return isAbsolute(rawPath) ? resolve(rawPath) : resolve(rootDir, rawPath);
}

function listSessions(sessionsDir: string): JsonObject[] {
	if (!existsSync(sessionsDir)) return [];
	const sessions: JsonObject[] = [];
	for (const filename of readdirSync(sessionsDir)) {
		if (!filename.endsWith(".json")) continue;
		try {
			const record = readJsonFile(join(sessionsDir, filename));
			if (isObject(record.metadata)) sessions.push(record.metadata);
		} catch {
			// Ignore malformed session files so one bad record does not break startup.
		}
	}
	return sessions.sort((a, b) => String(b.lastModified || "").localeCompare(String(a.lastModified || "")));
}

function getSessionPath(sessionsDir: string, sessionId: string): string {
	const safeSessionId = sanitizePathComponent(sessionId) || sessionId;
	return join(sessionsDir, `${safeSessionId}.json`);
}

function projectSummary(projectsRootDir: string, sessionData: JsonObject): JsonObject {
	const projectDir = projectDirectory(projectsRootDir, String(sessionData.id || ""), String(sessionData.title || ""));
	return {
		projectRoot: projectDir,
		fileCount: listProjectSourceFiles(projectDir).length,
	};
}

function persistProjectArtifacts(
	projectsRootDir: string,
	sessionId: string,
	sessionData: JsonObject,
	metadata: JsonObject,
): JsonObject {
	const projectDir = projectDirectory(projectsRootDir, sessionId, String(metadata.title || ""));
	const artifacts = extractArtifactsFromMessages(sessionData.messages);
	if (Object.keys(artifacts).length === 0) {
		return {
			projectRoot: projectDir,
			fileCount: listProjectSourceFiles(projectDir).length,
		};
	}

	mkdirSync(projectDir, { recursive: true });
	syncProjectFiles(projectDir, artifacts);
	removeSiblingProjectDirs(projectsRootDir, projectDir, sessionId);
	return {
		projectRoot: projectDir,
		fileCount: Object.keys(artifacts).length,
	};
}

function projectDirectory(projectsRootDir: string, sessionId: string, title?: string): string {
	return join(projectsRootDir, projectSlug(sessionId, title));
}

function projectSlug(sessionId: string, title?: string): string {
	const base = sanitizePathComponent(title || "");
	const suffix = (sanitizePathComponent(sessionId) || sessionId).slice(0, 8);
	return base ? `${base}-${suffix}` : `project-${suffix}`;
}

function sanitizePathComponent(value: string): string {
	let normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
	normalized = normalized.replace(/[^a-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
	const reserved = new Set([
		"con",
		"prn",
		"aux",
		"nul",
		"com1",
		"com2",
		"com3",
		"com4",
		"com5",
		"com6",
		"com7",
		"com8",
		"com9",
		"lpt1",
		"lpt2",
		"lpt3",
		"lpt4",
		"lpt5",
		"lpt6",
		"lpt7",
		"lpt8",
		"lpt9",
	]);
	if (reserved.has(normalized)) normalized = `${normalized}-file`;
	return normalized.slice(0, 80);
}

function extractArtifactsFromMessages(messages: unknown): Record<string, string> {
	const toolCalls = new Map<string, JsonObject>();
	const operations: JsonObject[] = [];
	if (!Array.isArray(messages)) return {};

	for (const message of messages) {
		if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (isObject(block) && block.type === "toolCall" && block.name === "artifacts") {
				toolCalls.set(String(block.id || ""), structuredCloneFallback(block));
			}
		}
	}

	for (const message of messages) {
		if (!isObject(message)) continue;
		if (message.role === "artifact") {
			const action = String(message.action || "").trim();
			const filename = String(message.filename || "").trim();
			if (!filename) continue;
			if (action === "create") operations.push({ command: "create", filename, content: message.content || "" });
			if (action === "update") operations.push({ command: "rewrite", filename, content: message.content || "" });
			if (action === "delete") operations.push({ command: "delete", filename });
			continue;
		}
		if (message.role === "toolResult" && message.toolName === "artifacts" && message.isError === false) {
			const call = toolCalls.get(String(message.toolCallId || ""));
			if (isObject(call?.arguments)) operations.push(structuredCloneFallback(call.arguments));
		}
	}

	const artifacts: Record<string, string> = {};
	for (const operation of operations) {
		const command = String(operation.command || "").trim();
		const filename = String(operation.filename || "").trim();
		if (!filename) continue;
		if ((command === "create" || command === "rewrite") && typeof operation.content === "string") {
			artifacts[filename] = operation.content;
			continue;
		}
		if (command === "update") {
			const existing = artifacts[filename];
			if (typeof existing === "string" && typeof operation.old_str === "string" && typeof operation.new_str === "string") {
				artifacts[filename] = existing.replace(operation.old_str, operation.new_str);
			}
			continue;
		}
		if (command === "delete") delete artifacts[filename];
	}
	return artifacts;
}

function syncProjectFiles(projectDir: string, artifacts: Record<string, string>): void {
	const manifestPath = join(projectDir, PROJECT_MANIFEST_FILE);
	const previousFiles = readProjectManifest(manifestPath);
	const nextFiles = new Set<string>();

	for (const [filename, content] of Object.entries(artifacts)) {
		const relativePath = safeRelativeProjectPath(filename);
		const targetPath = resolve(projectDir, relativePath);
		assertInside(projectDir, targetPath);
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, content, "utf8");
		nextFiles.add(relativePath);
	}

	for (const previous of previousFiles) {
		if (nextFiles.has(previous)) continue;
		const targetPath = resolve(projectDir, previous);
		assertInside(projectDir, targetPath);
		if (existsSync(targetPath)) rmSync(targetPath, { force: true });
	}

	writeJsonFile(manifestPath, { files: Array.from(nextFiles).sort() });
	pruneEmptyDirectories(projectDir);
}

function safeRelativeProjectPath(filename: string): string {
	const rawParts = filename
		.replace(/\\/g, "/")
		.split("/")
		.map((part) => part.trim())
		.filter(Boolean);
	const parts = rawParts.map((part) => sanitizeProjectPathComponent(part));
	if (parts.length === 0) throw new Error("Project filename is empty.");
	return join(...parts);
}

function sanitizeProjectPathComponent(value: string): string {
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes(":")) {
		throw new Error(`Invalid project path component: ${value}`);
	}
	const cleaned = value.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/^[-\s]+|[-\s]+$/g, "");
	if (!cleaned) throw new Error("Project path component is empty.");
	return cleaned;
}

function removeSiblingProjectDirs(projectsRootDir: string, currentProjectDir: string, sessionId: string): void {
	if (!existsSync(projectsRootDir)) return;
	const suffix = `-${(sanitizePathComponent(sessionId) || sessionId).slice(0, 8)}`;
	for (const name of readdirSync(projectsRootDir)) {
		const candidate = join(projectsRootDir, name);
		if (candidate === currentProjectDir || !name.endsWith(suffix)) continue;
		rmSync(candidate, { recursive: true, force: true });
	}
}

function deleteSessionAndProjects(projectsRootDir: string, sessionPath: string, sessionId: string): boolean {
	let deleted = false;
	if (existsSync(sessionPath)) {
		rmSync(sessionPath, { force: true });
		deleted = true;
	}
	const suffix = `-${(sanitizePathComponent(sessionId) || sessionId).slice(0, 8)}`;
	if (existsSync(projectsRootDir)) {
		for (const name of readdirSync(projectsRootDir)) {
			if (name === `project${suffix}` || name.endsWith(suffix)) {
				rmSync(join(projectsRootDir, name), { recursive: true, force: true });
				deleted = true;
			}
		}
	}
	return deleted;
}

function listProjectSourceFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const excludedDirs = new Set([".git", ".pi", "node_modules", ".next", ".nuxt", "dist", "build", "coverage"]);
	const excludedFiles = new Set([PROJECT_METADATA_FILE, PROJECT_MANIFEST_FILE]);
	const result: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (excludedDirs.has(entry.name)) continue;
			result.push(...listProjectSourceFiles(path));
		}
		if (entry.isFile() && !excludedFiles.has(entry.name)) result.push(path);
	}
	return result;
}

function workspaceContext(config: StorageConfig, body: JsonObject): { sessionId: string; title: string; projectId: string; projectDir: string } {
	const sessionId = String(body.sessionId || "").trim();
	const title = String(body.title || "").trim();
	if (!sessionId) throw new Error("Field `sessionId` is required.");
	const projectId = projectSlug(sessionId, title);
	const projectDir = projectDirectory(config.projectsRootDir, sessionId, title);
	assertInside(config.projectsRootDir, projectDir);
	mkdirSync(projectDir, { recursive: true });
	removeSiblingProjectDirs(config.projectsRootDir, projectDir, sessionId);
	return { sessionId, title, projectId, projectDir };
}

function handleWorkspaceFile(config: StorageConfig, body: JsonObject): JsonObject {
	const { projectDir } = workspaceContext(config, body);
	const command = String(body.command || "").trim();
	const filename = String(body.filename || "").trim();

	if (command === "list") {
		const files = listProjectSourceFiles(projectDir).map((file) => file.slice(projectDir.length + 1));
		return { command, projectRoot: projectDir, files, fileCount: files.length };
	}

	if (!filename) throw new Error("Field `filename` is required.");
	const relativePath = safeRelativeProjectPath(filename);
	const targetPath = resolve(projectDir, relativePath);
	assertInside(projectDir, targetPath);

	if (command === "get") {
		if (!existsSync(targetPath)) throw new Error(`File not found: ${relativePath}`);
		return { command, filename: relativePath, content: readFileSync(targetPath, "utf8"), projectRoot: projectDir };
	}

	if (command === "delete") {
		const existed = existsSync(targetPath);
		if (existed) rmSync(targetPath, { force: true });
		return { command, filename: relativePath, action: existed ? "deleted" : "missing", projectRoot: projectDir };
	}

	if (command === "create" || command === "rewrite") {
		if (typeof body.content !== "string") throw new Error("Field `content` is required.");
		const existed = existsSync(targetPath);
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, body.content, "utf8");
		return {
			command,
			filename: relativePath,
			action: existed ? "updated" : "created",
			projectRoot: projectDir,
			fileCount: listProjectSourceFiles(projectDir).length,
		};
	}

	if (command === "update") {
		if (!existsSync(targetPath)) throw new Error(`File not found: ${relativePath}`);
		const oldStr = String(body.old_str ?? "");
		const newStr = String(body.new_str ?? "");
		if (!oldStr) throw new Error("Field `old_str` is required for update.");
		const current = readFileSync(targetPath, "utf8");
		if (!current.includes(oldStr)) throw new Error(`old_str was not found in ${relativePath}.`);
		writeFileSync(targetPath, current.replace(oldStr, newStr), "utf8");
		return { command, filename: relativePath, action: "updated", projectRoot: projectDir };
	}

	throw new Error(`Unsupported workspace file command: ${command}`);
}

async function runWorkspaceCommand(config: StorageConfig, body: JsonObject): Promise<JsonObject> {
	const { projectDir } = workspaceContext(config, body);
	const command = String(body.command || "").trim();
	if (!command) throw new Error("Field `command` is required.");
	const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs || config.projectBuildTimeoutMs), 300000));
	const logs: string[] = [];
	try {
		await runCommand(command, projectDir, timeoutMs, logs);
	} catch (error) {
		throw new Error(formatCommandFailure(error, logs));
	}
	return {
		command,
		projectRoot: projectDir,
		output: logs.join("").trim() || "Command completed successfully.",
	};
}

function formatCommandFailure(error: unknown, logs: string[]): string {
	const message = error instanceof Error ? error.message : String(error);
	const output = logs.join("").trim();
	const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "sh";
	return [
		message,
		output ? `Command output:\n${output}` : undefined,
		`Server environment: platform=${process.platform}; shell=${shell}`,
		"Use a command compatible with this environment and retry if needed.",
	]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

async function previewWorkspace(config: StorageConfig, body: JsonObject, req: Connect.IncomingMessage): Promise<JsonObject> {
	const { sessionId, title, projectId, projectDir } = workspaceContext(config, body);
	const fileCount = listProjectSourceFiles(projectDir).length;
	if (fileCount === 0) throw new Error("Cannot preview an empty project workspace.");
	return await buildAndRecordProject(config, projectDir, {
		projectId,
		sessionId,
		title,
		req,
		fileCount,
	});
}

async function buildAndRecordProject(
	config: StorageConfig,
	projectDir: string,
	options: { projectId: string; sessionId: string; title: string; req: Connect.IncomingMessage; fileCount: number },
): Promise<JsonObject> {
	const logs: string[] = [];
	logs.push(`Project root: ${projectDir}\n`);
	const packageJsonPath = join(projectDir, "package.json");
	let serveRoot = projectDir;
	let status = "running";

	try {
		if (existsSync(packageJsonPath)) {
			await runCommand(config.projectInstallCommand, projectDir, config.projectInstallTimeoutMs, logs);
			const packageJson = readJsonFile(packageJsonPath);
			if (isObject(packageJson.scripts) && typeof packageJson.scripts.build === "string") {
				await runCommand(config.projectBuildCommand, projectDir, config.projectBuildTimeoutMs, logs);
				const distDir = join(projectDir, "dist");
				if (existsSync(distDir) && statSync(distDir).isDirectory()) {
					serveRoot = distDir;
					logs.push(`Serving build output: ${serveRoot}\n`);
				}
			} else {
				logs.push("package.json has no build script; serving project root.\n");
			}
		} else {
			logs.push("No package.json found; serving project root without install/build.\n");
		}
	} catch (error) {
		status = "failed";
		logs.push(error instanceof Error ? error.message : String(error));
	}

	const previewUrl = buildPreviewUrl(config, options.req, options.projectId);
	const metadata = {
		version: 1,
		projectId: options.projectId,
		sessionId: options.sessionId,
		title: options.title,
		status,
		previewUrl,
		projectRoot: projectDir,
		serveRoot,
		fileCount: options.fileCount,
		updatedAt: new Date().toISOString(),
		logs,
	};
	writeJsonFile(join(projectDir, PROJECT_METADATA_FILE), metadata);

	return metadata;
}

function readProjectManifest(path: string): string[] {
	if (!existsSync(path)) return [];
	try {
		const record = readJsonFile(path);
		return Array.isArray(record.files) ? record.files.filter((file) => typeof file === "string") : [];
	} catch {
		return [];
	}
}

function runCommand(command: string, cwd: string, timeoutMs: number, logs: string[]): Promise<void> {
	const trimmedCommand = command.trim();
	if (!trimmedCommand) return Promise.resolve();
	logs.push(`$ ${trimmedCommand}`);
	return new Promise((resolveCommand, rejectCommand) => {
		const child = spawn(trimmedCommand, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "true" },
			windowsHide: true,
		});
		const timeout = setTimeout(() => {
			child.kill();
			rejectCommand(new Error(`Command timed out after ${timeoutMs}ms: ${trimmedCommand}`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => {
			const text = String(chunk);
			logs.push(text);
		});
		child.stderr?.on("data", (chunk) => {
			const text = String(chunk);
			logs.push(text);
		});
		child.on("error", (error) => {
			clearTimeout(timeout);
			rejectCommand(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolveCommand();
			} else {
				rejectCommand(new Error(`Command failed with exit code ${code}: ${trimmedCommand}`));
			}
		});
	});
}

function buildPreviewUrl(config: StorageConfig, req: Connect.IncomingMessage, projectId: string): string {
	const path = `${PREVIEW_PREFIX}/${encodeURIComponent(projectId)}/`;
	if (config.previewBaseUrl) return `${config.previewBaseUrl}${path}`;
	const host = req.headers.host || "localhost";
	const forwardedProto = req.headers["x-forwarded-proto"];
	const protocol = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto || "http";
	return `${protocol}://${host}${path}`;
}

function readProjectLogs(config: StorageConfig, projectId: string): JsonObject {
	const metadata = readProjectMetadata(config, projectId);
	if (!metadata) return { error: "Project not found." };
	return { projectId, status: metadata.status, logs: metadata.logs || [] };
}

function readProjectMetadata(config: StorageConfig, projectId: string): JsonObject | undefined {
	const safeProjectId = sanitizePathComponent(projectId);
	if (!safeProjectId) return undefined;
	const metadataPath = join(config.projectsRootDir, safeProjectId, PROJECT_METADATA_FILE);
	if (!existsSync(metadataPath)) return undefined;
	return readJsonFile(metadataPath);
}

function servePreviewRequest(config: StorageConfig, req: Connect.IncomingMessage, res: Connect.ServerResponse): boolean {
	if (!req.url) return false;
	const url = new URL(req.url, "http://localhost");
	const parts = url.pathname.slice(PREVIEW_PREFIX.length).split("/").filter(Boolean);
	const projectId = parts.shift();
	if (!projectId) return false;

	const metadata = readProjectMetadata(config, decodeURIComponent(projectId));
	if (!metadata || metadata.status !== "running") {
		sendJson(res, { error: "Preview not found." }, 404);
		return true;
	}

	const serveRoot = String(metadata.serveRoot || "");
	if (!serveRoot || !existsSync(serveRoot)) {
		sendJson(res, { error: "Preview output is missing." }, 404);
		return true;
	}

	const requestedPath = parts.length > 0 ? safeRelativePreviewPath(parts.map((part) => decodeURIComponent(part))) : "index.html";
	let targetPath = resolve(serveRoot, requestedPath);
	assertInside(serveRoot, targetPath);

	if (!existsSync(targetPath) || statSync(targetPath).isDirectory()) {
		targetPath = resolve(serveRoot, "index.html");
	}
	if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
		sendJson(res, { error: "Preview entry file is missing." }, 404);
		return true;
	}

	res.statusCode = 200;
	res.setHeader("Content-Type", mimeType(targetPath));
	if (extname(targetPath).toLowerCase() === ".html") {
		const previewBasePath = `${PREVIEW_PREFIX}/${encodeURIComponent(decodeURIComponent(projectId))}/`;
		res.end(rewritePreviewHtml(readFileSync(targetPath, "utf8"), previewBasePath));
		return true;
	}
	createReadStream(targetPath).pipe(res);
	return true;
}

function rewritePreviewHtml(html: string, previewBasePath: string): string {
	return html
		.replace(/\b(src|href|action)=("|')\/(?!\/|preview\/)/g, (_match, attribute: string, quote: string) => {
			return `${attribute}=${quote}${previewBasePath}`;
		})
		.replace(/\b(srcset)=("|')\/(?!\/|preview\/)/g, (_match, attribute: string, quote: string) => {
			return `${attribute}=${quote}${previewBasePath}`;
		});
}

function mimeType(path: string): string {
	const extension = extname(basename(path)).toLowerCase();
	const types: Record<string, string> = {
		".html": "text/html; charset=utf-8",
		".js": "text/javascript; charset=utf-8",
		".mjs": "text/javascript; charset=utf-8",
		".css": "text/css; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".svg": "image/svg+xml",
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".ico": "image/x-icon",
		".txt": "text/plain; charset=utf-8",
	};
	return types[extension] || "application/octet-stream";
}

function safeRelativePreviewPath(parts: string[]): string {
	const cleaned = parts.filter((part) => part && part !== "." && part !== ".." && !part.includes("/") && !part.includes("\\"));
	if (cleaned.length === 0) return "index.html";
	return join(...cleaned);
}

function readJsonFile(path: string): JsonObject {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path: string, payload: JsonObject): void {
	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.tmp`;
	writeFileSync(tempPath, JSON.stringify(payload, null, 2), "utf8");
	renameSync(tempPath, path);
}

function readJsonBody(req: Connect.IncomingMessage): Promise<JsonObject> {
	return new Promise((resolveBody, rejectBody) => {
		let body = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			try {
				resolveBody(body ? JSON.parse(body) : {});
			} catch (error) {
				rejectBody(error);
			}
		});
		req.on("error", rejectBody);
	});
}

function sendJson(res: Connect.ServerResponse, payload: JsonObject, status = 200): void {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(payload));
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structuredCloneFallback<T>(value: T): T {
	return JSON.parse(JSON.stringify(value));
}

function pruneEmptyDirectories(root: string): void {
	if (!existsSync(root)) return;
	for (const name of readdirSync(root, { withFileTypes: true })) {
		if (!name.isDirectory()) continue;
		const path = join(root, name.name);
		pruneEmptyDirectories(path);
		if (readdirSync(path).length === 0) rmSync(path, { recursive: true, force: true });
	}
}

function assertInside(root: string, target: string): void {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(target);
	if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)) {
		throw new Error("Artifact path escapes project root.");
	}
}
