import type {
	AnthropicMessagesCompat,
	Api,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
} from "@mariozechner/pi-ai";
import type { CustomProvider } from "../storage/stores/custom-providers-store.js";

export type CompatibleThinkingFormat = NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
export type CompatibleMaxTokensField = NonNullable<OpenAICompletionsCompat["maxTokensField"]>;
export type AnthropicReasoningReplayFormat = NonNullable<AnthropicMessagesCompat["reasoningReplayFormat"]>;

export type OpenAICompletionsProfile =
	| "standard"
	| "local-basic"
	| "deepseek-mimo"
	| "openrouter"
	| "qwen"
	| "qwen-chat-template"
	| "zai"
	| "custom";
export type OpenAIResponsesProfile = "standard" | "generic-gateway" | "custom";
export type AnthropicMessagesProfile = "standard" | "mimo-deepseek" | "legacy-compatible" | "custom";

export interface ManualModelConfig {
	id: string;
	vision: boolean;
	reasoning: boolean;
	openAICompletionsProfile: OpenAICompletionsProfile;
	openAIResponsesProfile: OpenAIResponsesProfile;
	anthropicMessagesProfile: AnthropicMessagesProfile;
	thinkingFormat: CompatibleThinkingFormat;
	requiresReasoningContentOnAssistantMessages: boolean;
	supportsReasoningEffort: boolean;
	maxTokensField: CompatibleMaxTokensField;
	sendSessionIdHeader: boolean;
	openAIResponsesSupportsLongCacheRetention: boolean;
	anthropicReasoningReplayFormat: AnthropicReasoningReplayFormat;
	supportsEagerToolInputStreaming: boolean;
	anthropicSupportsLongCacheRetention: boolean;
	contextWindow: string;
	maxTokens: string;
}

const defaultCost = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

export function defaultManualModelConfig(id = ""): ManualModelConfig {
	return {
		id,
		vision: false,
		reasoning: false,
		openAICompletionsProfile: "standard",
		openAIResponsesProfile: "standard",
		anthropicMessagesProfile: "standard",
		thinkingFormat: "openai",
		requiresReasoningContentOnAssistantMessages: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_completion_tokens",
		sendSessionIdHeader: true,
		openAIResponsesSupportsLongCacheRetention: true,
		anthropicReasoningReplayFormat: "anthropic-signature",
		supportsEagerToolInputStreaming: true,
		anthropicSupportsLongCacheRetention: true,
		contextWindow: "128000",
		maxTokens: "8192",
	};
}

export function manualModelConfigFromModel(model: Model<Api>): ManualModelConfig {
	const openAICompletionsCompat =
		model.api === "openai-completions" ? (model.compat as OpenAICompletionsCompat | undefined) : undefined;
	const openAIResponsesCompat =
		model.api === "openai-responses" ? (model.compat as OpenAIResponsesCompat | undefined) : undefined;
	const anthropicCompat =
		model.api === "anthropic-messages" ? (model.compat as AnthropicMessagesCompat | undefined) : undefined;
	const thinkingFormat = openAICompletionsCompat?.thinkingFormat ?? "openai";

	return {
		id: model.id,
		vision: model.input.includes("image"),
		reasoning: model.reasoning,
		openAICompletionsProfile: inferOpenAICompletionsProfile(openAICompletionsCompat),
		openAIResponsesProfile: inferOpenAIResponsesProfile(openAIResponsesCompat),
		anthropicMessagesProfile: inferAnthropicMessagesProfile(anthropicCompat),
		thinkingFormat,
		requiresReasoningContentOnAssistantMessages:
			openAICompletionsCompat?.requiresReasoningContentOnAssistantMessages ?? false,
		supportsReasoningEffort:
			openAICompletionsCompat?.supportsReasoningEffort ?? defaultSupportsReasoningEffort(thinkingFormat),
		maxTokensField: openAICompletionsCompat?.maxTokensField ?? "max_completion_tokens",
		sendSessionIdHeader: openAIResponsesCompat?.sendSessionIdHeader ?? true,
		openAIResponsesSupportsLongCacheRetention: openAIResponsesCompat?.supportsLongCacheRetention ?? true,
		anthropicReasoningReplayFormat: anthropicCompat?.reasoningReplayFormat ?? "anthropic-signature",
		supportsEagerToolInputStreaming: anthropicCompat?.supportsEagerToolInputStreaming ?? true,
		anthropicSupportsLongCacheRetention: anthropicCompat?.supportsLongCacheRetention ?? true,
		contextWindow: String(model.contextWindow || 128000),
		maxTokens: String(model.maxTokens || 8192),
	};
}

export function createManualModelsFromConfigs(
	provider: Omit<CustomProvider, "models">,
	configs: ManualModelConfig[],
): Model<Api>[] {
	const api = getApi(provider.type);
	return configs
		.filter((config) => config.id.trim())
		.map((config) => {
			const model: Model<Api> = {
				id: config.id.trim(),
				name: config.id.trim(),
				api,
				provider: provider.name,
				baseUrl: provider.baseUrl,
				reasoning: config.reasoning,
				input: config.vision ? ["text", "image"] : ["text"],
				cost: defaultCost,
				contextWindow: parsePositiveInt(config.contextWindow, 128000),
				maxTokens: parsePositiveInt(config.maxTokens, 8192),
			};
			const compat = createCompat(provider.type, config);
			if (compat) model.compat = compat as Model<Api>["compat"];
			return model;
		});
}

function getApi(providerType: CustomProvider["type"]): Api {
	if (providerType === "anthropic-messages") return "anthropic-messages";
	if (providerType === "openai-responses") return "openai-responses";
	return "openai-completions";
}

