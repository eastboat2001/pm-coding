import { type Static, type TSchema, Type } from "typebox";
import type { WorkspaceDiagnosticLogService } from "./diagnostic-log-service.js";
import type {
	PreviewRequestLike,
	ProjectFileResult,
	ProjectTaskResult,
	ProjectWorkspaceContext,
	SkillLoadResult,
	SkillResourceResult,
	StorageConfig,
} from "./types.js";
import { WorkspaceFileService } from "./workspace-file-service.js";
import { WorkspaceSkillService } from "./workspace-skill-service.js";
import { WorkspaceTaskService } from "./workspace-task-service.js";

type ServerDirectProjectToolContext = Pick<ProjectWorkspaceContext, "sessionId" | "title"> & {
	activeSkillNames?: string[];
};

type ServerDirectTextContent = {
	type: "text";
	text: string;
};

type ServerDirectToolResult<TDetails> = {
	content: ServerDirectTextContent[];
	details: TDetails;
	terminate?: boolean;
};

type ServerDirectToolExecutionMode = "sequential" | "parallel";

export interface ServerDirectAgentTool<TParameters extends TSchema = TSchema, TDetails = unknown> {
	label: string;
	name: string;
	description?: string;
	parameters: TParameters;
	prepareArguments?: (args: unknown) => Static<TParameters>;
	execute: (
		toolCallId: string,
		params: Static<TParameters>,
		signal?: AbortSignal,
		onUpdate?: (partialResult: ServerDirectToolResult<TDetails>) => void,
	) => Promise<ServerDirectToolResult<TDetails>>;
	executionMode?: ServerDirectToolExecutionMode;
}

const filenameSchema = Type.String({
	description: "Relative file path inside the server project root, such as index.html or src/main.js.",
});

const contentSchema = Type.String({
	description: "Full file content. Required for create and rewrite.",
});

const projectFileSchema = Type.Union(
	[
		Type.Object(
			{
				command: Type.Literal("create", { description: "Create or overwrite a file." }),
				filename: filenameSchema,
				content: contentSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				command: Type.Literal("rewrite", { description: "Replace a file with full new content." }),
				filename: filenameSchema,
				content: contentSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				command: Type.Literal("update", { description: "Replace exact text inside an existing file." }),
				filename: filenameSchema,
				old_str: Type.String({ description: "Exact text to replace." }),
				new_str: Type.String({ description: "Replacement text." }),
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				command: Type.Literal("get", { description: "Read a file." }),
				filename: filenameSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				command: Type.Literal("delete", { description: "Delete a file." }),
				filename: filenameSchema,
			},
			{ additionalProperties: false },
		),
		Type.Object(
			{
				command: Type.Literal("list", { description: "List project files." }),
			},
			{ additionalProperties: false },
		),
	],
	{
		description:
			"Project file operation. create/rewrite require filename and content in the same call. update requires filename, old_str, and new_str. get/delete require filename. list requires only command.",
	},
);

const projectTaskSchema = Type.Object({
	task: Type.Union(
		[
			Type.Literal("inspect"),
			Type.Literal("validate"),
			Type.Literal("build_static"),
			Type.Literal("preview"),
			Type.Literal("logs"),
		],
		{
			description:
				"Controlled static project task. Use inspect to list workspace state, validate to check static preview readiness, build_static to run the server-configured static frontend build, preview to publish the static app and get the Preview URL, and logs to read the last preview logs.",
		},
	),
});

const skillLoadSchema = Type.Object(
	{
		name: Type.String({
			description: "Configured global skill name, such as ui-polish.",
		}),
	},
	{ additionalProperties: false },
);

const skillResourceSchema = Type.Object(
	{
		name: Type.String({
			description: "Configured global skill name that owns the resource.",
		}),
		path: Type.String({
			description: "Relative path inside the skill directory, such as references/rules.md.",
		}),
	},
	{ additionalProperties: false },
);

type ProjectFileParams = Static<typeof projectFileSchema>;
type SkillLoadParams = Static<typeof skillLoadSchema>;
type SkillResourceParams = Static<typeof skillResourceSchema>;

export function createServerDirectSkillTools(
	config: StorageConfig,
	diagnostics?: WorkspaceDiagnosticLogService,
): Array<ServerDirectAgentTool<TSchema, SkillLoadResult | SkillResourceResult>> {
	const skills = new WorkspaceSkillService(config, diagnostics);
	return [createSkillLoadTool(skills), createSkillResourceTool(skills)];
}

export function createServerDirectProjectTools(
	config: StorageConfig,
	context: ServerDirectProjectToolContext,
	diagnostics?: WorkspaceDiagnosticLogService,
): Array<ServerDirectAgentTool<TSchema, ProjectFileResult | ProjectTaskResult>> {
	const files = new WorkspaceFileService(config);
	const tasks = new WorkspaceTaskService(config, undefined, undefined, diagnostics);
	return [createProjectFileTool(files, context), createProjectTaskTool(tasks, context, config)];
}

