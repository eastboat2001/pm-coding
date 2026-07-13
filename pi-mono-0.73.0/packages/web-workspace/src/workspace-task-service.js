import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { BuildRunnerError } from "./build-runner.js";
import { findBuildSourceEntry, findStaticServeRoot, staticServeRootCandidates } from "./static-preview.js";
import { assessStaticPreviewQuality } from "./static-preview-quality-gate.js";
import { runStaticPreviewSmokeGate } from "./static-preview-smoke-gate.js";
import { appendProjectLog, truncateProjectLogs } from "./workspace-command-service.js";
import { listProjectSourceFiles, workspaceContext } from "./workspace-paths.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
export class WorkspaceTaskService {
    config;
    buildRunner;
    previews;
    diagnostics;
    constructor(config, buildRunner, previews = new WorkspacePreviewService(config), diagnostics) {
        this.config = config;
        this.buildRunner = buildRunner;
        this.previews = previews;
        this.diagnostics = diagnostics;
    }
    async run(body, req, signal) {
        if (!isProjectTaskName(body.task)) {
            throw new Error("Field `task` must be one of: inspect, validate, build_static, preview, logs.");
        }
        if (body.task === "preview") {
            if (!req)
                throw new Error("Preview task requires request headers.");
            const preview = await this.previews.preview(body, req);
            return this.recordTaskResult({ task: "preview", ...preview });
        }
        const { clientId, sessionId, title, projectId, projectDir } = workspaceContext(this.config, body);
        if (body.task === "logs") {
            const logs = this.previews.readProjectLogs(projectId, clientId);
            return this.recordTaskResult({ ...logs, task: "logs", status: String(logs.status || "ready") });
        }
        mkdirSync(projectDir, { recursive: true });
        const files = listProjectSourceFiles(projectDir).map((file) => relative(projectDir, file));
        const hasPackageJson = existsSync(join(projectDir, "package.json"));
        if (body.task === "build_static") {
            return this.recordTaskResult(await this.buildStaticProject({ projectId, sessionId, title, projectDir, files }, signal));
        }
        const staticRoot = findStaticServeRoot(projectDir, staticServeRootCandidates(hasPackageJson));
        const base = {
            task: body.task,
            status: body.task === "inspect" ? "ready" : "pending",
            projectId,
            sessionId,
            title,
            projectRoot: projectDir,
            fileCount: files.length,
            files,
            hasPackageJson,
            mode: "static",
            serveRoot: staticRoot || "",
        };
        if (body.task === "inspect")
            return this.recordTaskResult(base);
        const errors = [];
        if (files.length === 0)
            errors.push("Project workspace is empty.");
        if (!staticRoot) {
            const buildSourceEntry = findBuildSourceEntry(projectDir, ["", "public"]);
            errors.push(buildSourceEntry
                ? `Static preview found a build source entry at ${buildSourceEntry}. Run project_task build_static before project_task preview so PI can serve browser-ready dist/build output.`
                : "Static preview requires an index.html in the project root, dist, build, or public. Package scripts, npm install, npm run build, and Node services are not started.");
        }
        if (staticRoot) {
            const quality = assessStaticPreviewQuality({ serveRoot: staticRoot });
            errors.push(...quality.errors.map((error) => `Static preview quality gate: ${error}`));
            if (quality.errors.length === 0) {
                const smoke = await runStaticPreviewSmokeGate({ serveRoot: staticRoot });
                errors.push(...smoke.errors.map((error) => `Static preview smoke gate: ${error}`));
            }
        }
        return this.recordTaskResult({
            ...base,
            status: errors.length === 0 ? "passed" : "failed",
            valid: errors.length === 0,
            errors,
        });
    }
    async buildStaticProject(options, signal) {
        const logs = [];
        appendProjectLog(logs, `Project root: ${options.projectDir}\n`);
        const packageJsonPath = join(options.projectDir, "package.json");
        const errors = [];
        if (!existsSync(packageJsonPath))
            errors.push("build_static requires package.json.");
        if (options.files.length === 0)
            errors.push("Project workspace is empty.");
        if (errors.length > 0)
            return buildStaticResult(options, "failed", false, "", errors, logs);
        try {
            const build = await this.buildRunner.build({
                projectId: "dist",
                projectRoot: options.projectDir,
                artifactRoot: options.projectDir,
                allowedOutputs: ["dist", "build", "public"],
                signal,
            });
            for (const log of build.logs)
                appendProjectLog(logs, log);
            appendProjectLog(logs, "Static build completed.\n");
            return buildStaticResult(options, "passed", true, build.serveRoot, [], logs);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (error instanceof BuildRunnerError) {
                for (const log of error.logs ?? [])
                    appendProjectLog(logs, log);
            }
            appendProjectLog(logs, message);
            return buildStaticResult(options, "failed", false, findStaticServeRoot(options.projectDir, staticServeRootCandidates(true)) || "", [message], logs, error instanceof BuildRunnerError ? error.code : undefined);
        }
    }
    recordTaskResult(result) {
        this.diagnostics?.writeEvents({
            events: [
                {
                    level: result.status === "failed" ? "error" : "info",
                    category: "project",
                    eventType: "project.task.end",
                    sessionId: result.sessionId,
                    traceId: result.sessionId,
                    spanId: result.projectId,
                    data: {
                        task: result.task,
                        status: result.status,
                        title: result.title,
                        projectId: result.projectId,
                        fileCount: result.fileCount,
                        valid: result.valid,
                        errors: result.errors,
                        logs: result.logs,
                    },
                },
            ],
        });
        return result;
    }
}
function isProjectTaskName(value) {
    return (value === "inspect" || value === "validate" || value === "build_static" || value === "preview" || value === "logs");
}
function buildStaticResult(options, status, valid, serveRoot, errors, logs, failureCode) {
    const files = listProjectSourceFiles(options.projectDir).map((file) => relative(options.projectDir, file));
    return {
        task: "build_static",
        status,
        projectId: options.projectId,
        sessionId: options.sessionId,
        title: options.title,
        projectRoot: options.projectDir,
        fileCount: files.length,
        files,
        hasPackageJson: existsSync(join(options.projectDir, "package.json")),
        valid,
        errors,
        mode: "static",
        serveRoot,
        logs: truncateProjectLogs(logs),
        ...(failureCode ? { failureCode } : {}),
    };
}
//# sourceMappingURL=workspace-task-service.js.map