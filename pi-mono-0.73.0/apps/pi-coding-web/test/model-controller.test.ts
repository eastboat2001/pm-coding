import { ModelController, supportsApplicationGeneration } from "../src/app/model-controller.js";
import { describe, expect, it } from "vitest";

describe("ModelController", () => {
	it("does not force non-streaming tool calls for auto-created vLLM models", async () => {
		const controller = createController();

		const model = await controller.resolveCustomModel({ provider: "Local vLLM", id: "qwen3" });

		expect(model?.api).toBe("openai-completions");
		expect(model?.baseUrl).toBe("http://localhost:8000/v1");
		expect((model?.compat as { useNonStreamingToolCalls?: boolean } | undefined)?.useNonStreamingToolCalls).toBeUndefined();
	});

	it("enables non-streaming tool calls for auto-created vLLM models only when configured", async () => {
		const controller = createController({ useNonStreamingToolCalls: true });

		const model = await controller.resolveCustomModel({ provider: "Local vLLM", id: "qwen3" });

		expect((model?.compat as { useNonStreamingToolCalls?: boolean } | undefined)?.useNonStreamingToolCalls).toBe(true);
	});

	it("removes stale non-streaming tool calls from saved auto-discovery models unless configured", async () => {
		const controller = createController();

		const model = await controller.resolveCustomModel({
			id: "qwen3",
			name: "qwen3",
			api: "openai-completions",
			provider: "Local vLLM",
			baseUrl: "http://localhost:8000/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32768,
			maxTokens: 4096,
			compat: {
				supportsStore: false,
				supportsDeveloperRole: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
				useNonStreamingToolCalls: true,
			},
		});

		expect((model?.compat as { useNonStreamingToolCalls?: boolean } | undefined)?.useNonStreamingToolCalls).toBeUndefined();
	});

	it("resolves duplicate custom provider names by stable provider identity", async () => {
		const firstProvider = {
			id: "provider-a",
			name: "Local",
			type: "vllm",
			baseUrl: "http://localhost:8000",
			apiKey: "first-key",
		};
		const secondProvider = {
			id: "provider-b",
			name: "Local",
			type: "vllm",
			baseUrl: "http://localhost:9000",
			apiKey: "second-key",
		};
		const controller = createController(undefined, [firstProvider, secondProvider]);

		const model = await controller.resolveCustomModel({
			provider: "custom-provider:provider-b",
			id: "qwen3",
		});

		expect(model?.provider).toBe("custom-provider:provider-b");
		expect(model?.baseUrl).toBe("http://localhost:9000/v1");
	});

	it("refreshes the active custom model from a saved provider update", async () => {
		let providers: Array<Record<string, unknown>> = [
			{
				id: "provider-a",
				name: "Local",
				type: "openai-completions",
				baseUrl: "https://old.example/v1",
				apiKey: "old-key",
				models: [manualModel("custom-provider:provider-a", "mimo", "https://old.example/v1")],
			},
		];
		const controller = createController(undefined, () => providers);
		const activeModel = await controller.resolveCustomModel({
			provider: "custom-provider:provider-a",
			id: "mimo",
		});

		providers = [
			{
				id: "provider-a",
				name: "Local",
				type: "openai-completions",
				baseUrl: "https://new.example/v1",
				apiKey: "new-key",
				models: [manualModel("custom-provider:provider-a", "mimo", "https://new.example/v1")],
			},
		];

		const refreshed = await controller.resolveSavedCustomProviderModel(activeModel, providers[0]);

		expect(refreshed?.provider).toBe("custom-provider:provider-a");
		expect(refreshed?.baseUrl).toBe("https://new.example/v1");
	});

	it("requires sufficient output capacity without selecting another model", () => {
		expect(
			supportsApplicationGeneration({
				...manualModel("custom-provider:mimo-small", "mimo-v2.5", "https://small.example/v1"),
				maxTokens: 200,
			}),
		).toBe(false);
		expect(
			supportsApplicationGeneration({
				...manualModel("custom-provider:mimo-app", "mimo-v2.5", "https://app.example/v1"),
				maxTokens: 8_192,
			}),
		).toBe(true);
	});
});

function manualModel(provider: string, id: string, baseUrl: string) {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
}

function createController(
	providerPatch: Record<string, unknown> | undefined = {},
	providers?: Array<Record<string, unknown>> | (() => Array<Record<string, unknown>>),
) {
	return new ModelController(
		{
			customProviders: {
				getAll: async () =>
					(typeof providers === "function" ? providers() : providers) ?? [
					{
						id: "local-vllm",
						name: "Local vLLM",
						type: "vllm",
						baseUrl: "http://localhost:8000",
						apiKey: "test-key",
						...providerPatch,
					},
				],
			},
			settings: {
				get: async () => undefined,
				set: async () => undefined,
			},
		} as any,
		{
			readSettings: async () => undefined,
			getStatus: async () => undefined,
			writeSettings: async () => undefined,
		} as any,
	);
}
