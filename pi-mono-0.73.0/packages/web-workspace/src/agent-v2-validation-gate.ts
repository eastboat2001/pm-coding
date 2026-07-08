import type { UpsertAgentV2ValidationInput } from "./agent-v2-store.js";
import { createAgentV2ToolFailure, type AgentV2ToolFailure } from "./agent-v2-tool-governance.js";
import type { ProjectTaskResult, StorageConfig } from "./types.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

export interface AgentV2ValidationGateContext {
	clientId: string;
	sessionId: string;
	title: string;
}

export interface RunAgentV2StaticValidationGateInput {
	config: StorageConfig;
	context: AgentV2ValidationGateContext;
	runId: string;
	taskId: string;
	now: string;
	tasks?: WorkspaceTaskService;
}

export type AgentV2ValidationFailure = AgentV2ToolFailure & {
	source: "static_validate" | "static_quality" | "static_smoke" | "preview";
};

export interface AgentV2ValidationGateResult {
	status: "passed" | "failed";
	failures: AgentV2ValidationFailure[];
	validation: UpsertAgentV2ValidationInput;
	rawResult: ProjectTaskResult;
}

export async function runAgentV2StaticValidationGate(
	input: RunAgentV2StaticValidationGateInput,
): Promise<AgentV2ValidationGateResult> {
	const tasks = input.tasks ?? new WorkspaceTaskService(input.config);
	const taskResult = await tasks.run({
		clientId: input.context.clientId,
		sessionId: input.context.sessionId,
		title: input.context.title,
		task: "validate",
	});
	const rawErrors = Array.isArray(taskResult.errors) ? taskResult.errors.map(String) : [];
	const failures = rawErrors.map((message) => classifyStaticValidationFailure(message, input.taskId));
	if (failures.length === 0 && taskResult.status === "failed") {
		failures.push(
			createFailure({
				code: "static.validation_failed",
				message: "Static validation failed.",
				retryable: true,
				source: "static_validate",
				taskId: input.taskId,
			}),
		);
	}

	const status = failures.length === 0 ? "passed" : "failed";
	return {
		status,
		failures,
		validation: {
			clientId: input.context.clientId,
			runId: input.runId,
			validationId: `static:${input.taskId}`,
			taskId: input.taskId,
			status,
			summary: status === "passed" ? "Static validation passed" : "Static validation failed",
			details: {
				failures,
				rawStatus: taskResult.status,
				projectRoot: taskResult.projectRoot,
				serveRoot: taskResult.serveRoot,
				fileCount: taskResult.fileCount,
			},
			createdAt: input.now,
			updatedAt: input.now,
		},
		rawResult: sanitizeProjectTaskResult(taskResult, failures),
	};
}

function classifyStaticValidationFailure(message: string, taskId: string): AgentV2ValidationFailure {
	const normalized = message.trim();
	if (normalized.startsWith("Static preview quality gate: ")) {
		return classifyQualityFailure(normalized.slice("Static preview quality gate: ".length), taskId);
	}
	if (normalized.startsWith("Static preview smoke gate: ")) {
		return classifySmokeFailure(normalized.slice("Static preview smoke gate: ".length), taskId);
	}
	if (normalized === "Project workspace is empty.") {
		return createFailure({
			code: "static.workspace_empty",
			message: "Workspace has no project files to validate.",
			retryable: true,
			source: "static_validate",
			taskId,
		});
	}

	const buildRequired = normalized.match(
		/^Static preview found a build source entry at (.+?)\. Run project_task build_static before project_task preview so PI can serve browser-ready dist\/build output\.$/,
	);
	if (buildRequired?.[1]) {
		return createFailure({
			code: "static.preview_build_required",
			message: `Static validation requires built browser output before preview checks can run (found ${normalizePath(buildRequired[1])}).`,
			retryable: false,
			source: "preview",
			taskId,
			path: normalizePath(buildRequired[1]),
			data: { detectedPath: normalizePath(buildRequired[1]) },
		});
	}

	if (
		normalized.includes("requires an index.html in the project root, dist, build, or public") ||
		normalized.includes("no index.html was found in the project root, dist, build, or public")
	) {
		return createFailure({
			code: "static.preview_missing_entry",
			message: "Static validation requires a browser-ready index.html in the project root, dist, build, or public.",
			retryable: false,
			source: "preview",
			taskId,
			path: "index.html",
		});
	}

	return createFailure({
		code: "static.validation_failed",
		message: "Static validation failed.",
		retryable: true,
		source: "static_validate",
		taskId,
	});
}

