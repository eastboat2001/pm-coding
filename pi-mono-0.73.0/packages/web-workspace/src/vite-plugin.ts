import { once } from "node:events";
import { mkdirSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { Connect, Plugin } from "vite";
import { AgentV2RunApiError, AgentV2RunApiService, type AgentV2StartRunRequest } from "./agent-v2-run-api-service.js";
import { type AgentV2RunEventBus, RedisAgentV2RunEventBus } from "./agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import { type AgentV2RunQueue, createRedisAgentV2RunQueue } from "./agent-v2-run-queue.js";
import type { AgentV2RunEventRecord } from "./agent-v2-store.js";
import { normalizeClientId, readClientIdHeader } from "./client-id.js";
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
import { type DiagnosticArchiveExport, WorkspaceDiagnosticExportService } from "./diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { isObject, readJsonBody, sendJson, sendPrettyJson } from "./json.js";
import type { AgentV2SchemaStore } from "./agent-v2-runtime-store.js";
import { createRuntimeStore } from "./runtime-store-factory.js";
import type {
	DiagnosticLogEventInput,
	DiagnosticLogQuery,
	DiagnosticLogWriteRequest,
	JsonObject,
	ProjectFilePreviewRequest,
	ProjectFileRequest,
	ProjectFileSaveRequest,
	ProjectPreviewRenameRequest,
	ProjectRequestContext,
	ProjectTaskRequest,
	RuntimeRunEventRecord,
	SkillLoadRequest,
	SkillResourceRequest,
	StorageConfig,
} from "./types.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { sanitizePathComponent } from "./workspace-paths.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceSessionService } from "./workspace-session-service.js";
import { WorkspaceSkillService } from "./workspace-skill-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

const EMPTY_RUN_EVENT_READ_BACKOFF_MS = 100;
const LIVE_MESSAGE_UPDATE_MIN_INTERVAL_MS = 250;
const PROJECT_BATCH_SUMMARY_LIMIT = 200;
const AGENT_V2_RUNS_API_PREFIX = "/api/agent-v2/runs";

type RetiredApplicationGenerationRoute = { status: 404 | 410; error: string };

export interface ConfiguredStoragePluginTestServices {
	config: StorageConfig;
	diagnostics: WorkspaceDiagnosticLogService;
	sessions: WorkspaceSessionService;
	files: WorkspaceFileService;
	previews: WorkspacePreviewService;
	tasks: WorkspaceTaskService;
	skills: WorkspaceSkillService;
	runtimeDb: AgentV2SchemaStore;
	diagnosticExports: WorkspaceDiagnosticExportService;
	agentV2RunApi?: AgentV2RunApiService;
	agentV2RunEventBus?: AgentV2RunEventBus;
	agentV2RunEventLog?: Pick<AgentV2RunEventLog, "list">;
	agentV2RunQueue?: AgentV2RunQueue;
}

export function configuredStoragePlugin(envFile?: string): Plugin {
	const rootDir = process.cwd();
	const config = loadStorageConfig(rootDir, envFile);
	const diagnostics = new WorkspaceDiagnosticLogService(config);
	const sessions = new WorkspaceSessionService(config);
	const files = new WorkspaceFileService(config);
	const previews = new WorkspacePreviewService(config, diagnostics);
	const tasks = new WorkspaceTaskService(config, previews, undefined, diagnostics);
	const skills = new WorkspaceSkillService(config, diagnostics);
	const runtimeDb = createRuntimeStore(config);
	const diagnosticExports = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
	const agentV2RunQueue = createRedisAgentV2RunQueue({
		redisUrl: config.redisUrl,
		queueName: config.agentV2RunQueueName,
	});
	const agentV2RunEventBus = new RedisAgentV2RunEventBus({
		redisUrl: config.redisUrl,
		maxLen: config.agentV2RunEventStreamMaxLen,
		ttlSeconds: config.agentV2RunEventStreamTtlSeconds,
	});
	const agentV2RunEventLog = new AgentV2RunEventLog({ store: runtimeDb, bus: agentV2RunEventBus });
	const agentV2RunApi = new AgentV2RunApiService({
		store: runtimeDb,
		queue: agentV2RunQueue,
		events: agentV2RunEventLog,
	});
	return createConfiguredStoragePlugin({
		config,
		diagnostics,
		sessions,
		files,
		previews,
		tasks,
		skills,
		runtimeDb,
		diagnosticExports,
		agentV2RunApi,
		agentV2RunEventBus,
		agentV2RunEventLog,
		agentV2RunQueue,
	});
}