function createCompat(
	providerType: CustomProvider["type"],
	config: ManualModelConfig,
): OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined {
	if (providerType === "openai-completions") return createOpenAICompletionsCompat(config);
	if (providerType === "openai-responses") return createOpenAIResponsesCompat(config);
	if (providerType === "anthropic-messages") return createAnthropicMessagesCompat(config);
	return undefined;
}

function createOpenAICompletionsCompat(config: ManualModelConfig): OpenAICompletionsCompat {
	const compat: OpenAICompletionsCompat = standardOpenAICompletionsCompat();

	switch (config.openAICompletionsProfile) {
		case "local-basic":
			compat.supportsStore = false;
			compat.supportsDeveloperRole = false;
			compat.supportsReasoningEffort = false;
			compat.maxTokensField = "max_tokens";
			break;
		case "deepseek-mimo":
			compat.thinkingFormat = "deepseek";
			compat.requiresReasoningContentOnAssistantMessages = true;
			compat.maxTokensField = "max_tokens";
			break;
		case "openrouter":
			compat.thinkingFormat = "openrouter";
			break;
		case "qwen":
			compat.thinkingFormat = "qwen";
			compat.supportsReasoningEffort = false;
			compat.supportsDeveloperRole = false;
			compat.maxTokensField = "max_tokens";
			break;
		case "qwen-chat-template":
			compat.thinkingFormat = "qwen-chat-template";
			compat.supportsReasoningEffort = false;
			compat.supportsDeveloperRole = false;
			compat.maxTokensField = "max_tokens";
			break;
		case "zai":
			compat.thinkingFormat = "zai";
			compat.supportsReasoningEffort = false;
			compat.supportsDeveloperRole = false;
			compat.maxTokensField = "max_tokens";
			break;
		case "custom":
			compat.thinkingFormat = config.thinkingFormat;
			compat.requiresReasoningContentOnAssistantMessages = config.requiresReasoningContentOnAssistantMessages;
			compat.supportsReasoningEffort = config.supportsReasoningEffort;
			compat.maxTokensField = config.maxTokensField;
			if (
				config.thinkingFormat === "zai" ||
				config.thinkingFormat === "qwen" ||
				config.thinkingFormat === "qwen-chat-template"
			) {
				compat.supportsReasoningEffort = false;
				compat.supportsDeveloperRole = false;
			}
			break;
	}

	return compat;
}

function standardOpenAICompletionsCompat(): OpenAICompletionsCompat {
	return {
		supportsStore: true,
		supportsDeveloperRole: true,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		maxTokensField: "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: false,
		thinkingFormat: "openai",
		zaiToolStream: false,
		supportsStrictMode: true,
		sendSessionAffinityHeaders: false,
		supportsLongCacheRetention: true,
	};
}

function createOpenAIResponsesCompat(config: ManualModelConfig): OpenAIResponsesCompat | undefined {
	if (config.openAIResponsesProfile === "standard") return undefined;

	return {
		sendSessionIdHeader: config.openAIResponsesProfile === "generic-gateway" ? false : config.sendSessionIdHeader,
		supportsLongCacheRetention:
			config.openAIResponsesProfile === "generic-gateway" ? false : config.openAIResponsesSupportsLongCacheRetention,
	};
}

function createAnthropicMessagesCompat(config: ManualModelConfig): AnthropicMessagesCompat | undefined {
	if (config.anthropicMessagesProfile === "standard") return undefined;

	if (config.anthropicMessagesProfile === "mimo-deepseek") {
		return {
			reasoningReplayFormat: "deepseek-reasoning-content",
		};
	}

	if (config.anthropicMessagesProfile === "legacy-compatible") {
		return {
			supportsEagerToolInputStreaming: false,
		};
	}

	return {
		reasoningReplayFormat: config.anthropicReasoningReplayFormat,
		supportsEagerToolInputStreaming: config.supportsEagerToolInputStreaming,
		supportsLongCacheRetention: config.anthropicSupportsLongCacheRetention,
	};
}

function inferOpenAICompletionsProfile(compat: OpenAICompletionsCompat | undefined): OpenAICompletionsProfile {
	if (!compat) return "standard";
	if (compat.thinkingFormat === "deepseek" || compat.requiresReasoningContentOnAssistantMessages) {
		return "deepseek-mimo";
	}
	if (compat.thinkingFormat === "openrouter") return "openrouter";
	if (compat.thinkingFormat === "qwen") return "qwen";
	if (compat.thinkingFormat === "qwen-chat-template") return "qwen-chat-template";
	if (compat.thinkingFormat === "zai") return "zai";
	if (
		compat.supportsStore === false ||
		compat.supportsDeveloperRole === false ||
		compat.supportsReasoningEffort === false ||
		compat.maxTokensField === "max_tokens"
	) {
		return "local-basic";
	}
	return "standard";
}

function inferOpenAIResponsesProfile(compat: OpenAIResponsesCompat | undefined): OpenAIResponsesProfile {
	if (!compat) return "standard";
	if (compat.sendSessionIdHeader === false || compat.supportsLongCacheRetention === false) {
		return "generic-gateway";
	}
	return "custom";
}

function inferAnthropicMessagesProfile(compat: AnthropicMessagesCompat | undefined): AnthropicMessagesProfile {
	if (!compat) return "standard";
	if (compat.reasoningReplayFormat === "deepseek-reasoning-content") return "mimo-deepseek";
	if (compat.supportsEagerToolInputStreaming === false) return "legacy-compatible";
	return "custom";
}

function defaultSupportsReasoningEffort(thinkingFormat: CompatibleThinkingFormat): boolean {
	return thinkingFormat === "openai" || thinkingFormat === "openrouter" || thinkingFormat === "deepseek";
}

function parsePositiveInt(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
