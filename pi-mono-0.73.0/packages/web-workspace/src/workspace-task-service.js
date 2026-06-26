import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { isObject, readJsonFile } from "./json.js";
import { findBuildSourceEntry, findStaticServeRoot, staticServeRootCandidates } from "./static-preview.js";
import { appendProjectLog, isUnsafeProjectCommand, runCommand, truncateProjectLogs, } from "./workspace-command-service.js";
import { listProjectSourceFiles, workspaceContext } from "./workspace-paths.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";
export class WorkspaceTaskService {
    config;
    previews;
    runProjectCommand;
    diagnostics;
    constructor(config, previews = new WorkspacePreviewService(config), runProjectCommand = runCommand, diagnostics) {
        this.config = config;
        this.previews = previews;
        this.runProjectCommand = runProjectCommand;
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
            status: body.task === "inspect" ? "ready" : staticRoot ? "passed" : "failed",
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
        return this.recordTaskResult({ ...base, valid: errors.length === 0, errors });
    }
    async buildStaticProject(options, signal) {
        const logs = [];
        appendProjectLog(logs, `Project root: ${options.projectDir}\n`);
        const packageJsonPath = join(options.projectDir, "package.json");
        const errors = validateBuildStaticProject(packageJsonPath, this.config);
        if (options.files.length === 0)
            errors.push("Project workspace is empty.");
        if (errors.length > 0)
            return buildStaticResult(options, "failed", false, "", errors, logs);
        try {
            const installCommand = this.config.projectInstallCommand.trim();
            if (installCommand) {
                await this.runProjectCommand(installCommand, options.projectDir, this.config.projectInstallTimeoutMs, logs, signal);
            }
            const buildCommand = this.config.projectBuildCommand.trim();
            if (buildCommand) {
                await this.runProjectCommand(buildCommand, options.projectDir, this.config.projectBuildTimeoutMs, logs, signal);
            }
            const staticRoot = findStaticServeRoot(options.projectDir, staticServeRootCandidates(true));
            if (!staticRoot) {
                throw new Error("Static build finished, but no index.html was found in the project root, dist, build, or public.");
            }
            appendProjectLog(logs, "Static build completed.\n");
            return buildStaticResult(options, "passed", true, staticRoot, [], logs);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            appendProjectLog(logs, message);
            return buildStaticResult(options, "failed", false, findStaticServeRoot(options.projectDir, staticServeRootCandidates(true)) || "", [message], logs);
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
function buildStaticResult(options, status, valid, serveRoot, errors, logs) {
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
    };
}
function validateBuildStaticProject(packageJsonPath, config) {
    const errors = [];
    if (!existsSync(packageJsonPath))
        errors.push("build_static requires package.json.");
    if (!config.projectBuildCommand.trim())
        errors.push("build_static requires a configured project build command.");
    if (config.projectInstallCommand.trim() && isUnsafeProjectCommand(config.projectInstallCommand)) {
        errors.push("Configured project install command is not allowed.");
    }
    if (config.projectBuildCommand.trim() && isUnsafeProjectCommand(config.projectBuildCommand)) {
        errors.push("Configured project build command is not allowed.");
    }
    const installScriptError = packageScriptCommandError(config.projectInstallCommand, "install");
    if (installScriptError)
        errors.push(installScriptError);
    const buildScriptError = packageScriptCommandError(config.projectBuildCommand, "build");
    if (buildScriptError)
        errors.push(buildScriptError);
    if (existsSync(packageJsonPath))
        errors.push(...unsafePackageScriptErrors(packageJsonPath));
    return errors;
}
function packageScriptCommandError(command, label) {
    if (!invokesPackageScript(command))
        return undefined;
    return `Configured project ${label} command invokes package scripts; package scripts are not allowed for build_static.`;
}
function invokesPackageScript(command) {
    const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
    if (!normalized)
        return false;
    return PACKAGE_SCRIPT_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}
const PACKAGE_SCRIPT_COMMAND_PATTERNS = [
    /(?:^|\b)(?:npm|npm\.cmd|pnpm|pnpm\.cmd|yarn|yarn\.cmd|bun|bun\.cmd)\s+(?:run|run-script)\b/,
    /(?:^|\b)(?:yarn|yarn\.cmd|pnpm|pnpm\.cmd)\s+(?!install\b|add\b|exec\b|dlx\b|create\b|init\b|config\b|cache\b|store\b|--version\b|-v\b)[^\s]+/,
];
function unsafePackageScriptErrors(packageJsonPath) {
    let packageJson;
    try {
        packageJson = readJsonFile(packageJsonPath);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return [`package.json could not be read: ${message}`];
    }
    if (!isObject(packageJson.scripts))
        return [];
    const errors = [];
    for (const [name, script] of Object.entries(packageJson.scripts)) {
        if (typeof script === "string" && isUnsafeProjectCommand(script)) {
            errors.push(`package.json script \`${name}\` contains a command that is not allowed.`);
        }
    }
    return errors;
}
//# sourceMappingURL=workspace-task-service.js.map