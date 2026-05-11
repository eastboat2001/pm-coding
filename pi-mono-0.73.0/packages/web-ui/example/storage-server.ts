import type { Connect, Plugin } from "vite";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

type JsonObject = Record<string, any>;

interface StorageConfig {
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
}

const API_PREFIX = "/api/pi-storage";
const CONFIG_FILE = "pi-storage.config.json";

export function configuredStoragePlugin(): Plugin {
	const rootDir = process.cwd();
	const config = loadStorageConfig(rootDir);

	const ensureStorageDirs = () => {
		mkdirSync(config.sessionsDir, { recursive: true });
		mkdirSync(dirname(config.settingsFile), { recursive: true });
		mkdirSync(config.projectsRootDir, { recursive: true });
	};

	const handler: Connect.NextHandleFunction = async (req, res, next) => {
		if (!req.url?.startsWith(API_PREFIX)) {
			next();
			return;
		}

		try {
			ensureStorageDirs();
			const url = new URL(req.url, "http://localhost");
			const route = url.pathname.slice(API_PREFIX.length) || "/";
			const method = req.method || "GET";

			if (method === "GET" && route === "/status") {
				sendJson(res, {
					configured: true,
					sessionsDir: config.sessionsDir,
					settingsFile: config.settingsFile,
					projectsRootDir: config.projectsRootDir,
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
					const record = {
						version: 1,
						savedAt: new Date().toISOString(),
						currentSessionId: body.currentSessionId,
						selectedModel: body.selectedModel,
					};
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
		projectsRootDir: resolveConfiguredPath(rootDir, raw.projectsRootDir || "data/generated_projects"),
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
		fileCount: countFiles(projectDir),
	};
}

function persistProjectArtifacts(
	projectsRootDir: string,
	sessionId: string,
	sessionData: JsonObject,
	metadata: JsonObject,
): JsonObject {
	const projectDir = projectDirectory(projectsRootDir, sessionId, String(metadata.title || ""));
	mkdirSync(projectDir, { recursive: true });
	const artifacts = extractArtifactsFromMessages(sessionData.messages);
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
	const allowedFiles = new Set<string>();
	for (const [filename, content] of Object.entries(artifacts)) {
		const relativePath = safeRelativeArtifactPath(filename);
		const targetPath = resolve(projectDir, relativePath);
		assertInside(projectDir, targetPath);
		mkdirSync(dirname(targetPath), { recursive: true });
		writeFileSync(targetPath, content, "utf8");
		allowedFiles.add(targetPath);
	}

	for (const file of listFiles(projectDir)) {
		if (!allowedFiles.has(file)) rmSync(file, { force: true });
	}
	pruneEmptyDirectories(projectDir);
}

function safeRelativeArtifactPath(filename: string): string {
	const parts = filename
		.replace(/\\/g, "/")
		.split("/")
		.map((part) => sanitizePathComponent(part))
		.filter(Boolean);
	if (parts.length === 0) throw new Error("Artifact filename is empty.");
	return join(...parts);
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

function listFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const result: string[] = [];
	for (const name of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, name.name);
		if (name.isDirectory()) result.push(...listFiles(path));
		if (name.isFile()) result.push(path);
	}
	return result;
}

function countFiles(root: string): number {
	return listFiles(root).length;
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
