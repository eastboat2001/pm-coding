import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAgentV2DiagnosticProjectionAdapters } from "./agent-v2-diagnostic-projections.js";
import { createAgentV2ShutdownDeadline, runAgentV2ShutdownSteps } from "./agent-v2-lifecycle.js";
import { AgentV2OutboxDispatcher } from "./agent-v2-outbox-dispatcher.js";
import { AgentV2Readiness, AgentV2ReadinessGate } from "./agent-v2-readiness.js";
import { AgentV2RunApiError, AgentV2RunApiService } from "./agent-v2-run-api-service.js";
import { RedisAgentV2RunEventBus } from "./agent-v2-run-event-bus.js";
import { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import { createRedisAgentV2RunQueue } from "./agent-v2-run-queue.js";
import { normalizeClientId, readClientIdHeader } from "./client-id.js";
import { loadStorageConfig } from "./config.js";
import { API_PREFIX, LOGS_API_PREFIX, PREVIEW_PREFIX, PROJECTS_API_PREFIX, RUNS_API_PREFIX, SESSIONS_API_PREFIX, SKILLS_API_PREFIX, } from "./constants.js";
import { WorkspaceDiagnosticExportService } from "./diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { isObject, readJsonBody, sendJson, sendPrettyJson } from "./json.js";
import { createAgentV2RuntimeStore } from "./runtime-store-factory.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { sanitizePathComponent } from "./workspace-paths.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceSessionService } from "./workspace-session-service.js";
import { WorkspaceSkillService } from "./workspace-skill-service.js";
import { createWorkspaceTaskService } from "./workspace-task-factory.js";
const EMPTY_RUN_EVENT_READ_BACKOFF_MS = 100;
const DURABLE_RUN_EVENT_CHECK_INTERVAL_MS = 1000;
const PROJECT_BATCH_SUMMARY_LIMIT = 200;
const AGENT_V2_RUNS_API_PREFIX = "/api/agent-v2/runs";
const VITE_SHUTDOWN_TIMEOUT_MS = 10_000;
const READINESS_REFRESH_INTERVAL_MS = 1_000;
export function configuredStoragePlugin(envFile) {
    const rootDir = process.cwd();
    const config = loadStorageConfig(rootDir, envFile);
    const diagnostics = new WorkspaceDiagnosticLogService(config);
    const sessions = new WorkspaceSessionService(config);
    const files = new WorkspaceFileService(config);
    const previews = new WorkspacePreviewService(config, diagnostics);
    const tasks = createWorkspaceTaskService(config, { previews, diagnostics });
    const skills = new WorkspaceSkillService(config, diagnostics);
    const runtimeDb = createAgentV2RuntimeStore(config);
    const diagnosticExports = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
    const agentV2RunQueue = createRedisAgentV2RunQueue({
        redisUrl: config.redisUrl,
        queueName: config.agentV2.queueName,
    });
    const agentV2RunEventBus = new RedisAgentV2RunEventBus({
        redisUrl: config.redisUrl,
        maxLen: config.agentV2.eventStreamMaxLen,
        ttlSeconds: config.agentV2.eventStreamTtlSeconds,
    });
    const agentV2RunEventLog = new AgentV2RunEventLog({ store: runtimeDb });
    const agentV2OutboxDispatcher = AgentV2OutboxDispatcher.forQueueAndLive({
        store: runtimeDb,
        queue: agentV2RunQueue,
        queueName: config.agentV2.queueName,
        bus: agentV2RunEventBus,
        additionalAdapters: createAgentV2DiagnosticProjectionAdapters({ store: runtimeDb, diagnostics }),
        onError: (event) => {
            diagnostics.writeEvents({
                events: [{ level: "error", category: "system", eventType: event.code, data: { message: event.message } }],
            });
        },
    });
    const agentV2RunApi = new AgentV2RunApiService({
        store: runtimeDb,
        events: agentV2RunEventLog,
        queueName: config.agentV2.queueName,
        wakeDispatcher: () => agentV2OutboxDispatcher.wake(),
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
        agentV2OutboxDispatcher,
    });
}
export function createConfiguredStoragePluginForTest(services) {
    return createConfiguredStoragePlugin(services);
}
function createConfiguredStoragePlugin({ config, diagnostics, sessions, files, previews, tasks, skills, runtimeDb, diagnosticExports, agentV2RunApi, agentV2RunEventBus, agentV2RunEventLog, agentV2RunQueue, agentV2OutboxDispatcher, agentV2ReadinessGate, }) {
    let startupDiagnosticsWritten = false;
    let storageDirsReady = false;
    let storageDirsPromise;
    const dispatcherAbort = new AbortController();
    let dispatcherPromise;
    const readinessAbort = new AbortController();
    const readinessGate = agentV2ReadinessGate ??
        new AgentV2ReadinessGate(new AgentV2Readiness([
            { name: "store", check: async (signal) => await runtimeDb.ping(signal) },
            ...(agentV2RunQueue?.ping
                ? [{ name: "queue", check: async (signal) => await agentV2RunQueue.ping(signal) }]
                : []),
            ...(agentV2RunEventBus?.ping
                ? [{ name: "event_bus", check: async (signal) => await agentV2RunEventBus.ping(signal) }]
                : []),
        ]));
    let readinessRefreshTimer;
    let readinessRefreshPromise;
    const ensureStorageDirs = async () => {
        if (storageDirsReady)
            return;
        storageDirsPromise ??= (async () => {
            sessions.ensureDirs();
            mkdirSync(dirname(config.settingsFile), { recursive: true });
            mkdirSync(config.skillsDir, { recursive: true });
            mkdirSync(config.defaultSkillsDir, { recursive: true });
            diagnostics.ensureDirs();
            await runtimeDb.ensureAgentV2Schema();
            const startupReadiness = await readinessGate.check(readinessAbort.signal, { force: true });
            if (!startupReadiness.ready)
                throw new AgentV2ReadinessStartupError(startupReadiness);
            if (agentV2OutboxDispatcher && !dispatcherPromise) {
                dispatcherPromise = agentV2OutboxDispatcher
                    .start({ ownerId: `web:${process.pid}`, intervalMs: 250, signal: dispatcherAbort.signal })
                    .catch((error) => {
                    diagnostics.writeEvents({
                        events: [
                            {
                                level: "error",
                                category: "system",
                                eventType: "agent_v2.outbox_dispatcher_failed",
                                data: { message: "Agent v2 outbox dispatcher stopped unexpectedly" },
                            },
                        ],
                    });
                    void error;
                });
            }
            scheduleReadinessRefresh();
            writeStartupDiagnosticsOnce();
            storageDirsReady = true;
        })().catch((error) => {
            storageDirsPromise = undefined;
            throw error;
        });
        await storageDirsPromise;
    };
    const scheduleReadinessRefresh = () => {
        if (readinessAbort.signal.aborted || readinessRefreshTimer !== undefined)
            return;
        readinessRefreshTimer = setTimeout(() => {
            readinessRefreshTimer = undefined;
            const refresh = readinessGate
                .check(readinessAbort.signal, { force: true })
                .then(() => undefined, () => {
                if (readinessAbort.signal.aborted)
                    return;
                diagnostics.writeEvents({
                    events: [
                        {
                            level: "error",
                            category: "system",
                            eventType: "agent_v2.readiness_refresh_failed",
                            data: { message: "Agent v2 readiness monitoring stopped unexpectedly" },
                        },
                    ],
                });
            })
                .finally(() => {
                if (readinessRefreshPromise === refresh)
                    readinessRefreshPromise = undefined;
                scheduleReadinessRefresh();
            });
            readinessRefreshPromise = refresh;
        }, READINESS_REFRESH_INTERVAL_MS);
        readinessRefreshTimer.unref?.();
    };
    const writeStartupDiagnosticsOnce = () => {
        if (startupDiagnosticsWritten)
            return;
        startupDiagnosticsWritten = true;
        diagnostics.writeEvents({ events: createStartupDiagnosticEvents(config) });
    };
    const handler = async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const retiredRoute = retiredApplicationGenerationRoute(url.pathname);
        if (retiredRoute) {
            sendJson(res, { error: retiredRoute.error }, retiredRoute.status);
            return;
        }
        if (req.url?.startsWith(PREVIEW_PREFIX)) {
            try {
                await ensureStorageDirs();
                if (previews.servePreviewRequest(req, res))
                    return;
            }
            catch (error) {
                sendJson(res, { error: errorMessage(error) }, 500);
                return;
            }
        }
        if (!req.url?.startsWith(API_PREFIX) &&
            !req.url?.startsWith(PROJECTS_API_PREFIX) &&
            !req.url?.startsWith(SKILLS_API_PREFIX) &&
            !req.url?.startsWith(LOGS_API_PREFIX) &&
            !req.url?.startsWith(SESSIONS_API_PREFIX) &&
            !req.url?.startsWith(RUNS_API_PREFIX) &&
            !req.url?.startsWith(AGENT_V2_RUNS_API_PREFIX)) {
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
                if (method !== "GET") {
                    const report = await readinessGate.check(readinessAbort.signal);
                    if (!report.ready) {
                        sendJson(res, { error: "Agent v2 runtime dependencies are unavailable.", readiness: report }, 503);
                        return;
                    }
                }
                await handleAgentV2RuntimeRunsApi(method, route, url, req, res, requireAgentV2RunApi(agentV2RunApi), requireAgentV2RunEventBus(agentV2RunEventBus), requireAgentV2RunEventLog(agentV2RunEventLog));
                return;
            }
            await handleStorageApi(method, route, req, res, config, sessions, readinessGate, readinessAbort.signal);
        }
        catch (error) {
            sendRuntimeApiError(res, error);
        }
    };
    let runEventBusClosePromise;
    const closeRunEventBusOnce = () => {
        dispatcherAbort.abort();
        readinessAbort.abort();
        if (readinessRefreshTimer !== undefined)
            clearTimeout(readinessRefreshTimer);
        readinessRefreshTimer = undefined;
        runEventBusClosePromise ??= (async () => {
            const deadline = createAgentV2ShutdownDeadline(VITE_SHUTDOWN_TIMEOUT_MS);
            try {
                const result = await runAgentV2ShutdownSteps([
                    { step: "vite.readiness_monitor.stop", run: async () => await readinessRefreshPromise },
                    { step: "vite.outbox_dispatcher.stop", run: async () => await dispatcherPromise },
                    { step: "vite.event_bus.close", run: async (options) => await agentV2RunEventBus?.close(options) },
                    { step: "vite.queue.close", run: async (options) => await agentV2RunQueue?.close(options) },
                    { step: "vite.runtime_store.close", run: async () => await runtimeDb.close?.() },
                    {
                        step: "vite.langfuse.flush",
                        run: async (options) => await diagnostics.flushLangfuse(options.signal),
                    },
                ], deadline);
                if (!result.completed)
                    throw new Error("agent_v2.vite_shutdown_failed");
            }
            finally {
                deadline.dispose();
            }
        })();
        return runEventBusClosePromise;
    };
    const registerRunEventBusCleanup = (server) => {
        server.httpServer?.once?.("close", () => {
            void closeRunEventBusOnce().catch(() => console.error("[agent_v2.vite_shutdown_failed] Agent v2 Vite cleanup failed"));
        });
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
        async configureServer(server) {
            registerRunEventBusCleanup(server);
            await ensureStorageDirs();
            server.middlewares.use(handler);
        },
        async configurePreviewServer(server) {
            registerRunEventBusCleanup(server);
            await ensureStorageDirs();
            server.middlewares.use(handler);
        },
        async closeBundle() {
            await closeRunEventBusOnce();
        },
    };
}
export function createStartupDiagnosticEvents(config) {
    const events = [
        {
            level: "info",
            category: "system",
            eventType: "system.startup.config",
            data: {
                envFile: config.envFile,
                envFileExists: config.envFileExists,
                redisUrl: redactConnectionUrl(config.redisUrl),
                agentV2: config.agentV2,
                runtimeDbFile: config.runtimeDbFile,
                clientsRootDir: config.clientsRootDir,
                workerId: config.workerId,
                workerConcurrency: config.workerConcurrency,
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
function storageWatchIgnoredPaths(config) {
    return [
        `${normalizeWatchPath(config.clientsRootDir)}/**`,
        `${normalizeWatchPath(config.skillsDir)}/**`,
        `${normalizeWatchPath(config.defaultSkillsDir)}/**`,
        normalizeWatchPath(config.logsDbFile),
        normalizeWatchPath(config.runtimeDbFile),
        normalizeWatchPath(config.settingsFile),
    ];
}
function normalizeWatchPath(path) {
    return path.replace(/\\/g, "/");
}
async function handleSkillsApi(method, route, req, res, skills) {
    if (method === "GET" && (route === "/" || route === "")) {
        sendJson(res, skills.list());
        return;
    }
    if (method === "POST" && route === "/load") {
        const body = await readJsonBody(req);
        sendJson(res, skills.load(body));
        return;
    }
    if (method === "POST" && route === "/resource") {
        const body = await readJsonBody(req);
        sendJson(res, skills.readResource(body));
        return;
    }
    sendJson(res, { error: "Not found." }, 404);
}
async function handleProjectsApi(method, route, req, res, config, files, previews, tasks) {
    const clientId = readConfiguredApiClientId(req, config);
    if (method === "GET" && (route === "/" || route === "")) {
        sendJson(res, previews.listProjects(req, clientId));
        return;
    }
    if (method === "POST" && route === "/batch-summary") {
        const body = await readJsonBody(req);
        const summaries = normalizeBatchSummarySessions(body).map((session) => {
            const summary = files.listProjectFiles(withClientId(session, clientId));
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
        sendJson(res, files.listProjectFiles(body));
        return;
    }
    if (method === "POST" && route === "/workspace/file-preview") {
        const body = withClientId(await readJsonBody(req), clientId);
        sendJson(res, files.readProjectFilePreview(body));
        return;
    }
    if (method === "POST" && route === "/workspace/file-save") {
        const body = withClientId(await readJsonBody(req), clientId);
        sendJson(res, files.saveProjectFile(body));
        return;
    }
    if (method === "POST" && route === "/workspace/file") {
        const body = withClientId(await readJsonBody(req), clientId);
        sendJson(res, files.handle(body));
        return;
    }
    if (method === "POST" && route === "/workspace/task") {
        const body = withClientId(await readJsonBody(req), clientId);
        sendJson(res, await tasks.run({ ...body, task: String(body.task || ""), sessionId: String(body.sessionId || "") }, req));
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
        sendJson(res, previews.renameProject(decodeURIComponent(renameMatch[1]), String(body.title || ""), req, clientId));
        return;
    }
    const logsMatch = route.match(/^\/([^/]+)\/logs$/);
    if (method === "GET" && logsMatch) {
        sendJson(res, previews.readProjectLogs(decodeURIComponent(logsMatch[1]), clientId));
        return;
    }
    sendJson(res, { error: "Not found." }, 404);
}
function normalizeBatchSummarySessions(body) {
    const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
    const sessions = [];
    const seen = new Set();
    for (const rawSession of rawSessions) {
        if (sessions.length >= PROJECT_BATCH_SUMMARY_LIMIT)
            break;
        if (!isObject(rawSession))
            continue;
        const sessionId = typeof rawSession.sessionId === "string" ? rawSession.sessionId.trim() : "";
        if (!sessionId || !sanitizePathComponent(sessionId) || seen.has(sessionId))
            continue;
        seen.add(sessionId);
        const title = typeof rawSession.title === "string" ? rawSession.title.trim() : "";
        sessions.push({ sessionId, title });
    }
    return sessions;
}
async function handleStorageApi(method, route, req, res, config, sessions, readinessGate, readinessSignal) {
    if (method === "GET" && route === "/status") {
        const readiness = await readinessGate.check(readinessSignal);
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
            redisUrl: redactConnectionUrl(config.redisUrl),
            workerId: config.workerId,
            workerConcurrency: config.workerConcurrency,
            agentV2: config.agentV2,
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
            langfuseHost: publicEndpointOrigin(config.langfuseHost),
            langfuseOtelEndpoint: publicEndpointOrigin(config.langfuseOtelEndpoint || computedLangfuseOtelEndpoint(config.langfuseHost)),
            langfuseConfigured: Boolean((config.langfuseHost || config.langfuseOtelEndpoint) &&
                config.langfusePublicKey &&
                config.langfuseSecretKey),
            langfuseFlushIntervalMs: config.langfuseFlushIntervalMs,
            langfuseBatchSize: config.langfuseBatchSize,
            langfuseExportPromptSnapshots: config.langfuseExportPromptSnapshots,
            langfuseExportRawChunks: config.langfuseExportRawChunks,
            langfuseExportModelOutputSnapshots: config.langfuseExportModelOutputSnapshots,
            otelServiceName: config.otelServiceName,
            otelDeploymentEnvironment: config.otelDeploymentEnvironment,
            readiness,
        }, readiness.ready ? 200 : 503);
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
export class AgentV2ReadinessStartupError extends Error {
    report;
    constructor(report) {
        super("Agent v2 runtime dependencies are unavailable during startup.");
        this.report = report;
        this.name = "AgentV2ReadinessStartupError";
    }
}
async function handleLogsApi(method, route, url, req, res, config, diagnostics, diagnosticExports) {
    if (method === "GET" && route === "/status") {
        sendJson(res, diagnostics.status());
        return;
    }
    if ((method === "GET" || method === "HEAD") && route === "/export") {
        const clientId = readDiagnosticExportClientId(req, config);
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
                includeSettings: url.searchParams.has("includeSettings") ? queryBoolean(url, "includeSettings") : false,
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
            includeSettings: url.searchParams.has("includeSettings") ? queryBoolean(url, "includeSettings") : false,
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
        sendJson(res, diagnostics.writeEvents(withDiagnosticClientId(body, clientId)));
        return;
    }
    if (method === "GET" && route === "/events") {
        sendJson(res, diagnostics.queryEvents(withClientId(toDiagnosticLogQuery(url), clientId)));
        return;
    }
    sendJson(res, { error: "Not found." }, 404);
}
function sendDiagnosticArchiveHead(res, archive) {
    res.statusCode = 200;
    res.setHeader("Content-Type", archive.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${archive.filename}"`);
    res.end();
}
async function sendDiagnosticArchive(res, archive) {
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
function readDiagnosticExportClientId(req, config) {
    return readConfiguredApiClientId(req, config);
}
function readConfiguredApiClientId(req, config) {
    if (config.clientIdRequired)
        return readClientIdHeader(req);
    const value = req.headers["x-pi-client-id"];
    if (value === undefined)
        return undefined;
    return normalizeClientId(Array.isArray(value) ? value[0] : value);
}
function withClientId(body, clientId) {
    return clientId ? { ...body, clientId } : body;
}
function withDiagnosticClientId(body, clientId) {
    if (!clientId)
        return body;
    return {
        ...body,
        events: Array.isArray(body.events)
            ? body.events.map((event) => isObject(event)
                ? { ...event, clientId, data: isObject(event.data) ? { ...event.data, clientId } : { clientId } }
                : event)
            : body.events,
    };
}
function requireAgentV2RunApi(agentV2RunApi) {
    if (!agentV2RunApi)
        throw new AgentV2RunApiError("Agent v2 run API service is not configured.", 503);
    return agentV2RunApi;
}
function requireAgentV2RunEventBus(agentV2RunEventBus) {
    if (!agentV2RunEventBus)
        throw new AgentV2RunApiError("Agent v2 run event bus is not configured.", 503);
    return agentV2RunEventBus;
}
function requireAgentV2RunEventLog(agentV2RunEventLog) {
    if (!agentV2RunEventLog)
        throw new AgentV2RunApiError("Agent v2 run event log is not configured.", 503);
    return agentV2RunEventLog;
}
async function handleAgentV2RuntimeRunsApi(method, route, url, req, res, agentV2RunApi, agentV2RunEventBus, runEventLog) {
    try {
        const clientId = readClientIdHeader(req);
        if (method === "POST" && route === "/start") {
            const body = await readJsonBody(req);
            sendJson(res, (await agentV2RunApi.startRun(clientId, body)));
            return;
        }
        if (method === "GET" && (route === "/" || route === "")) {
            sendJson(res, { runs: await agentV2RunApi.listRuns(clientId) });
            return;
        }
        const eventsMatch = route.match(/^\/([^/]+)\/events$/);
        if (method === "GET" && eventsMatch) {
            const runId = decodeURIComponent(eventsMatch[1]);
            const afterSeq = agentV2ReplayCursor(url, req);
            if (wantsEventStream(req, url)) {
                await streamAgentV2RunEvents(res, req, agentV2RunApi, agentV2RunEventBus, runEventLog, clientId, runId, afterSeq);
                return;
            }
            const run = await agentV2RunApi.getRun(clientId, runId);
            if (!run)
                throw new AgentV2RunApiError("Agent v2 run not found.", 404);
            sendJson(res, { events: await agentV2RunApi.listRunEvents(clientId, runId, afterSeq) });
            return;
        }
        const cancelMatch = route.match(/^\/([^/]+)\/cancel$/);
        if (method === "POST" && cancelMatch) {
            sendJson(res, (await agentV2RunApi.cancelRun(clientId, decodeURIComponent(cancelMatch[1]))));
            return;
        }
        const runMatch = route.match(/^\/([^/]+)$/);
        if (method === "GET" && runMatch) {
            const run = await agentV2RunApi.getRun(clientId, decodeURIComponent(runMatch[1]));
            sendJson(res, (run || { error: "Agent v2 run not found." }), run ? 200 : 404);
            return;
        }
        sendJson(res, { error: "Not found." }, 404);
    }
    catch (error) {
        sendRuntimeApiError(res, error);
    }
}
function retiredApplicationGenerationRoute(pathname) {
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
function wantsEventStream(req, url) {
    if (queryBoolean(url, "stream"))
        return true;
    const accept = req.headers.accept;
    return Array.isArray(accept)
        ? accept.some((value) => value.includes("text/event-stream"))
        : typeof accept === "string" && accept.includes("text/event-stream");
}
async function streamAgentV2RunEvents(res, req, agentV2RunApi, agentV2RunEventBus, runEventLog, clientId, runId, afterSeq) {
    let liveReadSeq = afterSeq;
    let sentSeq = afterSeq;
    const pendingEvents = new Map();
    let closed = false;
    let heartbeatAt = Date.now();
    let streamStarted = false;
    const abortController = new AbortController();
    const closeStream = () => {
        if (closed)
            return;
        closed = true;
        if (!abortController.signal.aborted)
            abortController.abort();
    };
    req.on("close", closeStream);
    const responseWithOn = res;
    if (typeof responseWithOn.on === "function")
        responseWithOn.on("close", closeStream);
    try {
        const run = await agentV2RunApi.getRun(clientId, runId);
        if (!run)
            throw new AgentV2RunApiError("Agent v2 run not found.", 404);
        const stageEvents = (events) => {
            for (const event of events) {
                if (event.seq <= sentSeq || pendingEvents.has(event.seq))
                    continue;
                pendingEvents.set(event.seq, event);
            }
        };
        const flushContiguousEvents = () => {
            while (true) {
                const event = pendingEvents.get(sentSeq + 1);
                if (!event)
                    return;
                writeServerSentRunEvent(res, event);
                pendingEvents.delete(event.seq);
                sentSeq = event.seq;
            }
        };
        const healFromDurableLog = async () => {
            stageEvents(await runEventLog.list(clientId, runId, sentSeq));
            flushContiguousEvents();
            liveReadSeq = Math.max(liveReadSeq, sentSeq);
        };
        const durableEvents = await runEventLog.list(clientId, runId, sentSeq);
        if (closed || res.destroyed)
            return;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, no-transform, must-revalidate");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        streamStarted = true;
        res.write(": connected\n\n");
        stageEvents(durableEvents);
        flushContiguousEvents();
        liveReadSeq = Math.max(liveReadSeq, sentSeq);
        while (!closed && !res.destroyed) {
            const events = await agentV2RunEventBus.read({
                clientId,
                runId,
                afterSeq: liveReadSeq,
                blockMs: DURABLE_RUN_EVENT_CHECK_INTERVAL_MS,
                signal: abortController.signal,
            });
            for (const event of events)
                liveReadSeq = Math.max(liveReadSeq, event.seq);
            if (closed || res.destroyed)
                break;
            stageEvents(events);
            flushContiguousEvents();
            if (events.length === 0 || pendingEvents.size > 0) {
                await healFromDurableLog();
            }
            if (events.length === 0) {
                heartbeatAt = writeHeartbeatIfDue(res, heartbeatAt);
                await waitForRunEventReadBackoff(abortController.signal, EMPTY_RUN_EVENT_READ_BACKOFF_MS);
                continue;
            }
            heartbeatAt = writeHeartbeatIfDue(res, heartbeatAt);
        }
    }
    catch (error) {
        if (!streamStarted)
            throw error;
        if (!closed && !res.destroyed) {
            writeServerSentError(res, "Agent v2 runtime event stream unavailable.");
            res.end();
        }
        closeStream();
    }
    finally {
        req.off?.("close", closeStream);
        if (typeof responseWithOn.off === "function")
            responseWithOn.off("close", closeStream);
    }
}
function writeHeartbeatIfDue(res, heartbeatAt) {
    const now = Date.now();
    if (now - heartbeatAt > 15000) {
        res.write(": keep-alive\n\n");
        return now;
    }
    return heartbeatAt;
}
function waitForRunEventReadBackoff(signal, delayMs) {
    if (signal.aborted)
        return Promise.resolve();
    return new Promise((resolve) => {
        let timeout;
        const done = () => {
            if (timeout !== undefined)
                clearTimeout(timeout);
            signal.removeEventListener("abort", done);
            resolve();
        };
        timeout = setTimeout(done, delayMs);
        signal.addEventListener("abort", done, { once: true });
    });
}
function writeServerSentRunEvent(res, event) {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
}
function writeServerSentError(res, message) {
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
}
function toDiagnosticLogQuery(url) {
    return {
        sessionId: queryString(url, "sessionId"),
        traceId: queryString(url, "traceId"),
        level: queryString(url, "level"),
        category: queryString(url, "category"),
        eventType: queryString(url, "eventType"),
        limit: queryNumber(url, "limit"),
    };
}
function queryString(url, key) {
    const value = url.searchParams.get(key);
    return value?.trim() || undefined;
}
function queryNumber(url, key) {
    const value = url.searchParams.get(key);
    if (!value)
        return undefined;
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
}
function agentV2ReplayCursor(url, req) {
    const queryValues = url.searchParams.getAll("afterSeq");
    if (queryValues.length > 1) {
        throw new AgentV2RunApiError("afterSeq must be specified at most once.", 400);
    }
    const queryCursor = queryValues.length === 0 ? undefined : parseCanonicalReplayCursor(queryValues[0], "afterSeq");
    const headerValue = req.headers["last-event-id"];
    if (Array.isArray(headerValue)) {
        throw new AgentV2RunApiError("Last-Event-ID must be specified at most once.", 400);
    }
    const headerCursor = headerValue === undefined ? undefined : parseCanonicalReplayCursor(headerValue, "Last-Event-ID");
    if (queryCursor !== undefined && headerCursor !== undefined && queryCursor !== headerCursor) {
        throw new AgentV2RunApiError("afterSeq and Last-Event-ID must match.", 400);
    }
    return queryCursor ?? headerCursor ?? 0;
}
function parseCanonicalReplayCursor(value, label) {
    if (!/^(?:0|[1-9]\d*)$/.test(value)) {
        throw new AgentV2RunApiError(`${label} must be a canonical non-negative integer.`, 400);
    }
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor)) {
        throw new AgentV2RunApiError(`${label} must be a safe integer.`, 400);
    }
    return cursor;
}
function queryBoolean(url, key) {
    const value = url.searchParams.get(key);
    if (!value)
        return false;
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
function diagnosticExportFilename(sessionId, runId) {
    const id = sanitizeFilenamePart(runId ?? sessionId ?? "logs");
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    return `pi-diagnostics-${id}-${timestamp}.json`;
}
function sanitizeFilenamePart(value) {
    return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "logs";
}
function computedLangfuseOtelEndpoint(host) {
    return host ? `${host}/api/public/otel/v1/traces` : "";
}
function publicEndpointOrigin(value) {
    if (!value)
        return "";
    try {
        return new URL(value).origin;
    }
    catch {
        return "";
    }
}
function redactConnectionUrl(value) {
    try {
        const url = new URL(value);
        const credentials = url.username || url.password ? "[redacted]@" : "";
        const path = url.pathname === "/" ? "" : url.pathname;
        return `${url.protocol}//${credentials}${url.host}${path}${url.search}${url.hash}`;
    }
    catch {
        return value;
    }
}
function sendRuntimeApiError(res, error) {
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
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=vite-plugin.js.map