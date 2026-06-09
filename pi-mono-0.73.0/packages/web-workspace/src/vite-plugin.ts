import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Connect, Plugin } from "vite";
import { readClientIdHeader } from "./client-id.js";
import { loadStorageConfig } from "./config.js";
import {
	API_PREFIX,
	LOGS_API_PREFIX,
	PREVIEW_PREFIX,
	PROJECTS_API_PREFIX,
	RUNS_API_PREFIX,
	SESSIONS_API_PREFIX,
	SKILLS_API_PREFIX,
} from "./constants.js";
import { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { isObject, readJsonBody, sendJson } from "./json.js";
import { RunApiError, WorkspaceRunApiService } from "./run-api-service.js";
import { RedisRunQueue } from "./run-queue.js";
import { RuntimeDbStore } from "./runtime-db.js";
import type {
	DiagnosticLogQuery,
	DiagnosticLogWriteRequest,
	ProjectFilePreviewRequest,
	ProjectFileRequest,
	ProjectFileSaveRequest,
	ProjectPreviewRenameRequest,
	ProjectRequestContext,
	ProjectTaskRequest,
	RuntimeRunEventRecord,
	SkillLoadRequest,
	SkillResourceRequest,
	StartRunRequest,
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
	const runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
	const runQueue = new RedisRunQueue({ redisUrl: config.redisUrl, queueName: config.runQueueName });
	const runApi = new WorkspaceRunApiService(runtimeDb, runQueue);

	const ensureStorageDirs = () => {
		sessions.ensureDirs();
		mkdirSync(dirname(config.settingsFile), { recursive: true });
		mkdirSync(config.skillsDir, { recursive: true });
		mkdirSync(config.defaultSkillsDir, { recursive: true });
		diagnostics.ensureDirs();
		runtimeDb.ensureSchema();
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
			!req.url?.startsWith(LOGS_API_PREFIX) &&
			!req.url?.startsWith(SESSIONS_API_PREFIX) &&
			!req.url?.startsWith(RUNS_API_PREFIX)
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
			const isSessionsApi = url.pathname.startsWith(SESSIONS_API_PREFIX);
			const isRunsApi = url.pathname.startsWith(RUNS_API_PREFIX);
			const prefix = isProjectsApi
				? PROJECTS_API_PREFIX
				: isSkillsApi
					? SKILLS_API_PREFIX
					: isLogsApi
						? LOGS_API_PREFIX
						: isSessionsApi
							? SESSIONS_API_PREFIX
							: isRunsApi
								? RUNS_API_PREFIX
								: API_PREFIX;
			const route = url.pathname.slice(prefix.length) || "/";
			const method = req.method || "GET";

			if (isProjectsApi) {
				await handleProjectsApi(method, route, req, res, config, files, previews, tasks);
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
			if (isSessionsApi) {
				await handleRuntimeSessionsApi(method, route, url, req, res, runApi);
				return;
			}
			if (isRunsApi) {
				await handleRuntimeRunsApi(method, route, url, req, res, runApi);
				return;
			}

			await handleStorageApi(method, route, req, res, config, sessions);
		} catch (error) {
			sendRuntimeApiError(res, error);
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
		normalizeWatchPath(config.runtimeDbFile),
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
	config: StorageConfig,
	files: WorkspaceFileService,
	previews: WorkspacePreviewService,
	tasks: WorkspaceTaskService,
): Promise<void> {
	if (config.clientIdRequired) {
		readClientIdHeader(req);
	}

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

async function handleRuntimeSessionsApi(
	method: string,
	route: string,
	url: URL,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	runApi: WorkspaceRunApiService,
): Promise<void> {
	try {
		const clientId = readClientIdHeader(req);
		if (method === "GET" && (route === "/" || route === "")) {
			sendJson(res, { sessions: runApi.listSessions(clientId) });
			return;
		}

		const sessionMatch = route.match(/^\/([^/]+)$/);
		if (sessionMatch) {
			const sessionId = decodeURIComponent(sessionMatch[1]);
			if (method === "GET") {
				const detail = runApi.getSession(clientId, sessionId);
				sendJson(res, detail || { error: "Session not found." }, detail ? 200 : 404);
				return;
			}
			if (method === "DELETE") {
				sendJson(res, await runApi.deleteSession(clientId, sessionId, { force: queryBoolean(url, "force") }));
				return;
			}
		}
		sendJson(res, { error: "Not found." }, 404);
	} catch (error) {
		sendRuntimeApiError(res, error);
	}
}

async function handleRuntimeRunsApi(
	method: string,
	route: string,
	url: URL,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	runApi: WorkspaceRunApiService,
): Promise<void> {
	try {
		const clientId = readClientIdHeader(req);
		if (method === "POST" && (route === "/" || route === "" || route === "/start")) {
			const body = await readJsonBody(req);
			sendJson(res, await runApi.startRun(clientId, body as StartRunRequest));
			return;
		}
		if (method === "GET" && (route === "/" || route === "")) {
			sendJson(res, { runs: runApi.listRuns(clientId) });
			return;
		}

		const eventsMatch = route.match(/^\/([^/]+)\/events$/);
		if (method === "GET" && eventsMatch) {
			const runId = decodeURIComponent(eventsMatch[1]);
			const afterSeq = queryNumber(url, "afterSeq") ?? 0;
			if (wantsEventStream(req, url)) {
				streamRunEvents(res, req, runApi, clientId, runId, afterSeq);
				return;
			}
			sendJson(res, {
				events: runApi.listRunEvents(clientId, runId, afterSeq),
			});
			return;
		}

		const cancelMatch = route.match(/^\/([^/]+)\/cancel$/);
		if (method === "POST" && cancelMatch) {
			sendJson(res, await runApi.cancelRun(clientId, decodeURIComponent(cancelMatch[1])));
			return;
		}

		const statusMatch = route.match(/^\/([^/]+)\/status$/);
		if (method === "GET" && statusMatch) {
			const run = runApi.getRunStatus(clientId, decodeURIComponent(statusMatch[1]));
			sendJson(res, run || { error: "Run not found." }, run ? 200 : 404);
			return;
		}

		const runMatch = route.match(/^\/([^/]+)$/);
		if (method === "GET" && runMatch) {
			const run = runApi.getRunStatus(clientId, decodeURIComponent(runMatch[1]));
			sendJson(res, run || { error: "Run not found." }, run ? 200 : 404);
			return;
		}

		sendJson(res, { error: "Not found." }, 404);
	} catch (error) {
		sendRuntimeApiError(res, error);
	}
}

function wantsEventStream(req: Connect.IncomingMessage, url: URL): boolean {
	if (queryBoolean(url, "stream")) return true;
	const accept = req.headers.accept;
	return Array.isArray(accept)
		? accept.some((value) => value.includes("text/event-stream"))
		: typeof accept === "string" && accept.includes("text/event-stream");
}

function streamRunEvents(
	res: ServerResponse,
	req: Connect.IncomingMessage,
	runApi: WorkspaceRunApiService,
	clientId: string,
	runId: string,
	afterSeq: number,
): void {
	let lastSeq = afterSeq;
	let closed = false;
	let heartbeatAt = Date.now();
	let timer: ReturnType<typeof setInterval> | undefined;

	const closeStream = (): void => {
		if (closed) return;
		closed = true;
		if (timer !== undefined) clearInterval(timer);
	};

	res.statusCode = 200;
	res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
	res.setHeader("Connection", "keep-alive");
	res.flushHeaders?.();
	res.write(": connected\n\n");

	const sendEvents = (): void => {
		if (closed || res.destroyed) return;
		try {
			const events = runApi.listRunEvents(clientId, runId, lastSeq);
			for (const event of events) {
				if (closed || res.destroyed) return;
				writeServerSentRunEvent(res, event);
				lastSeq = Math.max(lastSeq, event.seq);
			}
			const now = Date.now();
			if (now - heartbeatAt > 15000) {
				res.write(": keep-alive\n\n");
				heartbeatAt = now;
			}
		} catch (error) {
			if (!res.destroyed) {
				res.write(`: ${errorMessage(error).replace(/\r?\n/g, " ")}\n\n`);
				res.end();
			}
			closeStream();
		}
	};

	sendEvents();
	if (!closed) {
		timer = setInterval(sendEvents, 100);
	}
	req.on("close", closeStream);
}

function writeServerSentRunEvent(res: ServerResponse, event: RuntimeRunEventRecord): void {
	res.write(`data: ${JSON.stringify(event)}\n\n`);
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

function queryBoolean(url: URL, key: string): boolean {
	const value = url.searchParams.get(key);
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function computedLangfuseOtelEndpoint(host: string): string {
	return host ? `${host}/api/public/otel/v1/traces` : "";
}

function sendRuntimeApiError(res: ServerResponse, error: unknown): void {
	if (error instanceof RunApiError) {
		sendJson(res, { error: error.message }, error.statusCode);
		return;
	}
	const message = errorMessage(error);
	if (message === "X-PI-Client-ID is required" || message === "Invalid X-PI-Client-ID") {
		sendJson(res, { error: message }, 401);
		return;
	}
	sendJson(res, { error: message }, 500);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
