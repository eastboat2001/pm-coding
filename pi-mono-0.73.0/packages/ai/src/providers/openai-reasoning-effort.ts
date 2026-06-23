import type { ThinkingLevel, ThinkingLevelMap } from "../types.js";

interface ReasoningEffortModel {
	provider: string;
	baseUrl: string;
	thinkingLevelMap?: ThinkingLevelMap;
}

interface ReasoningEffortOptions {
	preserveNativeOpenAI?: boolean;
}

export function resolveOpenAICompatibleReasoningEffort(
	model: ReasoningEffortModel,
	level: ThinkingLevel,
	options: ReasoningEffortOptions = {},
): string | undefined {
	const mapped = model.thinkingLevelMap?.[level];
	if (mapped !== undefined) {
		return mapped ?? undefined;
	}
	if (options.preserveNativeOpenAI && isNativeOpenAIModel(model)) {
		return level;
	}
	return mapInternalReasoningEffort(level);
}

function isNativeOpenAIModel(model: ReasoningEffortModel): boolean {
	return model.provider === "openai" && model.baseUrl.includes("api.openai.com");
}

function mapInternalReasoningEffort(level: ThinkingLevel): string {
	switch (level) {
		case "minimal":
			return "low";
		case "xhigh":
			return "high";
		default:
			return level;
	}
}