export function createConfiguredStoragePluginForTest(services: ConfiguredStoragePluginTestServices): Plugin {
	return createConfiguredStoragePlugin(services);
}

function createConfiguredStoragePlugin({
	config,
	diagnostics,
	sessions,
	files,
	previews,
	tasks,
	skills,
	runtimeDb,
	diagnosticExports,
	agentV2RunApi,
	agentV2RunEventBus,
	agentV2RunEventLog,
	agentV2RunQueue,
}: ConfiguredStoragePluginTestServices): Plugin {
	let startupDiagnosticsWritten = false;
	let storageDirsReady = false;
	let storageDirsPromise: Promise<void> | undefined;

	const ensureStorageDirs = async () => {
		if (storageDirsReady) return;
		storageDirsPromise ??= (async () => {
			sessions.ensureDirs();
			mkdirSync(dirname(config.settingsFile), { recursive: true });
			mkdirSync(config.skillsDir, { recursive: true });
			mkdirSync(config.defaultSkillsDir, { recursive: true });
			diagnostics.ensureDirs();
			await runtimeDb.ensureAgentV2Schema();
			writeStartupDiagnosticsOnce();
			storageDirsReady = true;
		})().catch((error) => {
			storageDirsPromise = undefined;
			throw error;
		});
		await storageDirsPromise;
	};

	const writeStartupDiagnosticsOnce = () => {
		if (startupDiagnosticsWritten) return;
		startupDiagnosticsWritten = true;
		diagnostics.writeEvents({ events: createStartupDiagnosticEvents(config) });
	};

	const handler: Connect.NextHandleFunction = async (req, res, next) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		const retiredRoute = retiredApplicationGenerationRoute(url.pathname);
		if (retiredRoute) {
			sendJson(res, { error: retiredRoute.error }, retiredRoute.status);
			return;
		}

		if (req.url?.startsWith(PREVIEW_PREFIX)) {
			try {
				await ensureStorageDirs();
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
			!req.url?.startsWith(RUNS_API_PREFIX) &&
			!req.url?.startsWith(AGENT_V2_RUNS_API_PREFIX)
		) {
			next();
			return;
		}

		try {
			await ensureStorageDirs();
			const isProjectsApi = url.pathname.startsWith(PROJECTS_API_PREFIX);
			const isSkillsApi = url.pathname.startsWith(SKILLS_API_PREFIX);
			const isLogsApi = url.pathname.startsWith(LOGS_API_PREFIX);
			const isSessionsApi = url.pathname.startsWith(SESSIONS_API_PREFIX);
			const isAgentV2RunsApi = url.pathname.startsWith(AGENT_V2_RUNS_API_PREFIX);
			const isRunsApi = url.pathname.startsWith(RUNS_API_PREFIX);
			const prefix = isProjectsApi
				? PROJECTS_API_PREFIX
				: isSkillsApi
					? SKILLS_API_PREFIX
					: isLogsApi
						? LOGS_API_PREFIX
						: isSessionsApi
							? SESSIONS_API_PREFIX
							: isAgentV2RunsApi
								? AGENT_V2_RUNS_API_PREFIX
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
				await handleLogsApi(method, route, url, req, res, config, diagnostics, diagnosticExports);
				return;
			}
			if (isSessionsApi) {
				sendJson(res, { error: "Application Generation Agent v1 runtime session routes have been removed." }, 410);
				return;
			}
			if (isAgentV2RunsApi) {
				await handleAgentV2RuntimeRunsApi(
					method,
					route,
					url,
					req,
					res,
					requireAgentV2RunApi(agentV2RunApi),
					requireAgentV2RunEventBus(agentV2RunEventBus),
					requireAgentV2RunEventLog(agentV2RunEventLog),
				);
				return;
			}
			await handleStorageApi(method, route, req, res, config, sessions);
		} catch (error) {
			sendRuntimeApiError(res, error);
		}
	};
	let runEventBusClosePromise: Promise<void> | undefined;
	const closeRunEventBusOnce = (): Promise<void> => {
		runEventBusClosePromise ??= Promise.all([
			Promise.resolve(agentV2RunEventBus?.close()).catch(() => undefined),
			Promise.resolve(agentV2RunQueue?.close()).catch(() => undefined),
		]).then(() => undefined);
		return runEventBusClosePromise;
	};
	const registerRunEventBusCleanup = (server: {
		httpServer?: { once?: (event: "close", listener: () => void) => unknown } | null;
	}): void => {
		server.httpServer?.once?.("close", () => {
			void closeRunEventBusOnce();
		});
	};
	const startStorageInitialization = (): void => {
		void ensureStorageDirs().catch(() => undefined);
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
			registerRunEventBusCleanup(server);
			startStorageInitialization();
			server.middlewares.use(handler);
		},
		configurePreviewServer(server) {
			registerRunEventBusCleanup(server);
			startStorageInitialization();
			server.middlewares.use(handler);
		},
	};
}