function classifyQualityFailure(message: string, taskId: string): AgentV2ValidationFailure {
	const selectorMismatch = message.match(/^JavaScript selector (#\S+) in (.+) does not match any HTML id\.$/);
	if (selectorMismatch) {
		return createFailure({
			code: "static.selector_missing",
			message: `Static validation found a selector without a matching HTML id: ${selectorMismatch[1]}.`,
			retryable: true,
			source: "static_quality",
			taskId,
			path: scriptPath(selectorMismatch[2]),
			data: { selector: selectorMismatch[1], scripts: selectorMismatch[2].split(", ").map(normalizePath) },
		});
	}

	const loadingVisible = message.match(/^Visible loading placeholder (#\S+) is not controlled by local JavaScript\.$/);
	if (loadingVisible) {
		return createFailure({
			code: "static.loading_visible",
			message: `Static validation found a visible loading placeholder that is never cleared: ${loadingVisible[1]}.`,
			retryable: true,
			source: "static_quality",
			taskId,
			path: "index.html",
			data: { selector: loadingVisible[1] },
		});
	}

	const metricPlaceholder = message.match(
		/^Metric placeholder (#\S+) starts as "--" but local JavaScript never updates it\.$/,
	);
	if (metricPlaceholder) {
		return createFailure({
			code: "static.metric_placeholder",
			message: `Static validation found a metric placeholder left at its bootstrap value: ${metricPlaceholder[1]}.`,
			retryable: true,
			source: "static_quality",
			taskId,
			path: "index.html",
			data: { selector: metricPlaceholder[1] },
		});
	}

	const localScriptMissing = message.match(/^Local script (.+) could not be read by the static quality gate\.$/);
	if (localScriptMissing?.[1]) {
		return createFailure({
			code: "static.local_script_missing",
			message: `Static validation could not read a local script referenced by the app shell: ${normalizePath(localScriptMissing[1])}.`,
			retryable: true,
			source: "static_quality",
			taskId,
			path: normalizePath(localScriptMissing[1]),
		});
	}

	return createFailure({
		code: "static.validation_failed",
		message: `Static quality validation failed: ${message}`,
		retryable: true,
		source: "static_quality",
		taskId,
		path: "index.html",
	});
}

function classifySmokeFailure(message: string, taskId: string): AgentV2ValidationFailure {
	const loadingVisible = message.match(/^Runtime smoke gate: loading element (#\S+) remained visible after startup\.$/);
	if (loadingVisible) {
		return createFailure({
			code: "static.loading_visible",
			message: `Static runtime validation found a loading placeholder still visible after startup: ${loadingVisible[1]}.`,
			retryable: true,
			source: "static_smoke",
			taskId,
			path: "index.html",
			data: { selector: loadingVisible[1] },
		});
	}

	const metricPlaceholder = message.match(
		/^Runtime smoke gate: metric placeholder (#\S+) still shows "--" after startup\.$/,
	);
	if (metricPlaceholder) {
		return createFailure({
			code: "static.metric_placeholder",
			message: `Static runtime validation found a metric placeholder still using its bootstrap value: ${metricPlaceholder[1]}.`,
			retryable: true,
			source: "static_smoke",
			taskId,
			path: "index.html",
			data: { selector: metricPlaceholder[1] },
		});
	}

	const localScriptMissing = message.match(/^Runtime smoke gate could not read local script (.+)\.$/);
	if (localScriptMissing?.[1]) {
		return createFailure({
			code: "static.local_script_missing",
			message: `Static runtime validation could not read a local script: ${normalizePath(localScriptMissing[1])}.`,
			retryable: true,
			source: "static_smoke",
			taskId,
			path: normalizePath(localScriptMissing[1]),
		});
	}

	if (
		message.startsWith("Runtime smoke gate: ") &&
		(message.includes("failed during") ||
			message.includes("handler failed") ||
			message.includes("timer callback failed") ||
			message.includes("console.error was called") ||
			message.includes("timer queue exceeded"))
	) {
		return createFailure({
			code: "static.script_error",
			message: collapseSmokeMessage(message),
			retryable: true,
			source: "static_smoke",
			taskId,
		});
	}

	return createFailure({
		code: "static.script_error",
		message: collapseSmokeMessage(message),
		retryable: true,
		source: "static_smoke",
		taskId,
	});
}

function createFailure(input: {
	code: string;
	message: string;
	retryable: boolean;
	source: AgentV2ValidationFailure["source"];
	taskId: string;
	path?: string;
	data?: Record<string, unknown>;
}): AgentV2ValidationFailure {
	return {
		...createAgentV2ToolFailure({
			code: input.code,
			message: input.message,
			retryable: input.retryable,
			phase: "validation",
			taskId: input.taskId,
			path: input.path,
			data: input.data ?? {},
		}),
		source: input.source,
	};
}

function sanitizeProjectTaskResult(
	taskResult: ProjectTaskResult,
	failures: AgentV2ValidationFailure[],
): ProjectTaskResult {
	if (failures.length === 0) return taskResult;
	return {
		...taskResult,
		errors: failures.map((failure) => failure.message),
	};
}

function collapseSmokeMessage(message: string): string {
	if (message.startsWith("Runtime smoke gate: ")) {
		return `Static runtime validation failed during startup: ${message.slice("Runtime smoke gate: ".length)}`;
	}
	return `Static runtime validation failed during startup: ${message}`;
}

function scriptPath(value: string): string | undefined {
	const [first] = value.split(", ");
	return first ? normalizePath(first) : undefined;
}

function normalizePath(value: string): string {
	return value.replace(/\\/g, "/");
}
