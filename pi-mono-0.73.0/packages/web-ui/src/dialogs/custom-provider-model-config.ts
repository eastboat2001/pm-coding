import type { Api, Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { CustomProvider } from "../storage/stores/custom-providers-store.js";

export type CompatibleThinkingFormat = NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
export type CompatibleMaxTokensField = NonNullable<OpenAICompletionsCompat["maxTokensField"]>;

export interface ManualModelConfig {
	id: string;
	vision: boolean;
	reasoning: boolean;
	thinkingFormat: CompatibleThinkingFormat;
	requiresReasoningContentOnAssistantMessages: boolean;
	supportsReasoningEffort: boolean;
	maxTokensField: CompatibleMaxTokensField;
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
		thinkingFormat: "openai",
		requiresReasoningContentOnAssistantMessages: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_completion_tokens",
		contextWindow: "128000",
		maxTokens: "8192",
	};
}

export function manualModelConfigFromModel(model: Model<Api>): ManualModelConfig {
	const compat = model.compat as OpenAICompletionsCompat | undefined;
	const thinkingFormat = compat?.thinkingFormat ?? "openai";

	return {
		id: model.id,
		vision: model.input.includes("image"),
		reasoning: model.reasoning,
		thinkingFormat,
		requiresReasoningContentOnAssistantMessages: compat?.requiresReasoningContentOnAssistantMessages ?? false,
		supportsReasoningEffort: compat?.supportsReasoningEffort ?? defaultSupportsReasoningEffort(thinkingFormat),
		maxTokensField: compat?.maxTokensField ?? "max_completion_tokens",
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
): OpenAICompletionsCompat | undefined {
	if (providerType !== "openai-completions") return undefined;

	const compat: OpenAICompletionsCompat = {
		maxTokensField: config.maxTokensField,
	};

	if (!config.reasoning) return compat;

	compat.thinkingFormat = config.thinkingFormat;
	compat.supportsReasoningEffort = config.supportsReasoningEffort;
	if (config.requiresReasoningContentOnAssistantMessages || config.thinkingFormat === "deepseek") {
		compat.requiresReasoningContentOnAssistantMessages = true;
	}
	if (
		config.thinkingFormat === "zai" ||
		config.thinkingFormat === "qwen" ||
		config.thinkingFormat === "qwen-chat-template"
	) {
		compat.supportsReasoningEffort = false;
		compat.supportsDeveloperRole = false;
	}

	return compat;
}

function defaultSupportsReasoningEffort(thinkingFormat: CompatibleThinkingFormat): boolean {
	return thinkingFormat === "openai" || thinkingFormat === "openrouter" || thinkingFormat === "deepseek";
}

function parsePositiveInt(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
