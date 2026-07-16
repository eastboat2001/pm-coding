import type { AgentV2RunPresentation } from "./agent-v2-run-presentation.js";

export type AgentV2PresentationSessionMode = "chat" | "app_generation";

export function selectAgentV2ActiveRunPresentation(
	mode: AgentV2PresentationSessionMode,
	presentation: AgentV2RunPresentation | undefined,
): AgentV2RunPresentation | undefined {
	return mode === "app_generation" ? presentation : undefined;
}