export function createStartupDiagnosticEvents(config: StorageConfig): DiagnosticLogEventInput[] {
	const events: DiagnosticLogEventInput[] = [
		{
			level: "info",
			category: "system",
			eventType: "system.startup.config",
			data: {
				envFile: config.envFile,
				envFileExists: config.envFileExists,
				runsEnabled: config.runsEnabled,
				redisUrl: redactConnectionUrl(config.redisUrl),
				agentV2RunQueueName: config.agentV2RunQueueName,
				runtimeDbFile: config.runtimeDbFile,
				clientsRootDir: config.clientsRootDir,
				workerId: config.workerId,
				workerConcurrency: config.workerConcurrency,
				runMaxAgentTurns: config.runMaxAgentTurns,
				runMaxAgentToolExecutions: config.runMaxAgentToolExecutions,
				runRetryMaxAttempts: config.runRetryMaxAttempts,
				runRetryBaseDelayMs: config.runRetryBaseDelayMs,
				runRetryMaxDelayMs: config.runRetryMaxDelayMs,
				runRetryJitterRatio: config.runRetryJitterRatio,
				clientIdRequired: config.clientIdRequired,
				loggingEnabled: config.loggingEnabled,
				logStdoutEnabled: config.logStdoutEnabled,
				logsDbFile: config.logsDbFile,
				modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
				modelMaxOutputTokens: config.modelMaxOutputTokens,
				contextProviderPayloadBudgetChars: config.contextProviderPayloadBudgetChars,
			},
		},
	];

	if (config.envFile && !config.envFileExists) {
		events.push({
			level: "warn",
			category: "system",
			eventType: "system.config.env_missing",
			data: {
				envFile: config.envFile,
				message: "PI configuration file was not found; defaults are in use.",
			},
		});
	}

	return events;
}

