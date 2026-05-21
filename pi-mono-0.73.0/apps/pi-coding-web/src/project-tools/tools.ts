import type { AgentTool } from "@mariozechner/pi-agent-core";
import { requestProjectApi } from "./client.js";
import { registerProjectToolRenderers } from "./renderers.js";
import {
	type ProjectFileDetails,
	type ProjectTaskDetails,
	type ProjectToolContext,
	projectFileSchema,
	projectTaskSchema,
} from "./schemas.js";

export function createServerProjectTools(getContext: () => ProjectToolContext): AgentTool<any>[] {
	registerProjectToolRenderers();
	return [createProjectFileTool(getContext), createProjectTaskTool(getContext)];
}

function createProjectFileTool(
	getContext: () => ProjectToolContext,
): AgentTool<typeof projectFileSchema, ProjectFileDetails> {
	return {
		label: "Project File",
		name: "project_file",
		description:
			"Create, rewrite, update, read, delete, or list files in the configured server project root. Use this instead of browser artifacts when generating runnable apps.",
		parameters: projectFileSchema,
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectFileDetails>(
				"/api/pi-projects/workspace/file",
				{
					...getRequiredContext(getContext),
					...args,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: formatProjectFileResult(result) }],
				details: result,
			};
		},
	};
}

function createProjectTaskTool(
	getContext: () => ProjectToolContext,
): AgentTool<typeof projectTaskSchema, ProjectTaskDetails> {
	return {
		label: "Project Task",
		name: "project_task",
		description:
			"Run a controlled static project task in the configured server project root. Available tasks are inspect, validate, build_static, preview, and logs. This tool never accepts raw shell commands; build_static runs only the server-configured install/build commands and preview serves only static output.",
		parameters: projectTaskSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectTaskDetails>(
				"/api/pi-projects/workspace/task",
				{
					...getRequiredContext(getContext),
					...args,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: formatProjectTaskResult(result) }],
				details: result,
			};
		},
	};
}

function getRequiredContext(getContext: () => ProjectToolContext): ProjectToolContext {
	const context = getContext();
	if (!context.sessionId)
		throw new Error("Cannot use project workspace tools before the current session has been created.");
	return context;
}

function formatProjectFileResult(result: ProjectFileDetails): string {
	if (result.command === "list") return (result.files || []).join("\n") || "(no files)";
	if (result.command === "get") return result.content || "";
	return `${result.action || result.command}: ${result.filename}`;
}

export function formatProjectTaskResult(result: ProjectTaskDetails): string {
	return [
		`Task: ${result.task}`,
		`Status: ${result.status}`,
		result.mode ? `Mode: ${result.mode}` : "",
		result.previewUrl ? `Preview URL: ${result.previewUrl}` : "",
		result.projectRoot ? `Project root: ${result.projectRoot}` : "",
		result.serveRoot ? `Serve root: ${result.serveRoot}` : "",
		typeof result.fileCount === "number" ? `Files: ${result.fileCount}` : "",
		typeof result.valid === "boolean" ? `Valid: ${result.valid ? "yes" : "no"}` : "",
		result.errors?.length ? `Errors:\n${result.errors.join("\n")}` : "",
		result.files?.length ? `Project files:\n${result.files.join("\n")}` : "",
		result.logs?.length ? `\nLogs:\n${result.logs.join("").trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
