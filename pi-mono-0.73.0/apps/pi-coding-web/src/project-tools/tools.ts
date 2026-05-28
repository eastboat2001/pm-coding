import type { AgentTool } from "@mariozechner/pi-agent-core";
import { requestProjectApi } from "./client.js";
import { registerProjectToolRenderers } from "./renderers.js";
import { formatProjectFileResult, formatProjectTaskResult } from "./result-format.js";
import {
	type ProjectFileDetails,
	type ProjectTaskDetails,
	type ProjectToolContext,
	prepareProjectFileArguments,
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
			"Create, rewrite, update, get, delete, or list files in the configured server project root. create/rewrite require filename and content in the same call. Use this instead of browser artifacts when generating runnable apps.",
		parameters: projectFileSchema,
		prepareArguments: prepareProjectFileArguments,
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

export { formatProjectTaskResult } from "./result-format.js";

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
			const context = getRequiredContext(getContext);
			const result = await requestProjectApi<ProjectTaskDetails>(
				"/api/pi-projects/workspace/task",
				{
					...context,
					...args,
				},
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text: formatProjectTaskResult(result, { activeSkillNames: context.activeSkillNames }),
					},
				],
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
