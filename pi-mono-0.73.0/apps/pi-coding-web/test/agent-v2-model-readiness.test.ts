import { describe, expect, it } from "vitest";
import { validateAgentV2ModelReadiness } from "../src/server/agent-v2-model-readiness.js";

describe("Agent v2 model readiness", () => {
	it("accepts a custom model only when the server has its model and credential", () => {
		expect(
			validateAgentV2ModelReadiness({
				model: { provider: "custom-provider:manual", id: "mimo-v2.5" },
				settings: manualSettings("server-key"),
			}),
		).toBeUndefined();
	});

	it("rejects a model reference that exists only in browser state", () => {
		expect(
			validateAgentV2ModelReadiness({
				model: { provider: "custom-provider:legacy-browser", id: "old-model" },
				settings: manualSettings("server-key"),
			}),
		).toMatchObject({ code: "agent_v2.model.not_synchronized", statusCode: 409 });
	});

	it("rejects a provider without a server-side credential", () => {
		expect(
			validateAgentV2ModelReadiness({
				model: { provider: "custom-provider:manual", id: "mimo-v2.5" },
				settings: manualSettings(""),
			}),
		).toMatchObject({ code: "agent_v2.model.missing_api_key", statusCode: 422 });
	});

	it("rejects an auto-discovered model selected against an older provider revision", () => {
		expect(
			validateAgentV2ModelReadiness({
				model: { provider: "custom-provider:local", id: "qwen" },
				settings: {
					modelConfigRevision: 2,
					selectedModelConfigRevision: 1,
					customProviders: [
						{ id: "local", name: "Local", type: "vllm", baseUrl: "http://127.0.0.1:8000" },
					],
					selectedModel: model("custom-provider:local", "qwen", "http://127.0.0.1:8000/v1"),
				},
			}),
		).toMatchObject({ code: "agent_v2.model.stale_configuration", statusCode: 409 });
	});
});

function manualSettings(apiKey: string) {
	return {
		modelConfigRevision: 3,
		selectedModelConfigRevision: 3,
		customProviders: [
			{
				id: "manual",
				name: "Manual",
				type: "openai-completions",
				baseUrl: "https://model.example/v1",
				apiKey,
				models: [model("custom-provider:manual", "mimo-v2.5", "https://model.example/v1")],
			},
		],
		selectedModel: model("custom-provider:manual", "mimo-v2.5", "https://model.example/v1"),
	};
}

function model(provider: string, id: string, baseUrl: string) {
	return {
		id,
		name: id,
		provider,
		api: "openai-completions",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}
