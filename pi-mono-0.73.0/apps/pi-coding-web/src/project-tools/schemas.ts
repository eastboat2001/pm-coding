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

export type ProjectBashDetails = {
	command: string;
	output: string;
	projectRoot: string;
};

export type ProjectPreviewDetails = {
	status: string;
	previewUrl: string;
	projectRoot: string;
	serveRoot: string;
	fileCount: number;
	logs?: string[];
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

export const projectBashSchema = Type.Object({
	command: Type.String({
		description:
			"Short non-interactive command to run in the server project root, such as npm test, npm run build, or node scripts. Do not start long-running dev servers. If a command fails, use the returned error/output to choose a compatible follow-up command.",
	}),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds, max 300000." })),
});

export const projectPreviewSchema = Type.Object({
	note: Type.Optional(Type.String({ description: "Brief note describing what is ready to preview." })),
});

export type ProjectFileParams = Static<typeof projectFileSchema>;
export type ProjectBashParams = Static<typeof projectBashSchema>;
export type ProjectPreviewParams = Static<typeof projectPreviewSchema>;
