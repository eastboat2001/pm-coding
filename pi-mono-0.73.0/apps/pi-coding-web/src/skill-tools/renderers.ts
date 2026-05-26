import "@mariozechner/mini-lit/dist/CodeBlock.js";
import type { ToolResultMessage } from "@mariozechner/pi-ai";
import {
	registerToolRenderer,
	renderCollapsibleHeader,
	type ToolRenderer,
	type ToolRenderResult,
} from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { BookOpen, FileText } from "lucide";
import type { SkillLoadDetails, SkillLoadParams, SkillResourceDetails, SkillResourceParams } from "./schemas.js";

let registered = false;

export function registerSkillToolRenderers(): void {
	if (registered) return;
	registered = true;
	registerToolRenderer("skill_load", new SkillLoadRenderer());
	registerToolRenderer("skill_resource", new SkillResourceRenderer());
}

function getTextOutput(result: ToolResultMessage<unknown> | undefined): string {
	return (
		result?.content
			?.filter((content) => content.type === "text")
			.map((content) => String((content as { text?: unknown }).text || ""))
			.join("\n") || ""
	);
}

class SkillLoadRenderer implements ToolRenderer<SkillLoadParams, SkillLoadDetails> {
	render(
		params: SkillLoadParams | undefined,
		result: ToolResultMessage<SkillLoadDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const details = result?.details;
		const name = details?.name || params?.name || "";
		const label =
			state === "error" ? "Skill load failed" : state === "inprogress" ? "Loading skill" : `Loaded skill ${name}`;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const code = result?.isError ? getTextOutput(result) : details?.content || getTextOutput(result);
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(state, BookOpen, label, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${code ? html`<code-block .code=${code} language="markdown"></code-block>` : ""}
					</div>
				</div>
			`,
		};
	}
}

class SkillResourceRenderer implements ToolRenderer<SkillResourceParams, SkillResourceDetails> {
	render(
		params: SkillResourceParams | undefined,
		result: ToolResultMessage<SkillResourceDetails> | undefined,
		isStreaming?: boolean,
	): ToolRenderResult {
		const state = result ? (result.isError ? "error" : "complete") : isStreaming ? "inprogress" : "complete";
		const details = result?.details;
		const path = details?.path || params?.path || "";
		const label =
			state === "error"
				? "Skill resource failed"
				: state === "inprogress"
					? "Reading skill resource"
					: `Read skill resource ${path}`;
		const contentRef = createRef<HTMLDivElement>();
		const chevronRef = createRef<HTMLSpanElement>();
		const code = result?.isError ? getTextOutput(result) : details?.content || getTextOutput(result);
		return {
			isCustom: false,
			content: html`
				<div>
					${renderCollapsibleHeader(state, FileText, label, contentRef, chevronRef)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						${code ? html`<code-block .code=${code} language="markdown"></code-block>` : ""}
					</div>
				</div>
			`,
		};
	}
}
