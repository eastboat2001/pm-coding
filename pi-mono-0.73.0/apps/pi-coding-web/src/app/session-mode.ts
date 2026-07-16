import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";

export const SESSION_MODES = ["chat", "app_generation"] as const;

export type SessionMode = (typeof SESSION_MODES)[number];
export type SessionEntry = "standalone" | "pm_handoff";
export type SessionPromptInput = string | AgentMessage | AgentMessage[];

export interface SessionPromptHandlers {
	chat(input: SessionPromptInput, images?: ImageContent[]): Promise<void>;
	appGeneration(input: SessionPromptInput, images?: ImageContent[]): Promise<void>;
}

export function normalizeSessionMode(value: unknown): SessionMode {
	return value === "app_generation" ? "app_generation" : "chat";
}

export function defaultSessionModeForEntry(entry: SessionEntry): SessionMode {
	return entry === "pm_handoff" ? "app_generation" : "chat";
}

export function canSwitchSessionMode(input: { isStreaming: boolean; hasActiveRun: boolean }): boolean {
	return !input.isStreaming && !input.hasActiveRun;
}

export async function dispatchSessionPrompt(
	mode: SessionMode,
	handlers: SessionPromptHandlers,
	input: SessionPromptInput,
	images?: ImageContent[],
): Promise<void> {
	if (mode === "app_generation") {
		await handlers.appGeneration(input, images);
		return;
	}
	await handlers.chat(input, images);
}

export function sessionModeTools<T>(mode: SessionMode, readOnlySkillTools: readonly T[]): T[] {
	return mode === "chat" ? [...readOnlySkillTools] : [];
}

export function sessionModeLabel(mode: SessionMode, language: string): string {
	const normalizedLanguage = language.trim().toLowerCase();
	if (normalizedLanguage.startsWith("zh")) return mode === "chat" ? "对话" : "应用生成";
	if (normalizedLanguage.startsWith("de")) return mode === "chat" ? "Chat" : "App-Erstellung";
	if (normalizedLanguage.startsWith("ms")) return mode === "chat" ? "Sembang" : "Penjanaan aplikasi";
	return mode === "chat" ? "Chat" : "App generation";
}
