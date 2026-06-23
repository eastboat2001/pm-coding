import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createManualModelsFromConfigs,
	defaultManualModelConfig,
	type ManualModelConfig,
	manualModelConfigFromModel,
} from "../src/dialogs/custom-provider-model-config.js";
import { type CustomProvider, customProviderIdentity } from "../src/storage/stores/custom-providers-store.js";

const provider: Omit<CustomProvider, "models"> = {
	id: "local",
	name: "Local Provider",
	type: "openai-completions",
	baseUrl: "http://localhost:8000/v1",
	apiKey: "test-key",
};

describe("custom provider manual model config", () => {
	it("keeps non-streaming tool calls off by default", () => {
		expect(defaultManualModelConfig().useNonStreamingToolCalls).toBe(false);
	});

	it("creates per-model OpenAI-compatible reasoning and vision settings", () => {
		const configs: ManualModelConfig[] = [
			{
				id: "mimo-v2.5",
				vision: true,
				reasoning: true,
				openAICompletionsProfile: "deepseek-mimo",
				openAIResponsesProfile: "standard",
				anthropicMessagesProfile: "standard",
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				sendSessionIdHeader: true,
				openAIResponsesSupportsLongCacheRetention: true,
				anthropicReasoningReplayFormat: "anthropic-signature",
				supportsEagerToolInputStreaming: true,
				anthropicSupportsLongCacheRetention: true,
				useNonStreamingToolCalls: false,
				contextWindow: "64000",
				maxTokens: "4096",
			},
		];

		const [model] = createManualModelsFromConfigs(provider, configs);

		expect(model).toMatchObject({
			id: "mimo-v2.5",
			name: "mimo-v2.5",
			api: "openai-completions",
			provider: customProviderIdentity(provider),
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 64000,
			maxTokens: 4096,
			compat: {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			},
		});
	});

	it("restores model capability fields into editable config", () => {
		const model: Model<"openai-completions"> = {
			id: "qwen3",
			name: "qwen3",
			api: "openai-completions",
			provider: "Local Provider",
			baseUrl: "http://localhost:8000/v1",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 32768,
			maxTokens: 2048,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compat: {
				thinkingFormat: "qwen",
			},
		};

		expect(manualModelConfigFromModel(model)).toEqual({
			id: "qwen3",
			vision: true,
			reasoning: true,
			openAICompletionsProfile: "qwen",
			openAIResponsesProfile: "standard",
			anthropicMessagesProfile: "standard",
			thinkingFormat: "qwen",
			requiresReasoningContentOnAssistantMessages: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_completion_tokens",
			sendSessionIdHeader: true,
			openAIResponsesSupportsLongCacheRetention: true,
			anthropicReasoningReplayFormat: "anthropic-signature",
			supportsEagerToolInputStreaming: true,
			anthropicSupportsLongCacheRetention: true,
			useNonStreamingToolCalls: false,
			contextWindow: "32768",
			maxTokens: "2048",
		});
	});

	it("only enables non-streaming tool calls when manually requested", () => {
		const qwenConfig = {
			...defaultConfig("qwen3"),
			reasoning: true,
			openAICompletionsProfile: "qwen",
			thinkingFormat: "qwen",
			supportsReasoningEffort: false,
			maxTokensField: "max_tokens",
		} satisfies ManualModelConfig;

		const [streamingModel] = createManualModelsFromConfigs(provider, [qwenConfig]);
		expect((streamingModel.compat as { useNonStreamingToolCalls?: boolean }).useNonStreamingToolCalls).toBe(false);

		const [nonStreamingModel] = createManualModelsFromConfigs(provider, [
			{ ...qwenConfig, useNonStreamingToolCalls: true },
		]);
		expect((nonStreamingModel.compat as { useNonStreamingToolCalls?: boolean }).useNonStreamingToolCalls).toBe(true);
	});

	it("creates per-model Anthropic-compatible MiMo/DeepSeek reasoning replay settings", () => {
		const anthropicProvider: Omit<CustomProvider, "models"> = {
			...provider,
			type: "anthropic-messages",
			baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
		};
		const config = {
			...defaultConfig("mimo-v2.5"),
			vision: true,
			reasoning: true,
			anthropicMessagesProfile: "mimo-deepseek",
			anthropicReasoningReplayFormat: "deepseek-reasoning-content",
		} satisfies ManualModelConfig;

		const [model] = createManualModelsFromConfigs(anthropicProvider, [config]);

		expect(model).toMatchObject({
			api: "anthropic-messages",
			input: ["text", "image"],
			reasoning: true,
			compat: {
				reasoningReplayFormat: "deepseek-reasoning-content",
			},
		});
	});

	it("creates per-model OpenAI Responses-compatible advanced settings", () => {
		const responsesProvider: Omit<CustomProvider, "models"> = {
			...provider,
			type: "openai-responses",
			baseUrl: "http://localhost:8000/v1",
		};
		const config = {
			...defaultConfig("gpt-5-local"),
			openAIResponsesProfile: "generic-gateway",
			sendSessionIdHeader: false,
			openAIResponsesSupportsLongCacheRetention: false,
		} satisfies ManualModelConfig;

		const [model] = createManualModelsFromConfigs(responsesProvider, [config]);

		expect(model).toMatchObject({
			api: "openai-responses",
			compat: {
				sendSessionIdHeader: false,
				supportsLongCacheRetention: false,
			},
		});
	});

	it("preserves manually selected compatibility profiles after save and reload", () => {
		const completionsProfiles: ManualModelConfig["openAICompletionsProfile"][] = [
			"standard",
			"local-basic",
			"deepseek-mimo",
			"openrouter",
			"qwen",
			"qwen-chat-template",
			"zai",
			"custom",
		];
		for (const profile of completionsProfiles) {
			const config = {
				...defaultConfig(`chat-${profile}`),
				reasoning: true,
				openAICompletionsProfile: profile,
				thinkingFormat: profile === "custom" ? "openai" : profile === "deepseek-mimo" ? "deepseek" : "openai",
				supportsReasoningEffort: profile !== "custom",
				maxTokensField: profile === "custom" ? "max_tokens" : "max_completion_tokens",
			} satisfies ManualModelConfig;
			const [model] = createManualModelsFromConfigs(provider, [config]);

			expect(manualModelConfigFromModel(model).openAICompletionsProfile).toBe(profile);
		}

		const responsesProvider: Omit<CustomProvider, "models"> = {
			...provider,
			type: "openai-responses",
		};
		for (const profile of [
			"standard",
			"generic-gateway",
			"custom",
		] satisfies ManualModelConfig["openAIResponsesProfile"][]) {
			const config = {
				...defaultConfig(`responses-${profile}`),
				openAIResponsesProfile: profile,
				sendSessionIdHeader: profile !== "custom",
				openAIResponsesSupportsLongCacheRetention: profile !== "custom",
			} satisfies ManualModelConfig;
			const [model] = createManualModelsFromConfigs(responsesProvider, [config]);

			expect(manualModelConfigFromModel(model).openAIResponsesProfile).toBe(profile);
		}

		const anthropicProvider: Omit<CustomProvider, "models"> = {
			...provider,
			type: "anthropic-messages",
		};
		for (const profile of [
			"standard",
			"mimo-deepseek",
			"legacy-compatible",
			"custom",
		] satisfies ManualModelConfig["anthropicMessagesProfile"][]) {
			const config = {
				...defaultConfig(`anthropic-${profile}`),
				reasoning: true,
				anthropicMessagesProfile: profile,
				anthropicReasoningReplayFormat: profile === "custom" ? "deepseek-reasoning-content" : "anthropic-signature",
				supportsEagerToolInputStreaming: profile !== "custom",
			} satisfies ManualModelConfig;
			const [model] = createManualModelsFromConfigs(anthropicProvider, [config]);

			expect(manualModelConfigFromModel(model).anthropicMessagesProfile).toBe(profile);
		}
	});
});

function defaultConfig(id: string): ManualModelConfig {
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
		useNonStreamingToolCalls: false,
		contextWindow: "128000",
		maxTokens: "8192",
	};
}
