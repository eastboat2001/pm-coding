import "@mariozechner/mini-lit/dist/CodeBlock.js";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	i18n,
	registerToolRenderer,
	renderCollapsibleHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { FileCode2, Rocket } from "lucide";
import type { ProjectFileDetails, ProjectFileParams, ProjectTaskDetails, ProjectTaskParams } from "./schemas.js";

let registered = false;

export function registerProjectToolRenderers(): void {
	if (registered) return;
	registered = true;
	registerToolRenderer("project_file", new ProjectFileRenderer());
	registerToolRenderer("project_task", new ProjectTaskRenderer());
}

function getTextOutput(result: ToolResultMessage<unknown> | undefined): string {
	return (
		result?.content
			?.filter((content) => content.type === "text")
			.map((content) => String((content as { text?: unknown }).text || ""))
			.join("\n") || ""
	);
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

function formatProjectTaskResult(result: ProjectTaskDetails): string {
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

class ProjectFileRenderer implements ToolRenderer<ProjectFileParams, ProjectFileDetails> {
	render(
		params: ProjectFileParams | undefined,
		result: ToolResultMessage<ProjectFileDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const details = result?.details;
		const command = details?.command || params?.command || "file";
		const filename = details?.filename || params?.filename;
		const labels: Record<string, { active: string; done: string }> = {
			create: {
				active: i18n("Creating file"),
				done: details?.action === "updated" ? i18n("Updated file") : i18n("Created file"),
			},
			rewrite: {
				active: i18n("Rewriting file"),
				done: details?.action === "created" ? i18n("Created file") : i18n("Updated file"),
			},
			update: { active: i18n("Updating file"), done: i18n("Updated file") },
			get: { active: i18n("Reading file"), done: i18n("Read file") },
			delete: { active: i18n("Deleting file"), done: i18n("Deleted file") },
			list: { active: i18n("Listing project files"), done: i18n("Listed project files") },
		};
		const label =
			state === "inprogress"
				? labels[command]?.active || i18n("Processing file")
				: labels[command]?.done || i18n("Processed file");
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

class ProjectTaskRenderer implements ToolRenderer<ProjectTaskParams, ProjectTaskDetails> {
	render(
		params: ProjectTaskParams | undefined,
		result: ToolResultMessage<ProjectTaskDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result
			? result.isError || result.details?.status === "failed"
				? "error"
				: "complete"
			: isStreaming
				? "inprogress"
				: "complete";
		const details = result?.details;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const header = details?.previewUrl
			? html`<span>${i18n("Preview ready")} <a class="underline" href=${details.previewUrl} target="_blank" rel="noreferrer">${details.previewUrl}</a></span>`
			: details?.status === "failed"
				? "Project task failed"
				: state === "inprogress"
					? `Running project task ${params?.task || ""}`
					: `Completed project task ${details?.task || params?.task || ""}`;
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(state, Rocket, header, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${details ? html`<code-block .code=${formatProjectTaskResult(details)} language="text"></code-block>` : ""}
					</div>
				</div>
			`,
		};
	}
}