function storageWatchIgnoredPaths(config: StorageConfig): string[] {
	return [
		`${normalizeWatchPath(config.clientsRootDir)}/**`,
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
	const clientId = readConfiguredApiClientId(req, config);

	if (method === "GET" && (route === "/" || route === "")) {
		sendJson(res, previews.listProjects(req, clientId));
		return;
	}
	if (method === "POST" && route === "/batch-summary") {
		const body = await readJsonBody(req);
		const summaries = normalizeBatchSummarySessions(body).map((session) => {
			const summary = files.listProjectFiles(
				withClientId(session as unknown as JsonObject, clientId) as unknown as ProjectRequestContext,
			);
			return {
				projectId: summary.projectId,
				sessionId: summary.sessionId,
				title: summary.title,
				fileCount: summary.fileCount,
			};
		});
		sendJson(res, { summaries });
		return;
	}
	if (method === "POST" && route === "/workspace/files") {
		const body = withClientId(await readJsonBody(req), clientId);
		sendJson(res, files.listProjectFiles(body as unknown as ProjectRequestContext));
		return;
	}
	if (method === "POST" && route === "/workspace/file-preview") {
		const body = withClientId(await readJsonBody(req), clientId);
		sendJson(res, files.readProjectFilePreview(body as unknown as ProjectFilePreviewRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/file-save") {
		const body = withClientId(await readJsonBody(req), clientId);
		sendJson(res, files.saveProjectFile(body as unknown as ProjectFileSaveRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/file") {
		const body = withClientId(await readJsonBody(req), clientId);
		sendJson(res, files.handle(body as unknown as ProjectFileRequest));
		return;
	}
	if (method === "POST" && route === "/workspace/task") {
		const body = withClientId(await readJsonBody(req), clientId);
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
		const body = withClientId(await readJsonBody(req), clientId);
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
				clientId,
			),
		);
		return;
	}
	const logsMatch = route.match(/^\/([^/]+)\/logs$/);
	if (method === "GET" && logsMatch) {
		sendJson(res, previews.readProjectLogs(decodeURIComponent(logsMatch[1]), clientId));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

function normalizeBatchSummarySessions(body: JsonObject): ProjectRequestContext[] {
	const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
	const sessions: ProjectRequestContext[] = [];
	const seen = new Set<string>();
	for (const rawSession of rawSessions) {
		if (sessions.length >= PROJECT_BATCH_SUMMARY_LIMIT) break;
		if (!isObject(rawSession)) continue;
		const sessionId = typeof rawSession.sessionId === "string" ? rawSession.sessionId.trim() : "";
		if (!sessionId || !sanitizePathComponent(sessionId) || seen.has(sessionId)) continue;
		seen.add(sessionId);
		const title = typeof rawSession.title === "string" ? rawSession.title.trim() : "";
		sessions.push({ sessionId, title });
	}
	return sessions;
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
			settingsFile: config.settingsFile,
			clientsRootDir: config.clientsRootDir,
			skillsDir: config.skillsDir,
			defaultSkillsDir: config.defaultSkillsDir,
			previewBaseUrl: config.previewBaseUrl,
			defaultModelProvider: config.defaultModelProvider,
			defaultModelId: config.defaultModelId,
			handoffDefaultThinkingLevel: config.handoffDefaultThinkingLevel,
			envFile: config.envFile,
			envFileExists: config.envFileExists,
			runtimeDbFile: config.runtimeDbFile,
			runsEnabled: config.runsEnabled,
			redisUrl: redactConnectionUrl(config.redisUrl),
			workerId: config.workerId,
			workerConcurrency: config.workerConcurrency,
			agentV2RunQueueName: config.agentV2RunQueueName,
			runEventRetentionDays: config.runEventRetentionDays,
			runRetryMaxAttempts: config.runRetryMaxAttempts,
			runRetryBaseDelayMs: config.runRetryBaseDelayMs,
			runRetryMaxDelayMs: config.runRetryMaxDelayMs,
			runRetryJitterRatio: config.runRetryJitterRatio,
			clientIdRequired: config.clientIdRequired,
			logsDbFile: config.logsDbFile,
			loggingEnabled: config.loggingEnabled,
			logStdoutEnabled: config.logStdoutEnabled,
			rawProviderLoggingEnabled: config.rawProviderLoggingEnabled,
			rawProviderLogMaxChars: config.rawProviderLogMaxChars,
			promptSnapshotLoggingEnabled: config.promptSnapshotLoggingEnabled,
			promptSnapshotMaxChars: config.promptSnapshotMaxChars,
			modelOutputSnapshotLoggingEnabled: config.modelOutputSnapshotLoggingEnabled,
			modelOutputSnapshotMaxChars: config.modelOutputSnapshotMaxChars,
			modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
			modelMaxOutputTokens: config.modelMaxOutputTokens,
			contextProviderPayloadBudgetChars: config.contextProviderPayloadBudgetChars,
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
	const clientId = readConfiguredApiClientId(req, config);
	if (route === "/settings") {
		if (method === "GET") {
			const settings = sessions.readSettings(clientId);
			sendJson(res, settings || { error: "Settings not found." }, settings ? 200 : 404);
			return;
		}
		if (method === "PUT") {
			const body = await readJsonBody(req);
			sendJson(res, sessions.writeSettings(body, clientId));
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
	config: StorageConfig,
	diagnostics: WorkspaceDiagnosticLogService,
	diagnosticExports: WorkspaceDiagnosticExportService,
): Promise<void> {
	if (method === "GET" && route === "/status") {
		sendJson(res, diagnostics.status());
		return;
	}
	if ((method === "GET" || method === "HEAD") && route === "/export") {
		const clientId = readDiagnosticExportClientId(req, url, config);
		const sessionId = queryString(url, "sessionId");
		const runId = queryString(url, "runId");
		if (!sessionId && !runId) {
			sendJson(res, { error: "Query parameter `sessionId` or `runId` is required." }, 400);
			return;
		}
		if (queryString(url, "format") !== "json") {
			const archive = await diagnosticExports.exportArchive({
				clientId: clientId ?? "",
				sessionId,
				runId,
				includeSettings: url.searchParams.has("includeSettings") ? queryBoolean(url, "includeSettings") : true,
				maxDiagnosticEvents: queryNumber(url, "maxDiagnosticEvents"),
			});
			if (method === "HEAD") {
				sendDiagnosticArchiveHead(res, archive);
				return;
			}
			await sendDiagnosticArchive(res, archive);
			return;
		}
		const payload = await diagnosticExports.export({
			clientId: clientId ?? "",
			sessionId,
			runId,
			includeSettings: url.searchParams.has("includeSettings") ? queryBoolean(url, "includeSettings") : true,
			maxDiagnosticEvents: queryNumber(url, "maxDiagnosticEvents"),
		});
		res.setHeader("Content-Disposition", `attachment; filename="${diagnosticExportFilename(sessionId, runId)}"`);
		if (method === "HEAD") {
			res.statusCode = 200;
			res.end();
			return;
		}
		sendPrettyJson(res, payload);
		return;
	}
	const clientId = readConfiguredApiClientId(req, config);
	if (method === "POST" && route === "/events") {
		const body = await readJsonBody(req);
		sendJson(res, diagnostics.writeEvents(withDiagnosticClientId(body, clientId) as DiagnosticLogWriteRequest));
		return;
	}
	if (method === "GET" && route === "/events") {
		sendJson(res, diagnostics.queryEvents(withClientId(toDiagnosticLogQuery(url), clientId)));
		return;
	}
	sendJson(res, { error: "Not found." }, 404);
}

function sendDiagnosticArchiveHead(res: ServerResponse, archive: DiagnosticArchiveExport): void {
	res.statusCode = 200;
	res.setHeader("Content-Type", archive.contentType);
	res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
	res.end();
}

async function sendDiagnosticArchive(res: ServerResponse, archive: DiagnosticArchiveExport): Promise<void> {
	res.statusCode = 200;
	res.setHeader("Content-Type", archive.contentType);
	res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
	for await (const chunk of archive.stream()) {
		if (!res.write(chunk)) {
			await once(res, "drain");
		}
	}
	res.end();
}

function readDiagnosticExportClientId(
	req: Connect.IncomingMessage,
	url: URL,
	config: StorageConfig,
): string | undefined {
	const headerValue = req.headers["x-pi-client-id"];
	if (headerValue !== undefined) return normalizeClientId(Array.isArray(headerValue) ? headerValue[0] : headerValue);
	const queryClientId = queryString(url, "clientId");
	if (queryClientId) return normalizeClientId(queryClientId);
	if (config.clientIdRequired) return readClientIdHeader(req);
	return undefined;
}

function readConfiguredApiClientId(req: Connect.IncomingMessage, config: StorageConfig): string | undefined {
	if (config.clientIdRequired) return readClientIdHeader(req);
	const value = req.headers["x-pi-client-id"];
	if (value === undefined) return undefined;
	return normalizeClientId(Array.isArray(value) ? value[0] : value);
}

function withClientId<T extends JsonObject>(body: T, clientId: string | undefined): T {
	return clientId ? ({ ...body, clientId } as T) : body;
}

function withDiagnosticClientId(body: JsonObject, clientId: string | undefined): JsonObject {
	if (!clientId) return body;
	return {
		...body,
		events: Array.isArray(body.events)
			? body.events.map((event: unknown) =>
					isObject(event)
						? { ...event, clientId, data: isObject(event.data) ? { ...event.data, clientId } : { clientId } }
						: event,
				)
			: body.events,
	};
}

function requireAgentV2RunApi(agentV2RunApi: AgentV2RunApiService | undefined): AgentV2RunApiService {
	if (!agentV2RunApi) throw new AgentV2RunApiError("Agent v2 run API service is not configured.", 503);
	return agentV2RunApi;
}

function requireAgentV2RunEventBus(agentV2RunEventBus: AgentV2RunEventBus | undefined): AgentV2RunEventBus {
	if (!agentV2RunEventBus) throw new AgentV2RunApiError("Agent v2 run event bus is not configured.", 503);
	return agentV2RunEventBus;
}

function requireAgentV2RunEventLog(
	agentV2RunEventLog: Pick<AgentV2RunEventLog, "list"> | undefined,
): Pick<AgentV2RunEventLog, "list"> {
	if (!agentV2RunEventLog) throw new AgentV2RunApiError("Agent v2 run event log is not configured.", 503);
	return agentV2RunEventLog;
}

async function handleAgentV2RuntimeRunsApi(
	method: string,
	route: string,
	url: URL,
	req: Connect.IncomingMessage,
	res: ServerResponse,
	agentV2RunApi: AgentV2RunApiService,
	agentV2RunEventBus: AgentV2RunEventBus,
	runEventLog: Pick<AgentV2RunEventLog, "list">,
): Promise<void> {
	try {
		const clientId = readClientIdHeader(req);
		if (method === "POST" && route === "/start") {
			const body = await readJsonBody(req);
			sendJson(
				res,
				(await agentV2RunApi.startRun(clientId, body as unknown as AgentV2StartRunRequest)) as unknown as JsonObject,
			);
			return;
		}
		if (method === "GET" && (route === "/" || route === "")) {
			sendJson(res, { runs: await agentV2RunApi.listRuns(clientId) });
			return;
		}

		const eventsMatch = route.match(/^\/([^/]+)\/events$/);
		if (method === "GET" && eventsMatch) {
			const runId = decodeURIComponent(eventsMatch[1]);
			const afterSeq = queryNumber(url, "afterSeq") ?? 0;
			if (wantsEventStream(req, url)) {
				await streamAgentV2RunEvents(
					res,
					req,
					agentV2RunApi,
					agentV2RunEventBus,
					runEventLog,
					clientId,
					runId,
					afterSeq,
				);
				return;
			}
			const run = await agentV2RunApi.getRun(clientId, runId);
			if (!run) throw new AgentV2RunApiError("Agent v2 run not found.", 404);
			sendJson(res, { events: await agentV2RunApi.listRunEvents(clientId, runId, afterSeq) });
			return;
		}

		const cancelMatch = route.match(/^\/([^/]+)\/cancel$/);
		if (method === "POST" && cancelMatch) {
			sendJson(
				res,
				(await agentV2RunApi.cancelRun(clientId, decodeURIComponent(cancelMatch[1]))) as unknown as JsonObject,
			);
			return;
		}

		const runMatch = route.match(/^\/([^/]+)$/);
		if (method === "GET" && runMatch) {
			const run = await agentV2RunApi.getRun(clientId, decodeURIComponent(runMatch[1]));
			sendJson(res, (run || { error: "Agent v2 run not found." }) as unknown as JsonObject, run ? 200 : 404);
			return;
		}

		sendJson(res, { error: "Not found." }, 404);
	} catch (error) {
		sendRuntimeApiError(res, error);
	}
}

function retiredApplicationGenerationRoute(pathname: string): RetiredApplicationGenerationRoute | undefined {
	if (pathname.startsWith("/api/runtime/runs/goals/app-preview")) {
		return { status: 404, error: "Legacy app-preview-goal routes have been removed." };
	}
	if (["/api/runtime/runs", "/api/pi-runs", "/api/runs"].some((prefix) => pathname.startsWith(prefix))) {
		return { status: 410, error: "Application Generation Agent v1 runtime routes have been removed." };
	}
	if (pathname.startsWith("/api/pi-sessions")) {
		return { status: 410, error: "Application Generation Agent v1 runtime session routes have been removed." };
	}
	return undefined;
}

function wantsEventStream(req: Connect.IncomingMessage, url: URL): boolean {
	if (queryBoolean(url, "stream")) return true;
	const accept = req.headers.accept;
	return Array.isArray(accept)
		? accept.some((value) => value.includes("text/event-stream"))
		: typeof accept === "string" && accept.includes("text/event-stream");
}

async function streamAgentV2RunEvents(
	res: ServerResponse,
	req: Connect.IncomingMessage,
	agentV2RunApi: AgentV2RunApiService,
	agentV2RunEventBus: AgentV2RunEventBus,
	runEventLog: Pick<AgentV2RunEventLog, "list">,
	clientId: string,
	runId: string,
	afterSeq: number,
): Promise<void> {
	let readSeq = afterSeq;
	let sentSeq = afterSeq;
	let closed = false;
	let heartbeatAt = Date.now();
	let streamStarted = false;
	const abortController = new AbortController();

	const closeStream = (): void => {
		if (closed) return;
		closed = true;
		if (!abortController.signal.aborted) abortController.abort();
	};

	req.on("close", closeStream);
	const responseWithOn = res as ServerResponse & {
		on?: (event: "close", listener: () => void) => ServerResponse;
		off?: (event: "close", listener: () => void) => ServerResponse;
	};
	if (typeof responseWithOn.on === "function") responseWithOn.on("close", closeStream);

	try {
		const run = await agentV2RunApi.getRun(clientId, runId);
		if (!run) throw new AgentV2RunApiError("Agent v2 run not found.", 404);
		const durableEvents = await runEventLog.list(clientId, runId, afterSeq);
		if (closed || res.destroyed) return;

		res.statusCode = 200;
		res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache, no-store, no-transform, must-revalidate");
		res.setHeader("Connection", "keep-alive");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders?.();
		streamStarted = true;
		res.write(": connected\n\n");

		for (const event of durableEvents) {
			readSeq = Math.max(readSeq, event.seq);
			if (!writeRunEventIfFresh(res, event, sentSeq)) continue;
			sentSeq = event.seq;
		}

		while (!closed && !res.destroyed) {
			const events = await agentV2RunEventBus.read({
				clientId,
				runId,
				afterSeq: readSeq,
				blockMs: 15000,
				signal: abortController.signal,
			});
			for (const event of events) readSeq = Math.max(readSeq, event.seq);
			if (closed || res.destroyed) break;
			if (events.length === 0) {
				heartbeatAt = writeHeartbeatIfDue(res, heartbeatAt);
				await waitForRunEventReadBackoff(abortController.signal, EMPTY_RUN_EVENT_READ_BACKOFF_MS);
				continue;
			}
			for (const event of events) {
				if (!writeRunEventIfFresh(res, event, sentSeq)) continue;
				sentSeq = event.seq;
			}
			heartbeatAt = writeHeartbeatIfDue(res, heartbeatAt);
		}
	} catch (error) {
		if (!streamStarted) throw error;
		if (!closed && !res.destroyed) {
			writeServerSentError(res, "Agent v2 runtime event stream unavailable.");
			res.end();
		}
		closeStream();
	} finally {
		req.off?.("close", closeStream);
		if (typeof responseWithOn.off === "function") responseWithOn.off("close", closeStream);
	}
}

function writeRunEventIfFresh(
	res: ServerResponse,
	event: RuntimeRunEventRecord | AgentV2RunEventRecord,
	lastSeq: number,
): boolean {
	if (event.seq <= lastSeq) return false;
	writeServerSentRunEvent(res, event);
	return true;
}

function writeHeartbeatIfDue(res: ServerResponse, heartbeatAt: number): number {
	const now = Date.now();
	if (now - heartbeatAt > 15000) {
		res.write(": keep-alive\n\n");
		return now;
	}
	return heartbeatAt;
}

function waitForRunEventReadBackoff(signal: AbortSignal, delayMs: number): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		let timeout: NodeJS.Timeout | undefined;
		const done = () => {
			if (timeout !== undefined) clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		};
		timeout = setTimeout(done, delayMs);
		signal.addEventListener("abort", done, { once: true });
	});
}

function writeServerSentRunEvent(res: ServerResponse, event: RuntimeRunEventRecord | AgentV2RunEventRecord): void {
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeServerSentError(res: ServerResponse, message: string): void {
	res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
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

function diagnosticExportFilename(sessionId: string | undefined, runId: string | undefined): string {
	const id = sanitizeFilenamePart(runId ?? sessionId ?? "logs");
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return `pi-diagnostics-${id}-${timestamp}.json`;
}

function sanitizeFilenamePart(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "logs";
}

function computedLangfuseOtelEndpoint(host: string): string {
	return host ? `${host}/api/public/otel/v1/traces` : "";
}

function redactConnectionUrl(value: string): string {
	try {
		const url = new URL(value);
		const credentials = url.username || url.password ? "[redacted]@" : "";
		const path = url.pathname === "/" ? "" : url.pathname;
		return `${url.protocol}//${credentials}${url.host}${path}${url.search}${url.hash}`;
	} catch {
		return value;
	}
}

function sendRuntimeApiError(res: ServerResponse, error: unknown): void {
	if (error instanceof AgentV2RunApiError) {
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
