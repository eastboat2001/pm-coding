import type { AgentTool } from "@mariozechner/pi-agent-core";
import { requestProjectApi } from "./client.js";
import { registerProjectToolRenderers } from "./renderers.js";
import {
	type ProjectBashDetails,
	type ProjectFileDetails,
	type ProjectPreviewDetails,
	type ProjectToolContext,
	projectBashSchema,
	projectFileSchema,
	projectPreviewSchema,
} from "./schemas.js";

export function createServerProjectTools(getContext: () => ProjectToolContext): AgentTool<any>[] {
	registerProjectToolRenderers();
	return [createProjectFileTool(getContext), createProjectBashTool(getContext), createProjectPreviewTool(getContext)];
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

function createProjectBashTool(
	getContext: () => ProjectToolContext,
): AgentTool<typeof projectBashSchema, ProjectBashDetails> {
	return {
		label: "Project Bash",
		name: "project_bash",
		description:
			"Run a short non-interactive shell command in the configured server project root. Use it to inspect, test, install, or build. Never start a long-running dev server or kill global Node processes. Failed commands return their output and server environment so the next command can be adjusted.",
		parameters: projectBashSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectBashDetails>(
				"/api/pi-projects/workspace/bash",
				{
					...getRequiredContext(getContext),
					...args,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	};
}

function createProjectPreviewTool(
	getContext: () => ProjectToolContext,
): AgentTool<typeof projectPreviewSchema, ProjectPreviewDetails> {
	return {
		label: "Project Preview",
		name: "project_preview",
		description:
			"Install/build the current server project workspace if needed, serve static output or start one Node HTTP service behind the PI preview proxy, and return the final Preview URL. Call this after project files are ready.",
		parameters: projectPreviewSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectPreviewDetails>(
				"/api/pi-projects/workspace/preview",
				{
					...getRequiredContext(getContext),
					...args,
				},
				signal,
			);
			return {
				content: [{ type: "text", text: formatPreviewResult(result) }],
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

export function formatPreviewResult(result: ProjectPreviewDetails): string {
	return [
		`Status: ${result.status}`,
		result.mode ? `Mode: ${result.mode}` : "",
		result.previewUrl ? `Preview URL: ${result.previewUrl}` : "",
		`Project root: ${result.projectRoot}`,
		`Serve root: ${result.serveRoot}`,
		result.startCommand ? `Start command: ${result.startCommand}` : "",
		result.servicePort ? `Internal service port: ${result.servicePort} (proxied by Preview URL)` : "",
		`Files: ${result.fileCount}`,
		result.logs?.length ? `\nLogs:\n${result.logs.join("").trim()}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
