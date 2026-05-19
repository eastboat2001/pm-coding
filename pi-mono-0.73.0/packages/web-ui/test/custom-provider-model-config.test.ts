import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
	createManualModelsFromConfigs,
	type ManualModelConfig,
	manualModelConfigFromModel,
} from "../src/dialogs/custom-provider-model-config.js";
import type { CustomProvider } from "../src/storage/stores/custom-providers-store.js";

const provider: Omit<CustomProvider, "models"> = {
	id: "local",
	name: "Local Provider",
	type: "openai-completions",
	baseUrl: "http://localhost:8000/v1",
	apiKey: "test-key",
};

describe("custom provider manual model config", () => {
	it("creates per-model OpenAI-compatible reasoning and vision settings", () => {
		const configs: ManualModelConfig[] = [
			{
				id: "mimo-v2.5",
				vision: true,
				reasoning: true,
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
				contextWindow: "64000",
				maxTokens: "4096",
			},
		];

		const [model] = createManualModelsFromConfigs(provider, configs);

		expect(model).toMatchObject({
			id: "mimo-v2.5",
			name: "mimo-v2.5",
			api: "openai-completions",
			provider: "Local Provider",
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
			thinkingFormat: "qwen",
			requiresReasoningContentOnAssistantMessages: false,
			supportsReasoningEffort: false,
			maxTokensField: "max_completion_tokens",
			contextWindow: "32768",
			maxTokens: "2048",
		});
	});
});
