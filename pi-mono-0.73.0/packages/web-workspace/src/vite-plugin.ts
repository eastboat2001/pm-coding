import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Connect, Plugin } from "vite";
import { loadStorageConfig } from "./config.js";
import { API_PREFIX, LOGS_API_PREFIX, PREVIEW_PREFIX, PROJECTS_API_PREFIX, SKILLS_API_PREFIX } from "./constants.js";
import { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { isObject, readJsonBody, sendJson } from "./json.js";
import type {
	DiagnosticLogQuery,
	DiagnosticLogWriteRequest,
	ProjectFilePreviewRequest,
	ProjectFileRequest,
	ProjectFileSaveRequest,
	ProjectPreviewRenameRequest,
	ProjectRequestContext,
	ProjectTaskRequest,
	SkillLoadRequest,
	SkillResourceRequest,
	StorageConfig,
} from "./types.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceSessionService } from "./workspace-session-service.js";
import { WorkspaceSkillService } from "./workspace-skill-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

export function configuredStoragePlugin(envFile?: string): Plugin {
	const rootDir = process.cwd();
	const config = loadStorageConfig(rootDir, envFile);
	const diagnostics = new WorkspaceDiagnosticLogService(config);
	const sessions = new WorkspaceSessionService(config);
	const files = new WorkspaceFileService(config);
	const previews = new WorkspacePreviewService(config, diagnostics);
	const tasks = new WorkspaceTaskService(config, previews, undefined, diagnostics);
	const skills = new WorkspaceSkillService(config, diagnostics);

	const ensureStorageDirs = () => {
		sessions.ensureDirs();
		mkdirSync(dirname(config.settingsFile), { recursive: true });
		mkdirSync(config.skillsDir, { recursive: true });
		mkdirSync(config.defaultSkillsDir, { recursive: true });
		diagnostics.ensureDirs();
	};

	const handler: Connect.NextHandleFunction = async (req, res, next) => {
		if (req.url?.startsWith(PREVIEW_PREFIX)) {
			try {
				ensureStorageDirs();
				if (previews.servePreviewRequest(req, res)) return;
			} catch (error) {
				sendJson(res, { error: errorMessage(error) }, 500);
				return;
			}
		}

		if (
			!req.url?.startsWith(API_PREFIX) &&
			!req.url?.startsWith(PROJECTS_API_PREFIX) &&
			!req.url?.startsWith(SKILLS_API_PREFIX) &&
			!req.url?.startsWith(LOGS_API_PREFIX)
		) {
			next();
			return;
		}

		try {
			ensureStorageDirs();
			const url = new URL(req.url, "http://localhost");
			const isProjectsApi = url.pathname.startsWith(PROJECTS_API_PREFIX);
			const isSkillsApi = url.pathname.startsWith(SKILLS_API_PREFIX);
			const isLogsApi = url.pathname.startsWith(LOGS_API_PREFIX);
			const prefix = isProjectsApi
				? PROJECTS_API_PREFIX
				: isSkillsApi
					? SKILLS_API_PREFIX
					: isLogsApi
						? LOGS_API_PREFIX
						: API_PREFIX;
			const route = url.pathname.slice(prefix.length) || "/";
			const method = req.method || "GET";

			if (isProjectsApi) {
				await handleProjectsApi(method, route, req, res, files, previews, tasks);
				return;
			}
			if (isSkillsApi) {
				await handleSkillsApi(method, route, req, res, skills);
				return;
			}
			if (isLogsApi) {
				await handleLogsApi(method, route, url, req, res, diagnostics);
				return;
			}

			await handleStorageApi(method, route, req, res, config, sessions);
		} catch (error) {
			sendJson(res, { error: errorMessage(error) }, 500);
		}
	};

	return {
		name: "pi-web-ui-configured-storage",
		config() {
			return {
				server: {
					watch: {
						ignored: storageWatchIgnoredPaths(config),
					},
				},
			};
		},
		configureServer(server) {
			server.middlewares.use(handler);
		},
		configurePreviewServer(server) {
			server.middlewares.use(handler);
		},
	};
}

function storageWatchIgnoredPaths(config: StorageConfig): string[] {
	return [
		`${normalizeWatchPath(config.sessionsDir)}/**`,
		`${normalizeWatchPath(config.projectsRootDir)}/**`,
		`${normalizeWatchPath(config.skillsDir)}/**`,
		`${normalizeWatchPath(config.defaultSkillsDir)}/**`,
		normalizeWatchPath(config.logsDbFile),
		normalizeWatchPath(config.settingsFile),
	];
}

function normalizeWatchPath(path: string): string {
	return path.replace(/\\/g, "/");
}

async function handleSkillsApi(
	method: string,
	route: string,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	skills: WorkspaceSkillService,
): Promise<void> {
	if (method === "GET" && (route === "/" || route === "")) {
		sendJson(res, skills.list());
		return;
	}
	if (method === "POST" && route === "/load") {
		const body = await readJsonBody(req);
		sendJson(res, skills.load(body as SkillLoadRequest));
		return;
	}
	if (method === "POST" && route === "/resource") {
		const body = await readJsonBody(req);
		sendJson(res, skills.readResource(body as SkillResourceRequest));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

async function handleProjectsApi(
	method: string,
	route: string,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	files: WorkspaceFileService,
	previews: WorkspacePreviewService,
	tasks: WorkspaceTaskService,
): Promise<void> {
	if (method === "GET" && (route === "/" || route === "")) {
		sendJson(res, previews.listProjects(req));
		return;
	}
	if (method === "POST" && route === "/workspace/files") {
		const body = await readJsonBody(req);
		sendJson(res, files.listProjectFiles(body as unknown as ProjectRequestContext));
		return;
	}
	if (method === "POST" && route === "/workspace/file-preview") {
		const body = await readJsonBody(req);
		sendJson(res, files.readProjectFilePreview(body as unknown as ProjectFilePreviewRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/file-save") {
		const body = await readJsonBody(req);
		sendJson(res, files.saveProjectFile(body as unknown as ProjectFileSaveRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/file") {
		const body = await readJsonBody(req);
		sendJson(res, files.handle(body as unknown as ProjectFileRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/task") {
		const body = await readJsonBody(req);
		sendJson(
			res,
			await tasks.run(
				{ ...body, task: String(body.task || ""), sessionId: String(body.sessionId || "") } as ProjectTaskRequest,
				req,
			),
		);
		return;
	}
	if (method === "POST" && route === "/workspace/preview") {
		const body = await readJsonBody(req);
		sendJson(res, await previews.preview({ ...body, sessionId: String(body.sessionId || "") }, req));
		return;
	}
	const renameMatch = route.match(/^\/([^/]+)$/);
	if (method === "PUT" && renameMatch) {
		const body = await readJsonBody(req);
		sendJson(
			res,
			previews.renameProject(
				decodeURIComponent(renameMatch[1]),
				String((body as ProjectPreviewRenameRequest).title || ""),
				req,
			),
		);
		return;
	}
	const logsMatch = route.match(/^\/([^/]+)\/logs$/);
	if (method === "GET" && logsMatch) {
		sendJson(res, previews.readProjectLogs(decodeURIComponent(logsMatch[1])));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

async function handleStorageApi(
	method: string,
	route: string,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	config: StorageConfig,
	sessions: WorkspaceSessionService,
): Promise<void> {
	if (method === "GET" && route === "/status") {
		sendJson(res, {
			configured: true,
			sessionsDir: config.sessionsDir,
			settingsFile: config.settingsFile,
			projectsRootDir: config.projectsRootDir,
			skillsDir: config.skillsDir,
			defaultSkillsDir: config.defaultSkillsDir,
			previewBaseUrl: config.previewBaseUrl,
			serverSessionSyncEnabled: config.serverSessionSyncEnabled,
			defaultModelProvider: config.defaultModelProvider,
			defaultModelId: config.defaultModelId,
			handoffDefaultThinkingLevel: config.handoffDefaultThinkingLevel,
			logsDbFile: config.logsDbFile,
			loggingEnabled: config.loggingEnabled,
			logStdoutEnabled: config.logStdoutEnabled,
			rawProviderLoggingEnabled: config.rawProviderLoggingEnabled,
			rawProviderLogMaxChars: config.rawProviderLogMaxChars,
			promptSnapshotLoggingEnabled: config.promptSnapshotLoggingEnabled,
			promptSnapshotMaxChars: config.promptSnapshotMaxChars,
			modelOutputSnapshotLoggingEnabled: config.modelOutputSnapshotLoggingEnabled,
			modelOutputSnapshotMaxChars: config.modelOutputSnapshotMaxChars,
			logRetentionDays: config.logRetentionDays,
			logMaxEvents: config.logMaxEvents,
			logCleanupIntervalMs: config.logCleanupIntervalMs,
			logVacuumIntervalMs: config.logVacuumIntervalMs,
			langfuseEnabled: config.langfuseEnabled,
			langfuseHost: config.langfuseHost,
			langfuseOtelEndpoint: config.langfuseOtelEndpoint || computedLangfuseOtelEndpoint(config.langfuseHost),
			langfuseConfigured: Boolean(
				(config.langfuseHost || config.langfuseOtelEndpoint) &&
					config.langfusePublicKey &&
					config.langfuseSecretKey,
			),
			langfuseFlushIntervalMs: config.langfuseFlushIntervalMs,
			langfuseBatchSize: config.langfuseBatchSize,
			langfuseExportPromptSnapshots: config.langfuseExportPromptSnapshots,
			langfuseExportRawChunks: config.langfuseExportRawChunks,
			langfuseExportModelOutputSnapshots: config.langfuseExportModelOutputSnapshots,
			otelServiceName: config.otelServiceName,
			otelDeploymentEnvironment: config.otelDeploymentEnvironment,
		});
		return;
	}
	if (method === "GET" && route === "/sessions") {
		sendJson(res, { sessions: sessions.listSessions() });
		return;
	}

	const sessionMatch = route.match(/^\/sessions\/([^/]+)$/);
	if (sessionMatch) {
		const sessionId = decodeURIComponent(sessionMatch[1]);
		if (method === "GET") {
			const record = sessions.readSession(sessionId);
			sendJson(res, record || { error: "Session not found." }, record ? 200 : 404);
			return;
		}
		if (method === "PUT") {
			const body = await readJsonBody(req);
			if (!isObject(body.data) || !isObject(body.metadata))
				throw new Error("Fields `data` and `metadata` are required.");
			sendJson(res, sessions.writeSession(sessionId, body.data, body.metadata));
			return;
		}
		if (method === "DELETE") {
			sendJson(res, { deleted: sessions.deleteSession(sessionId) });
			return;
		}
	}

	if (route === "/settings") {
		if (method === "GET") {
			const settings = sessions.readSettings();
			sendJson(res, settings || { error: "Settings not found." }, settings ? 200 : 404);
			return;
		}
		if (method === "PUT") {
			const body = await readJsonBody(req);
			sendJson(res, sessions.writeSettings(body));
			return;
		}
	}

	sendJson(res, { error: "Not found." }, 404);
}

async function handleLogsApi(
	method: string,
	route: string,
	url: URL,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	diagnostics: WorkspaceDiagnosticLogService,
): Promise<void> {
	if (method === "GET" && route === "/status") {
		sendJson(res, diagnostics.status());
		return;
	}
	if (method === "POST" && route === "/events") {
		const body = await readJsonBody(req);
		sendJson(res, diagnostics.writeEvents(body as DiagnosticLogWriteRequest));
		return;
	}
	if (method === "GET" && route === "/events") {
		sendJson(res, diagnostics.queryEvents(toDiagnosticLogQuery(url)));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

function toDiagnosticLogQuery(url: URL): DiagnosticLogQuery {
	return {
		sessionId: queryString(url, "sessionId"),
		traceId: queryString(url, "traceId"),
		level: queryString(url, "level") as DiagnosticLogQuery["level"],
		category: queryString(url, "category") as DiagnosticLogQuery["category"],
		eventType: queryString(url, "eventType"),
		limit: queryNumber(url, "limit"),
	};
}

function queryString(url: URL, key: string): string | undefined {
	const value = url.searchParams.get(key);
	return value?.trim() || undefined;
}

function queryNumber(url: URL, key: string): number | undefined {
	const value = url.searchParams.get(key);
	if (!value) return undefined;
	const number = Number(value);
	return Number.isFinite(number) ? number : undefined;
}

function computedLangfuseOtelEndpoint(host: string): string {
	return host ? `${host}/api/public/otel/v1/traces` : "";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
