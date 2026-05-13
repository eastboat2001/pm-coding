import "@mariozechner/mini-lit/dist/CodeBlock.js";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import { i18n, registerToolRenderer, renderCollapsibleHeader, renderHeader, type ToolRenderer, type ToolRenderResult } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2, Play, Rocket } from "lucide";
import { type Static, Type } from "typebox";

type ProjectToolContext = {
	sessionId?: string;
	title: string;
};

type ProjectFileDetails = {
	command: string;
	filename?: string;
	action?: string;
	content?: string;
	files?: string[];
	fileCount?: number;
	projectRoot?: string;
};

type ProjectBashDetails = {
	command: string;
	output: string;
	projectRoot: string;
};

type ProjectPreviewDetails = {
	status: string;
	previewUrl: string;
	projectRoot: string;
	serveRoot: string;
	fileCount: number;
	logs?: string[];
};

const projectFileSchema = Type.Object({
	command: Type.Union([
		Type.Literal("create"),
		Type.Literal("rewrite"),
		Type.Literal("update"),
		Type.Literal("get"),
		Type.Literal("delete"),
		Type.Literal("list"),
	], {
		description:
			"File operation. Use create for new files, rewrite for full replacement, update for exact text replacement, get to inspect a file, list to list files, delete to remove a file.",
	}),
	filename: Type.Optional(Type.String({ description: "Relative file path inside the server project root, such as index.html or src/main.js." })),
	content: Type.Optional(Type.String({ description: "Full file content for create/rewrite." })),
	old_str: Type.Optional(Type.String({ description: "Exact text to replace for update." })),
	new_str: Type.Optional(Type.String({ description: "Replacement text for update." })),
});

const projectBashSchema = Type.Object({
	command: Type.String({
		description:
			"Short non-interactive command to run in the server project root, such as npm test, npm run build, or node scripts. Do not start long-running dev servers. If a command fails, use the returned error/output to choose a compatible follow-up command.",
	}),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds, max 300000." })),
});

const projectPreviewSchema = Type.Object({
	note: Type.Optional(Type.String({ description: "Brief note describing what is ready to preview." })),
});

type ProjectFileParams = Static<typeof projectFileSchema>;
type ProjectBashParams = Static<typeof projectBashSchema>;
type ProjectPreviewParams = Static<typeof projectPreviewSchema>;

export function createServerProjectTools(getContext: () => ProjectToolContext): AgentTool<any>[] {
	return [
		createProjectFileTool(getContext),
		createProjectBashTool(getContext),
		createProjectPreviewTool(getContext),
	];
}

function createProjectFileTool(getContext: () => ProjectToolContext): AgentTool<typeof projectFileSchema, ProjectFileDetails> {
	return {
		label: "Project File",
		name: "project_file",
		description:
			"Create, rewrite, update, read, delete, or list files in the configured server project root. Use this instead of browser artifacts when generating runnable apps.",
		parameters: projectFileSchema,
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectFileDetails>("/api/pi-projects/workspace/file", {
				...getRequiredContext(getContext),
				...args,
			}, signal);
			return {
				content: [{ type: "text", text: formatProjectFileResult(result) }],
				details: result,
			};
		},
	};
}

function createProjectBashTool(getContext: () => ProjectToolContext): AgentTool<typeof projectBashSchema, ProjectBashDetails> {
	return {
		label: "Project Bash",
		name: "project_bash",
		description:
			"Run a short non-interactive shell command in the configured server project root. Use it to inspect, test, install, or build. Never start a long-running dev server. Failed commands return their output and server environment so the next command can be adjusted.",
		parameters: projectBashSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectBashDetails>("/api/pi-projects/workspace/bash", {
				...getRequiredContext(getContext),
				...args,
			}, signal);
			return {
				content: [{ type: "text", text: result.output }],
				details: result,
			};
		},
	};
}

function createProjectPreviewTool(getContext: () => ProjectToolContext): AgentTool<typeof projectPreviewSchema, ProjectPreviewDetails> {
	return {
		label: "Project Preview",
		name: "project_preview",
		description:
			"Install/build the current server project workspace if needed, serve it through PI Server, and return the Preview URL. Call this after project files are ready.",
		parameters: projectPreviewSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, args, signal) => {
			const result = await requestProjectApi<ProjectPreviewDetails>("/api/pi-projects/workspace/preview", {
				...getRequiredContext(getContext),
				...args,
			}, signal);
			return {
				content: [{ type: "text", text: formatPreviewResult(result) }],
				details: result,
			};
		},
	};
}

function getRequiredContext(getContext: () => ProjectToolContext): ProjectToolContext {
	const context = getContext();
	if (!context.sessionId) {
		throw new Error("Cannot use project workspace tools before the current session has been created.");
	}
	return context;
}

