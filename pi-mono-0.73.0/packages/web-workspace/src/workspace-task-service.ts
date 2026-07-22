import { existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { type BuildRunner, BuildRunnerError, type BuildRunnerFailureCode } from "./build-runner.js";
import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import { assessProjectEntryConsistency } from "./project-entry-consistency.js";
import { findBuildSourceEntry, findStaticServeRoot, staticServeRootCandidates } from "./static-preview.js";
import { assessStaticPreviewQuality } from "./static-preview-quality-gate.js";
import { runStaticPreviewSmokeGate } from "./static-preview-smoke-gate.js";
import type {
	PreviewRequestLike,
	ProjectTaskName,
	ProjectTaskRequest,
	ProjectTaskResult,
	StorageConfig,
} from "./types.js";
import { appendProjectLog, truncateProjectLogs } from "./workspace-command-service.js";
import { listProjectSourceFiles, workspaceContext } from "./workspace-paths.js";
import { WorkspacePreviewService } from "./workspace-preview-service.js";

export class WorkspaceTaskService {
	constructor(
		private readonly config: StorageConfig,
		private readonly buildRunner: BuildRunner,
		private readonly previews = new WorkspacePreviewService(config),
		private readonly diagnostics?: WorkspaceDiagnosticLogService,
	) {}

	async run(body: ProjectTaskRequest, req?: PreviewRequestLike, signal?: AbortSignal): Promise<ProjectTaskResult> {
		if (!isProjectTaskName(body.task)) {
			throw new Error("Field `task` must be one of: inspect, validate, build_static, preview, logs.");
		}

		if (body.task === "preview") {
			if (!req) throw new Error("Preview task requires request headers.");
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
			return this.recordTaskResult(
				await this.buildStaticProject({ projectId, sessionId, title, projectDir, files }, signal),
			);
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
			mode: "static" as const,
			serveRoot: staticRoot || "",
		};

		if (body.task === "inspect") return this.recordTaskResult(base);

		const errors: string[] = [];
		const warnings: string[] = [];
		if (files.length === 0) errors.push("Project workspace is empty.");
		const consistency = assessProjectEntryConsistency(projectDir);
		errors.push(...consistency.errors);
		if (!staticRoot && consistency.valid) {
			const buildSourceEntry =
				findBuildSourceEntry(projectDir, ["", "public"]) ||
				(hasPackageJson ? join(projectDir, "package.json") : undefined);
			errors.push(
				buildSourceEntry
					? `Static preview found a build source entry at ${buildSourceEntry}. Run build_static before preview so PI can serve browser-ready dist/build output.`
					: "Static preview requires an index.html in the project root, dist, build, or public. Package scripts, npm install, npm run build, and Node services are not started.",
			);
		}
		if (staticRoot && consistency.valid) {
			const quality = assessStaticPreviewQuality({ serveRoot: staticRoot });
			errors.push(...quality.errors.map((error) => `Static preview quality gate: ${error}`));
			warnings.push(...quality.warnings.map((warning) => `Static preview quality gate: ${warning}`));
			// Collect runtime evidence even when the static gate already found a
			// repairable issue. Otherwise an early false positive or small markup
			// defect hides broken interactions and forces serial repair cycles.
			const smoke = await runStaticPreviewSmokeGate({ serveRoot: staticRoot });
			errors.push(...smoke.errors.map((error) => `Static preview smoke gate: ${error}`));
			warnings.push(...smoke.warnings.map((warning) => `Static preview smoke gate: ${warning}`));
		}
		return this.recordTaskResult({
			...base,
			status: errors.length === 0 ? "passed" : "failed",
			valid: errors.length === 0,
			errors,
			warnings,
		});
	}

	private async buildStaticProject(
		options: {
			projectId: string;
			sessionId: string;
			title: string;
			projectDir: string;
			files: string[];
		},
		signal?: AbortSignal,
	): Promise<ProjectTaskResult> {
		const logs: string[] = [];
		appendProjectLog(logs, `Project root: ${options.projectDir}\n`);
		const packageJsonPath = join(options.projectDir, "package.json");
		const errors: string[] = [];
		if (!existsSync(packageJsonPath)) errors.push("build_static requires package.json.");
		if (options.files.length === 0) errors.push("Project workspace is empty.");
		if (errors.length === 0) errors.push(...assessProjectEntryConsistency(options.projectDir).errors);
		if (errors.length > 0)
			return buildStaticResult(options, "failed", false, "", errors, logs, "build.policy_rejected");

		try {
			const build = await this.buildRunner.build({
				projectId: "dist",
				projectRoot: options.projectDir,
				artifactRoot: options.projectDir,
				allowedOutputs: ["dist", "build", "public"],
				signal,
			});
			for (const log of build.logs) appendProjectLog(logs, log);
			appendProjectLog(logs, "Static build completed.\n");
			return buildStaticResult(options, "passed", true, build.serveRoot, [], logs);
		} catch (error) {
			const isBuildRunnerError = error instanceof BuildRunnerError;
			const message = isBuildRunnerError ? error.message : "Static build failed.";
			if (isBuildRunnerError) {
				for (const log of error.logs ?? []) appendProjectLog(logs, log);
			}
			appendProjectLog(logs, message);
			return buildStaticResult(
				options,
				"failed",
				false,
				findStaticServeRoot(options.projectDir, staticServeRootCandidates(true)) || "",
				[message],
				logs,
				isBuildRunnerError ? error.code : "build.execution_failed",
			);
		}
	}

	private recordTaskResult(result: ProjectTaskResult): ProjectTaskResult {
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

function isProjectTaskName(value: string): value is ProjectTaskName {
	return (
		value === "inspect" || value === "validate" || value === "build_static" || value === "preview" || value === "logs"
	);
}

function buildStaticResult(
	options: { projectId: string; sessionId: string; title: string; projectDir: string; files: string[] },
	status: "passed" | "failed",
	valid: boolean,
	serveRoot: string,
	errors: string[],
	logs: string[],
	failureCode?: BuildRunnerFailureCode,
): ProjectTaskResult {
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
