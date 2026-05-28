import { type Static, Type } from "typebox";
import { assertWritableProjectFileContent } from "./omitted-content.js";

export type ProjectToolContext = {
	sessionId?: string;
	title: string;
	activeSkillNames?: string[];
};

export type ProjectFileDetails = {
	command: string;
	filename?: string;
	action?: string;
	content?: string;
	files?: string[];
	fileCount?: number;
	projectRoot?: string;
};

export type ProjectTaskDetails = {
	task: "inspect" | "validate" | "build_static" | "preview" | "logs";
	status: string;
	projectId?: string;
	sessionId?: string;
	title?: string;
	projectRoot?: string;
	fileCount?: number;
	files?: string[];
	hasPackageJson?: boolean;
	valid?: boolean;
	errors?: string[];
	mode?: "static";
	previewUrl?: string;
	serveRoot?: string;
	logs?: string[];
	updatedAt?: string;
};

const filenameSchema = Type.String({
	description: "Relative file path inside the server project root, such as index.html or src/main.js.",
});

const contentSchema = Type.String({
	description: "Full file content. Required for create and rewrite.",
});

export const projectFileSchema = Type.Union(
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

export function prepareProjectFileArguments(args: unknown): ProjectFileParams {
	const raw = coerceRecord(args);
	const command = normalizeCommand(readString(raw, "command", "operation", "action", "op"));
	const filename = readString(raw, "filename", "path", "file", "filepath", "filePath", "name");
	const content = readString(raw, "content", "text", "code", "body", "file_content", "fileContent");
	const oldStr = readString(raw, "old_str", "oldStr", "old_string", "oldString", "old_text", "oldText");
	const newStr = readString(raw, "new_str", "newStr", "new_string", "newString", "new_text", "newText");

	if (command === "list") {
		return { command };
	}

	if (command === "create" || command === "rewrite") {
		if (!filename || content === undefined) {
			throw new Error(`project_file ${command} requires: ${projectFileExamples[command]}`);
		}
		assertWritableProjectFileContent(content, filename);
		return { command, filename, content };
	}

	if (command === "update") {
		if (!filename || !oldStr || newStr === undefined) {
			throw new Error(`project_file update requires: ${projectFileExamples.update}`);
		}
		assertWritableProjectFileContent(newStr, filename);
		return { command, filename, old_str: oldStr, new_str: newStr };
	}

	if (command === "get" || command === "delete") {
		if (!filename) {
			throw new Error(`project_file ${command} requires: ${projectFileExamples[command]}`);
		}
		return { command, filename };
	}

	throw new Error(
		`project_file command must be one of create, rewrite, update, get, delete, list. Example: ${projectFileExamples.create}`,
	);
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
	if (!("command" in args) && isRecord(nested)) return nested;
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

export const projectTaskSchema = Type.Object({
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

export type ProjectFileParams = Static<typeof projectFileSchema>;
export type ProjectTaskParams = Static<typeof projectTaskSchema>;