async function requestProjectApi<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
	const endpoint = new URL(path, window.location.origin).toString();
	let response: Response;
	try {
		response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError") throw new Error("请求已取消。");
		throw new Error(`无法连接 PI Server API：${endpoint}。原始错误：${error instanceof Error ? error.message : String(error)}`);
	}
	const result = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(result.error || `Project API failed with HTTP ${response.status}`);
	}
	return result as T;
}

function formatProjectFileResult(result: ProjectFileDetails): string {
	if (result.command === "list") return (result.files || []).join("\n") || "(no files)";
	if (result.command === "get") return result.content || "";
	return `${result.action || result.command}: ${result.filename}`;
}

function formatPreviewResult(result: ProjectPreviewDetails): string {
	return [
		`Status: ${result.status}`,
		`Preview URL: ${result.previewUrl}`,
		`Project root: ${result.projectRoot}`,
		`Serve root: ${result.serveRoot}`,
		`Files: ${result.fileCount}`,
		result.logs?.length ? `\nLogs:\n${result.logs.join("").trim()}` : "",
	].filter(Boolean).join("\n");
}

function getTextOutput(result: ToolResultMessage<any> | undefined): string {
	return result?.content?.filter((content) => content.type === "text").map((content: any) => content.text).join("\n") || "";
}

function getLanguageFromFilename(filename?: string): string {
	const ext = filename?.split(".").pop()?.toLowerCase();
	const languageMap: Record<string, string> = {
		html: "html",
		css: "css",
		js: "javascript",
		jsx: "javascript",
		ts: "typescript",
		tsx: "typescript",
		json: "json",
		md: "markdown",
		py: "python",
		sh: "bash",
		yml: "yaml",
		yaml: "yaml",
	};
	return languageMap[ext || ""] || "text";
}

function filePill(filename?: string): TemplateResult | string {
	if (!filename) return "";
	return html`<span class="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-mono bg-background">${filename}</span>`;
}

class ProjectFileRenderer implements ToolRenderer<ProjectFileParams, ProjectFileDetails> {
	render(params: ProjectFileParams | undefined, result: ToolResultMessage<ProjectFileDetails> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const details = result?.details;
		const command = details?.command || params?.command || "file";
		const filename = details?.filename || params?.filename;
		const labels: Record<string, { active: string; done: string }> = {
			create: { active: i18n("Creating file"), done: details?.action === "updated" ? i18n("Updated file") : i18n("Created file") },
			rewrite: { active: i18n("Rewriting file"), done: details?.action === "created" ? i18n("Created file") : i18n("Updated file") },
			update: { active: i18n("Updating file"), done: i18n("Updated file") },
			get: { active: i18n("Reading file"), done: i18n("Read file") },
			delete: { active: i18n("Deleting file"), done: i18n("Deleted file") },
			list: { active: i18n("Listing project files"), done: i18n("Listed project files") },
		};
		const label = state === "inprogress" ? labels[command]?.active || i18n("Processing file") : labels[command]?.done || i18n("Processed file");
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const code = params?.content || details?.content || getTextOutput(result);
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(state, FileCode2, html`<span>${label} ${filePill(filename)}</span>`, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300 space-y-3">
						${
							code
								? html`<code-block .code=${code} language=${getLanguageFromFilename(filename)}></code-block>`
								: details?.files
									? html`<code-block .code=${details.files.join("\n")} language="text"></code-block>`
									: ""
						}
					</div>
				</div>
			`,
		};
	}
}

class ProjectBashRenderer implements ToolRenderer<ProjectBashParams, ProjectBashDetails> {
	render(params: ProjectBashParams | undefined, result: ToolResultMessage<ProjectBashDetails> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const command = result?.details?.command || params?.command || "";
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(
						state,
						Play,
						state === "inprogress" ? `${i18n("Running command")} ${command}` : `${i18n("Ran command")} ${command}`,
						contentRef,
						chevronRef,
					)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<code-block .code=${result?.details?.output || getTextOutput(result) || command} language="text"></code-block>
					</div>
				</div>
			`,
		};
	}
}

class ProjectPreviewRenderer implements ToolRenderer<ProjectPreviewParams, ProjectPreviewDetails> {
	render(_params: ProjectPreviewParams | undefined, result: ToolResultMessage<ProjectPreviewDetails> | undefined, isStreaming?: boolean): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const details = result?.details;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const header = details?.previewUrl
			? html`<span>${i18n("Preview ready")} <a class="underline" href=${details.previewUrl} target="_blank" rel="noreferrer">${details.previewUrl}</a></span>`
			: state === "inprogress"
				? i18n("Preparing preview")
				: i18n("Prepared preview");
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(state, Rocket, header, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${details ? html`<code-block .code=${formatPreviewResult(details)} language="text"></code-block>` : ""}
					</div>
				</div>
			`,
		};
	}
}

registerToolRenderer("project_file", new ProjectFileRenderer());
registerToolRenderer("project_bash", new ProjectBashRenderer());
registerToolRenderer("project_preview", new ProjectPreviewRenderer());
