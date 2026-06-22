import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { AppPreviewGoalService } from "./app-preview-goal-service.js";
import { normalizeClientId, readClientIdHeader } from "./client-id.js";
import { loadStorageConfig } from "./config.js";
import { API_PREFIX, LOGS_API_PREFIX, PREVIEW_PREFIX, PROJECTS_API_PREFIX, RUNS_API_PREFIX, SESSIONS_API_PREFIX, SKILLS_API_PREFIX, } from "./constants.js";
import { WorkspaceDiagnosticExportService } from "./diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { isObject, readJsonBody, sendJson, sendPrettyJson } from "./json.js";
import { RunApiError, WorkspaceRunApiService } from "./run-api-service.js";
import { RedisRunQueue } from "./run-queue.js";
import { RuntimeDbStore } from "./runtime-db.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
import { WorkspaceSessionService } from "./workspace-session-service.js";
import { WorkspaceSkillService } from "./workspace-skill-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";
import { deleteSessionWorkspace } from "./workspace-paths.js";
export function configuredStoragePlugin(envFile) {
    const rootDir = process.cwd();
    const config = loadStorageConfig(rootDir, envFile);
    const diagnostics = new WorkspaceDiagnosticLogService(config);
    const sessions = new WorkspaceSessionService(config);
    const files = new WorkspaceFileService(config);
    const previews = new WorkspacePreviewService(config, diagnostics);
    const tasks = new WorkspaceTaskService(config, previews, undefined, diagnostics);
    const skills = new WorkspaceSkillService(config, diagnostics);
    const runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
    const appPreviewGoals = new AppPreviewGoalService(runtimeDb);
    const diagnosticExports = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
    const runQueue = new RedisRunQueue({ redisUrl: config.redisUrl, queueName: config.runQueueName });
    const runApi = new WorkspaceRunApiService(runtimeDb, runQueue, diagnostics, {
        ensureWorkspace(context) {
            files.ensureProjectWorkspace({
                clientId: context.clientId,
                sessionId: context.sessionId,
                title: context.title,
            });
        },
        writeFile(context, file) {
            files.handle({
                clientId: context.clientId,
                sessionId: context.sessionId,
                title: context.title,
                command: "create",
                filename: file.filename,
                content: file.content,
            });
        },
    }, {
        deleteSessionWorkspace(clientId, sessionId) {
            return deleteSessionWorkspace(config.clientsRootDir, sessionId, clientId);
        },
    }, appPreviewGoals);
    let startupDiagnosticsWritten = false;
    const ensureStorageDirs = () => {
        sessions.ensureDirs();
        mkdirSync(dirname(config.settingsFile), { recursive: true });
        mkdirSync(config.skillsDir, { recursive: true });
        mkdirSync(config.defaultSkillsDir, { recursive: true });
        diagnostics.ensureDirs();
        runtimeDb.ensureSchema();
        writeStartupDiagnosticsOnce();
    };
    const writeStartupDiagnosticsOnce = () => {
        if (startupDiagnosticsWritten)
            return;
        startupDiagnosticsWritten = true;
        diagnostics.writeEvents({ events: createStartupDiagnosticEvents(config) });
    };
    const handler = async (req, res, next) => {
        if (req.url?.startsWith(PREVIEW_PREFIX)) {
            try {
                ensureStorageDirs();
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
            !req.url?.startsWith(RUNS_API_PREFIX)) {
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
                await handleLogsApi(method, route, url, req, res, config, diagnostics, diagnosticExports);
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
        }
        catch (error) {
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
export function createStartupDiagnosticEvents(config) {
    const events = [
        {
            level: "info",
            category: "system",
            eventType: "system.startup.config",
            data: {
                envFile: config.envFile,
                envFileExists: config.envFileExists,
                runsEnabled: config.runsEnabled,
                redisUrl: redactConnectionUrl(config.redisUrl),
                runQueueName: config.runQueueName,
                runtimeDbFile: config.runtimeDbFile,
                clientsRootDir: config.clientsRootDir,
                workerId: config.workerId,
                workerConcurrency: config.workerConcurrency,
                clientIdRequired: config.clientIdRequired,
                loggingEnabled: config.loggingEnabled,
                logStdoutEnabled: config.logStdoutEnabled,
                logsDbFile: config.logsDbFile,
                modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
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
async function handleStorageApi(method, route, req, res, config, sessions) {
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
            runQueueName: config.runQueueName,
            runEventRetentionDays: config.runEventRetentionDays,
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
            logRetentionDays: config.logRetentionDays,
            logMaxEvents: config.logMaxEvents,
            logCleanupIntervalMs: config.logCleanupIntervalMs,
            logVacuumIntervalMs: config.logVacuumIntervalMs,
            langfuseEnabled: config.langfuseEnabled,
            langfuseHost: config.langfuseHost,
            langfuseOtelEndpoint: config.langfuseOtelEndpoint || computedLangfuseOtelEndpoint(config.langfuseHost),
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
async function handleLogsApi(method, route, url, req, res, config, diagnostics, diagnosticExports) {
    if (method === "GET" && route === "/status") {
        sendJson(res, diagnostics.status());
        return;
    }
    const clientId = readConfiguredApiClientId(req, config);
    if (method === "GET" && route === "/export") {
        const sessionId = queryString(url, "sessionId");
        const runId = queryString(url, "runId");
        if (!sessionId && !runId) {
            sendJson(res, { error: "Query parameter `sessionId` or `runId` is required." }, 400);
            return;
        }
        const payload = diagnosticExports.export({
            clientId: clientId ?? "",
            sessionId,
            runId,
            includeSettings: url.searchParams.has("includeSettings") ? queryBoolean(url, "includeSettings") : true,
            maxDiagnosticEvents: queryNumber(url, "maxDiagnosticEvents"),
        });
        res.setHeader("Content-Disposition", `attachment; filename="${diagnosticExportFilename(sessionId, runId)}"`);
        sendPrettyJson(res, payload);
        return;
    }
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
async function handleRuntimeSessionsApi(method, route, url, req, res, runApi) {
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
            if (method === "PUT") {
                const body = await readJsonBody(req);
                sendJson(res, runApi.renameSession(clientId, sessionId, String(body.title || "")));
                return;
            }
            if (method === "DELETE") {
                sendJson(res, await runApi.deleteSession(clientId, sessionId, { force: queryBoolean(url, "force") }));
                return;
            }
        }
        sendJson(res, { error: "Not found." }, 404);
    }
    catch (error) {
        sendRuntimeApiError(res, error);
    }
}
async function handleRuntimeRunsApi(method, route, url, req, res, runApi) {
    try {
        const clientId = readClientIdHeader(req);
        if (method === "POST" && (route === "/" || route === "" || route === "/start")) {
            const body = await readJsonBody(req);
            sendJson(res, await runApi.startRun(clientId, body));
            return;
        }
        if (method === "GET" && (route === "/" || route === "")) {
            sendJson(res, { runs: runApi.listRuns(clientId) });
            return;
        }
        if (method === "GET" && route === "/goals/app-preview") {
            const sessionId = queryString(url, "sessionId");
            if (!sessionId)
                throw new RunApiError("sessionId is required", 400);
            const afterEventId = queryNumber(url, "afterEventId") ?? 0;
            sendJson(res, {
                goal: runApi.getAppPreviewGoal(clientId, sessionId) ?? null,
                events: runApi.listAppPreviewGoalEvents(clientId, sessionId, afterEventId),
            });
            return;
        }
        if (method === "POST" && route === "/goals/app-preview") {
            const body = await readJsonBody(req);
            const sessionId = normalizeRequiredBodyString(body.sessionId, "sessionId");
            const source = normalizeAppPreviewGoalSource(body.source);
            sendJson(res, { goal: runApi.enableAppPreviewGoal(clientId, sessionId, source) ?? null });
            return;
        }
        if (method === "POST" && route === "/goals/app-preview/disable") {
            const body = await readJsonBody(req);
            const sessionId = normalizeRequiredBodyString(body.sessionId, "sessionId");
            sendJson(res, { goal: runApi.disableAppPreviewGoal(clientId, sessionId) ?? null });
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
    }
    catch (error) {
        sendRuntimeApiError(res, error);
    }
}
function wantsEventStream(req, url) {
    if (queryBoolean(url, "stream"))
        return true;
    const accept = req.headers.accept;
    return Array.isArray(accept)
        ? accept.some((value) => value.includes("text/event-stream"))
        : typeof accept === "string" && accept.includes("text/event-stream");
}
function streamRunEvents(res, req, runApi, clientId, runId, afterSeq) {
    let lastSeq = afterSeq;
    let closed = false;
    let heartbeatAt = Date.now();
    let timer;
    const closeStream = () => {
        if (closed)
            return;
        closed = true;
        if (timer !== undefined)
            clearInterval(timer);
    };
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(": connected\n\n");
    const sendEvents = () => {
        if (closed || res.destroyed)
            return;
        try {
            const events = runApi.listRunEvents(clientId, runId, lastSeq);
            for (const event of events) {
                if (closed || res.destroyed)
                    return;
                writeServerSentRunEvent(res, event);
                lastSeq = Math.max(lastSeq, event.seq);
            }
            const now = Date.now();
            if (now - heartbeatAt > 15000) {
                res.write(": keep-alive\n\n");
                heartbeatAt = now;
            }
        }
        catch (error) {
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
function writeServerSentRunEvent(res, event) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
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
function normalizeRequiredBodyString(value, field) {
    if (typeof value === "string" && value.trim())
        return value.trim();
    throw new RunApiError(`${field} is required`, 400);
}
function normalizeAppPreviewGoalSource(value) {
    if (value === undefined)
        return "manual";
    if (value === "manual" || value === "pm_handoff")
        return value;
    throw new RunApiError("source must be manual or pm_handoff", 400);
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
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=vite-plugin.js.map