function createProjectFileTool(
	files: WorkspaceFileService,
	context: ServerDirectProjectToolContext,
): ServerDirectAgentTool<typeof projectFileSchema, ProjectFileResult> {
	return {
		label: "Project File",
		name: "project_file",
		description:
			"Create, rewrite, update, get, delete, or list files in the configured server project root. create/rewrite require filename and content in the same call. Use this instead of browser artifacts when generating runnable apps.",
		parameters: projectFileSchema,
		prepareArguments: prepareProjectFileArguments,
		execute: async (_toolCallId, args) => {
			const result = files.handle({ ...getRequiredContext(context), ...args });
			return {
				content: [{ type: "text", text: formatProjectFileResult(result) }],
				details: result,
			};
		},
	};
}

function createProjectTaskTool(
	tasks: WorkspaceTaskService,
	context: ServerDirectProjectToolContext,
	config: StorageConfig,
): ServerDirectAgentTool<typeof projectTaskSchema, ProjectTaskResult> {
	return {
		label: "Project Task",
		name: "project_task",
		description:
			"Run a controlled static project task in the configured server project root. Available tasks are inspect, validate, build_static, preview, and logs. This tool never accepts raw shell commands; build_static runs only the server-configured install/build commands.",
		parameters: projectTaskSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const requiredContext = getRequiredContext(context);
			const result = await tasks.run(
				{ ...requiredContext, ...args },
				args.task === "preview" ? createServerDirectPreviewRequest(config) : undefined,
				signal,
			);
			return {
				content: [
					{
						type: "text",
						text: formatProjectTaskResult(result, { activeSkillNames: requiredContext.activeSkillNames }),
					},
				],
				details: result,
			};
		},
	};
}

function createServerDirectPreviewRequest(config: StorageConfig): PreviewRequestLike {
	if (config.previewBaseUrl) {
		const url = new URL(config.previewBaseUrl);
		return { headers: { host: url.host, "x-forwarded-proto": url.protocol.replace(/:$/, "") } };
	}
	return { headers: { host: "localhost", "x-forwarded-proto": "http" } };
}

function createSkillLoadTool(
	skills: WorkspaceSkillService,
): ServerDirectAgentTool<typeof skillLoadSchema, SkillLoadResult> {
	return {
		label: "Skill Load",
		name: "skill_load",
		description:
			"Load the SKILL.md instructions for a configured global skill by name. Use this when the task matches a skill listed in the system prompt. This tool only reads server-configured skill instructions and cannot read arbitrary files.",
		parameters: skillLoadSchema,
		prepareArguments: prepareSkillLoadArguments,
		execute: async (_toolCallId, args) => {
			const result = skills.load(args);
			return {
				content: [{ type: "text", text: formatSkillLoadResult(result) }],
				details: result,
			};
		},
	};
}

function createSkillResourceTool(
	skills: WorkspaceSkillService,
): ServerDirectAgentTool<typeof skillResourceSchema, SkillResourceResult> {
	return {
		label: "Skill Resource",
		name: "skill_resource",
		description:
			"Read a text resource referenced by a loaded global skill. Parameters are the skill name and a relative path inside that skill directory. This tool is read-only, cannot execute scripts, and cannot access project files or arbitrary server files.",
		parameters: skillResourceSchema,
		prepareArguments: prepareSkillResourceArguments,
		execute: async (_toolCallId, args) => {
			const result = skills.readResource(args);
			return {
				content: [{ type: "text", text: result.content }],
				details: result,
			};
		},
	};
}

function getRequiredContext(context: ServerDirectProjectToolContext): ServerDirectProjectToolContext {
	if (!context.sessionId) {
		throw new Error("Cannot use project workspace tools before the current session has been created.");
	}
	return context;
}

const projectFileExamples = {
	create: '{"command":"create","filename":"index.html","content":"完整文件内容"}',
	rewrite: '{"command":"rewrite","filename":"index.html","content":"完整文件内容"}',
	update: '{"command":"update","filename":"src/main.js","old_str":"原文本","new_str":"新文本"}',
	get: '{"command":"get","filename":"index.html"}',
	delete: '{"command":"delete","filename":"old.js"}',
	list: '{"command":"list"}',
};

const commandAliases: Record<string, ProjectFileParams["command"]> = {
	create: "create",
	write: "create",
	add: "create",
	rewrite: "rewrite",
	replace: "rewrite",
	overwrite: "rewrite",
	update: "update",
	patch: "update",
	edit: "update",
	get: "get",
	read: "get",
	open: "get",
	delete: "delete",
	remove: "delete",
	list: "list",
	ls: "list",
};

