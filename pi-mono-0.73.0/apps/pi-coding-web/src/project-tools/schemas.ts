import { type Static, Type } from "typebox";

export type ProjectToolContext = {
	sessionId?: string;
	title: string;
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

export const projectFileSchema = Type.Object({
	command: Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("rewrite"),
			Type.Literal("update"),
			Type.Literal("get"),
			Type.Literal("delete"),
			Type.Literal("list"),
		],
		{
			description:
				"File operation. Use create for new files, rewrite for full replacement, update for exact text replacement, get to inspect a file, list to list files, delete to remove a file.",
		},
	),
	filename: Type.Optional(
		Type.String({
			description: "Relative file path inside the server project root, such as index.html or src/main.js.",
		}),
	),
	content: Type.Optional(Type.String({ description: "Full file content for create/rewrite." })),
	old_str: Type.Optional(Type.String({ description: "Exact text to replace for update." })),
	new_str: Type.Optional(Type.String({ description: "Replacement text for update." })),
});

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
