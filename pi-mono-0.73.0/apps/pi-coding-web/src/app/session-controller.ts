import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { i18n } from "@mariozechner/pi-web-ui";

export const CURRENT_SESSION_ID_KEY = "example.currentSessionId";
export const DEFAULT_NEW_SESSION_TITLES = new Set(["New Session", "新建会话", "Neue Sitzung", "Sesi baharu"]);

export function generateTitle(messages: AgentMessage[]): string {
	const firstUserMsg = messages.find((m) => m.role === "user" || m.role === "user-with-attachments");
	if (!firstUserMsg || (firstUserMsg.role !== "user" && firstUserMsg.role !== "user-with-attachments")) return "";

	let text = "";
	const content = firstUserMsg.content;
	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = (content as unknown[]).filter((c: unknown): c is { type: "text"; text?: string } => {
			return typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text";
		});
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";
	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) return text.substring(0, sentenceEnd + 1);
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
}

export function isDefaultNewSessionTitle(title?: string): boolean {
	return !title || DEFAULT_NEW_SESSION_TITLES.has(title.trim());
}

export function sessionTitle(currentTitle: string, messages: AgentMessage[]): string {
	return (
		(!isDefaultNewSessionTitle(currentTitle) ? currentTitle : "") || generateTitle(messages) || i18n("New Session")
	);
}