function prepareProjectFileArguments(args: unknown): ProjectFileParams {
	const raw = coerceRecord(args);
	const command = normalizeCommand(readString(raw, "command", "operation", "action", "op"));
	const filename = readString(raw, "filename", "path", "file", "filepath", "filePath", "name");
	const content = readString(raw, "content", "text", "code", "body", "file_content", "fileContent");
	const oldStr = readString(raw, "old_str", "oldStr", "old_string", "oldString", "old_text", "oldText");
	const newStr = readString(raw, "new_str", "newStr", "new_string", "newString", "new_text", "newText");

	if (command === "list") return { command };
	if (command === "create" || command === "rewrite") {
		if (!filename || content === undefined) {
			throw new Error(`project_file ${command} requires: ${projectFileExamples[command]}`);
		}
		return { command, filename, content };
	}
	if (command === "update") {
		if (!filename || !oldStr || newStr === undefined) {
			throw new Error(`project_file update requires: ${projectFileExamples.update}`);
		}
		return { command, filename, old_str: oldStr, new_str: newStr };
	}
	if (command === "get" || command === "delete") {
		if (!filename) throw new Error(`project_file ${command} requires: ${projectFileExamples[command]}`);
		return { command, filename };
	}
	throw new Error(
		`project_file command must be one of create, rewrite, update, get, delete, list. Example: ${projectFileExamples.create}`,
	);
}

function prepareSkillLoadArguments(args: unknown): SkillLoadParams {
	const raw = coerceRecord(args);
	const name = readString(raw, "name", "skill", "skillName", "skill_name");
	if (!name) throw new Error('skill_load requires: {"name":"skill-name"}');
	return { name };
}

function prepareSkillResourceArguments(args: unknown): SkillResourceParams {
	const raw = coerceRecord(args);
	const name = readString(raw, "name", "skill", "skillName", "skill_name");
	const path = readString(raw, "path", "resource", "resourcePath", "resource_path", "file", "filename");
	if (!name || !path) {
		throw new Error('skill_resource requires: {"name":"skill-name","path":"references/file.md"}');
	}
	return { name, path };
}

function coerceRecord(args: unknown): Record<string, unknown> {
	if (typeof args === "string") {
		try {
			const parsed = JSON.parse(args);
			if (isRecord(parsed)) return parsed;
		} catch {
			return {};
		}
	}
	if (!isRecord(args)) return {};
	const nested = args.arguments;
	if (!("command" in args) && !("name" in args) && isRecord(nested)) return nested;
	return args;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

function normalizeCommand(command: string | undefined): ProjectFileParams["command"] | undefined {
	if (!command) return undefined;
	return commandAliases[command.trim().toLowerCase()];
}

function formatProjectFileResult(result: ProjectFileResult): string {
	if (result.command === "list") return (result.files || []).join("\n") || "(no files)";
	if (result.command === "get") return result.content || "";
	return `${result.action || result.command}: ${result.filename}`;
}

function formatProjectTaskResult(result: ProjectTaskResult, options: { activeSkillNames?: string[] } = {}): string {
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
		formatSkillAuditReminder(result, options.activeSkillNames),
	]
		.filter(Boolean)
		.join("\n");
}

function formatSkillAuditReminder(result: ProjectTaskResult, activeSkillNames: string[] | undefined): string {
	if (result.task !== "preview" || !activeSkillNames?.length) return "";
	return [
		"",
		"Skill audit required before final response:",
		"Before finalizing, audit the generated project against all active selected skills:",
		...activeSkillNames.map((name) => `- ${name}`),
		"If any selected skill is not reflected in the current project, update the files and run preview again.",
	].join("\n");
}

function formatSkillLoadResult(result: SkillLoadResult): string {
	const resources =
		result.resources.length > 0
			? `\n\nAvailable skill resources:\n${result.resources
					.map((resource) => `- ${resource.path} (${resource.size} bytes)`)
					.join("\n")}`
			: "";
	return [
		`Skill: ${result.name}`,
		result.interface?.displayName ? `Display name: ${result.interface.displayName}` : "",
		result.interface?.shortDescription ? `Short description: ${result.interface.shortDescription}` : "",
		`Location: ${result.location}`,
		result.interface?.defaultPrompt ? `Default prompt: ${result.interface.defaultPrompt}` : "",
		"References are relative to this skill. Use skill_resource to read listed relative resources when needed.",
		"",
		`<skill name="${escapeXml(result.name)}" location="${escapeXml(result.location)}">`,
		result.content,
		"</skill>",
		resources,
	]
		.filter(Boolean)
		.join("\n");
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}
