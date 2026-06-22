import { randomUUID } from "node:crypto";
import { isObject } from "./json.js";
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "cancelling"]);
export class RunApiError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = "RunApiError";
    }
}
export class WorkspaceRunApiService {
    db;
    queue;
    diagnostics;
    projectFiles;
    sessionWorkspaces;
    appPreviewGoals;
    constructor(db, queue, diagnostics, projectFiles, sessionWorkspaces, appPreviewGoals) {
        this.db = db;
        this.queue = queue;
        this.diagnostics = diagnostics;
        this.projectFiles = projectFiles;
        this.sessionWorkspaces = sessionWorkspaces;
        this.appPreviewGoals = appPreviewGoals;
    }
    async startRun(clientId, request) {
        const appPreviewGoalSource = request.appPreviewGoal?.enabled
            ? normalizeAppPreviewGoalSourceForStartRun(request.appPreviewGoal.source)
            : undefined;
        const sessionId = normalizeOptionalString(request.sessionId) ?? randomUUID();
        const existingSession = this.db.getSession(clientId, sessionId);
        if (existingSession && this.hasActiveRun(clientId, sessionId)) {
            throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
        }
        if (!existingSession && request.message === undefined) {
            throw new RunApiError("Start run message is required for new sessions", 400);
        }
        const model = isObject(request.model) ? request.model : (existingSession?.model ?? {});
        const thinkingLevel = normalizeOptionalString(request.thinkingLevel) ?? existingSession?.thinkingLevel ?? "high";
        const title = existingSession?.title ?? normalizeOptionalString(request.title) ?? "Untitled session";
        await this.ensureProjectWorkspace(clientId, sessionId, title);
        await this.seedProjectFiles(clientId, sessionId, title, request.projectFiles);
        if (request.message === undefined) {
            const run = this.db.createContinuationRun({
                clientId,
                sessionId,
                model,
                thinkingLevel,
                runId: randomUUID(),
            });
            if (!run) {
                throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
            }
            await this.enqueueRun(run);
            this.applyAppPreviewGoalRequest(clientId, sessionId, run.runId, appPreviewGoalSource);
            return {
                session: this.requiredSession(clientId, sessionId),
                run,
            };
        }
        const payload = normalizeMessage(request.message);
        const result = this.db.createRunWithMessage({
            clientId,
            sessionId,
            title,
            model,
            thinkingLevel,
            messageRole: normalizeUserMessageRole(payload.role),
            payload,
            runId: randomUUID(),
        });
        if (!result) {
            throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
        }
        await this.enqueueRun(result.run);
        this.applyAppPreviewGoalRequest(clientId, sessionId, result.run.runId, appPreviewGoalSource);
        return result;
    }
    requiredSession(clientId, sessionId) {
        const session = this.db.getSession(clientId, sessionId);
        if (!session)
            throw new RunApiError("Runtime session not found", 404);
        return session;
    }
    async enqueueRun(run) {
        try {
            await this.queue.enqueue({ clientId: run.clientId, runId: run.runId });
        }
        catch (error) {
            const cause = errorMessage(error);
            const message = `queue enqueue failed: ${cause}`;
            this.db.updateRunStatus(run.runId, run.clientId, "failed", { error: message });
            this.diagnostics?.writeEvents({
                events: [
                    {
                        level: "error",
                        category: "agent",
                        eventType: "agent.run.enqueue.error",
                        sessionId: run.sessionId,
                        traceId: run.sessionId,
                        data: {
                            clientId: run.clientId,
                            sessionId: run.sessionId,
                            runId: run.runId,
                            status: "failed",
                            message: cause,
                        },
                    },
                ],
            });
            throw new RunApiError("Run queue unavailable", 503);
        }
    }
    listSessions(clientId) {
        return this.db.listSessions(clientId);
    }
    getSession(clientId, sessionId) {
        const session = this.db.getSession(clientId, sessionId);
        if (!session)
            return undefined;
        return {
            session,
            messages: this.db.listMessages(clientId, sessionId),
            runs: this.db.listRunsForSession(clientId, sessionId),
        };
    }
    renameSession(clientId, sessionId, title) {
        const nextTitle = normalizeOptionalString(title);
        if (!nextTitle)
            throw new RunApiError("Session title is required", 400);
        if (nextTitle.length > 160)
            throw new RunApiError("Session title must be 160 characters or fewer", 400);
        const session = this.db.updateSessionTitle(clientId, sessionId, nextTitle);
        if (!session)
            throw new RunApiError("Session not found.", 404);
        return session;
    }
    async deleteSession(clientId, sessionId, options = {}) {
        const activeRuns = this.activeRuns(clientId, sessionId);
        if (activeRuns.length > 0 && !options.force) {
            throw new RunApiError(`Session ${sessionId} already has an active run`, 409);
        }
        if (activeRuns.length > 0 && options.force) {
            await Promise.all(activeRuns.map((run) => this.cancelActiveRun(run)));
            return { deleted: false, sessionId, cancelledRuns: activeRuns.length };
        }
        const deleted = this.db.deleteSession(clientId, sessionId);
        if (deleted)
            await this.sessionWorkspaces?.deleteSessionWorkspace(clientId, sessionId);
        return { deleted, sessionId };
    }
    listRuns(clientId) {
        return this.db.listRuns(clientId);
    }
    getRunStatus(clientId, runId) {
        return this.db.getRun(clientId, runId);
    }
    async cancelRun(clientId, runId) {
        const run = this.db.getRun(clientId, runId);
        if (!run)
            throw new RunApiError("Run not found", 404);
        if (!ACTIVE_RUN_STATUSES.has(run.status))
            return run;
        return this.cancelActiveRun(run);
    }
    async cancelActiveRun(run) {
        const { clientId, runId } = run;
        await this.queue.requestCancel({ clientId, runId });
        if (run.status === "queued") {
            return this.db.updateRunStatus(runId, clientId, "cancelled");
        }
        if (run.status === "cancelling") {
            return run;
        }
        return this.db.updateRunStatus(runId, clientId, "cancelling");
    }
    listRunEvents(clientId, runId, afterSeq) {
        return this.db.listRunEvents(clientId, runId, afterSeq);
    }
    getAppPreviewGoal(clientId, sessionId) {
        return this.appPreviewGoals?.get(clientId, sessionId);
    }
    listAppPreviewGoalEvents(clientId, sessionId, afterEventId = 0) {
        return this.appPreviewGoals?.events(clientId, sessionId, afterEventId) ?? [];
    }
    enableAppPreviewGoal(clientId, sessionId, source) {
        if (!this.appPreviewGoals)
            return undefined;
        this.requiredSession(clientId, sessionId);
        return this.appPreviewGoals.enable({ clientId, sessionId, source });
    }
    disableAppPreviewGoal(clientId, sessionId) {
        return this.appPreviewGoals?.disable({ clientId, sessionId });
    }
    activeRuns(clientId, sessionId) {
        return this.db.listRunsForSession(clientId, sessionId).filter((run) => ACTIVE_RUN_STATUSES.has(run.status));
    }
    hasActiveRun(clientId, sessionId) {
        return this.activeRuns(clientId, sessionId).length > 0;
    }
    async ensureProjectWorkspace(clientId, sessionId, title) {
        if (!this.projectFiles?.ensureWorkspace)
            return;
        try {
            await this.projectFiles.ensureWorkspace({ clientId, sessionId, title });
        }
        catch (error) {
            if (error instanceof RunApiError)
                throw error;
            throw new RunApiError(`Project workspace init failed: ${errorMessage(error)}`, 500);
        }
    }
    async seedProjectFiles(clientId, sessionId, title, value) {
        const files = normalizeProjectFiles(value);
        if (files.length === 0)
            return;
        if (!this.projectFiles)
            throw new RunApiError("Project file seeding is not configured", 500);
        try {
            for (const file of files) {
                await this.projectFiles.writeFile({ clientId, sessionId, title }, file);
            }
        }
        catch (error) {
            if (error instanceof RunApiError)
                throw error;
            throw new RunApiError(`Project file seed failed: ${errorMessage(error)}`, 500);
        }
    }
    applyAppPreviewGoalRequest(clientId, sessionId, runId, source) {
        if (!source)
            return;
        this.appPreviewGoals?.enable({
            clientId,
            sessionId,
            runId,
            source,
        });
    }
}
function normalizeMessage(value) {
    if (!isObject(value))
        throw new RunApiError("Start run message must be a JSON object", 400);
    return value;
}
function normalizeUserMessageRole(value) {
    return value === "user-with-attachments" ? "user-with-attachments" : "user";
}
function normalizeOptionalString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeAppPreviewGoalSourceForStartRun(value) {
    if (value === "manual" || value === "pm_handoff")
        return value;
    throw new RunApiError('App preview goal source must be "manual" or "pm_handoff"', 400);
}
function normalizeProjectFiles(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new RunApiError("Start run projectFiles must be an array", 400);
    return value.map((entry, index) => {
        if (!isObject(entry))
            throw new RunApiError(`projectFiles[${index}] must be an object`, 400);
        const filename = normalizeOptionalString(entry.filename);
        if (!filename)
            throw new RunApiError(`projectFiles[${index}].filename is required`, 400);
        if (typeof entry.content !== "string") {
            throw new RunApiError(`projectFiles[${index}].content is required`, 400);
        }
        return { filename, content: entry.content };
    });
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=run-api-service.js.map