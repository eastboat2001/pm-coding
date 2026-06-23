import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamAzureOpenAIResponses } from "../src/providers/azure-openai-responses.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

interface CapturedChatPayload {
	reasoning_effort?: string;
	reasoning?: { effort?: string };
	thinking?: { type: string };
}

interface CapturedResponsesPayload {
	reasoning?: { effort?: string };
}

const mockState = vi.hoisted(() => ({
	lastChatParams: undefined as CapturedChatPayload | undefined,
	lastResponsesParams: undefined as CapturedResponsesPayload | undefined,
	lastAzureResponsesParams: undefined as CapturedResponsesPayload | undefined,
}));

vi.mock("openai", () => {
	function createEmptyResponsesStream() {
		return {
			async *[Symbol.asyncIterator]() {},
		};
	}

	function createChatStream() {
		return {
			async *[Symbol.asyncIterator]() {
				yield { id: "chatcmpl-test", choices: [{ index: 0, delta: { content: "ok" } }] };
				yield {
					id: "chatcmpl-test",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						prompt_tokens_details: { cached_tokens: 0 },
						completion_tokens_details: { reasoning_tokens: 0 },
					},
				};
			},
		};
	}

	function withResponse<T>(data: T) {
		const promise = Promise.resolve(data) as Promise<T> & {
			withResponse: () => Promise<{ data: T; response: { status: number; headers: Headers } }>;
		};
		promise.withResponse = async () => ({
			data,
			response: { status: 200, headers: new Headers() },
		});
		return promise;
	}

	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: CapturedChatPayload) => {
					mockState.lastChatParams = params;
					return withResponse(createChatStream());
				},
			},
		};

		responses = {
			create: (params: CapturedResponsesPayload) => {
				mockState.lastResponsesParams = params;
				return withResponse(createEmptyResponsesStream());
			},
		};
	}

	class FakeAzureOpenAI {
		responses = {
			create: (params: CapturedResponsesPayload) => {
				mockState.lastAzureResponsesParams = params;
				return withResponse(createEmptyResponsesStream());
			},
		};
	}

	return { default: FakeOpenAI, AzureOpenAI: FakeAzureOpenAI };
});

const context: Context = {
	systemPrompt: "sys",
	messages: [{ role: "user", content: "hi", timestamp: 123 }],
};

describe("OpenAI-compatible reasoning effort payloads", () => {
	beforeEach(() => {
		mockState.lastChatParams = undefined;
		mockState.lastResponsesParams = undefined;
		mockState.lastAzureResponsesParams = undefined;
	});

	it("maps internal minimal reasoning to low for DeepSeek-style chat completions", async () => {
		await streamOpenAICompletions(createCompletionsModel({ compat: { thinkingFormat: "deepseek" } }), context, {
			apiKey: "test-key",
			reasoningEffort: "minimal",
		}).result();

		expect(mockState.lastChatParams?.thinking).toEqual({ type: "enabled" });
		expect(mockState.lastChatParams?.reasoning_effort).toBe("low");
	});

	it("maps internal-only chat completion reasoning levels when the model has no explicit map", async () => {
		await streamOpenAICompletions(createCompletionsModel(), context, {
			apiKey: "test-key",
			reasoningEffort: "xhigh",
		}).result();

		expect(mockState.lastChatParams?.reasoning_effort).toBe("high");
	});

	it("maps OpenRouter nested reasoning effort through the same compatibility rules", async () => {
		await streamOpenAICompletions(createCompletionsModel({ compat: { thinkingFormat: "openrouter" } }), context, {
			apiKey: "test-key",
			reasoningEffort: "minimal",
		}).result();

		expect(mockState.lastChatParams?.reasoning?.effort).toBe("low");
	});

	it("maps internal minimal reasoning to low for OpenAI Responses-compatible providers", async () => {
		await streamOpenAIResponses(createResponsesModel(), context, {
			apiKey: "test-key",
			reasoningEffort: "minimal",
		}).result();

		expect(mockState.lastResponsesParams?.reasoning?.effort).toBe("low");
	});

	it("maps internal minimal reasoning to low for Azure OpenAI Responses", async () => {
		await streamAzureOpenAIResponses(createAzureResponsesModel(), context, {
			apiKey: "test-key",
			azureBaseUrl: "https://my-resource.openai.azure.com/openai/v1",
			reasoningEffort: "minimal",
		}).result();

		expect(mockState.lastAzureResponsesParams?.reasoning?.effort).toBe("low");
	});
});

function createCompletionsModel(overrides: Partial<Model<"openai-completions">> = {}): Model<"openai-completions"> {
	return {
		id: "compat-chat-model",
		name: "Compat Chat Model",
		api: "openai-completions",
		provider: "custom-provider:test",
		baseUrl: "https://compat.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 20000,
		compat: { supportsReasoningEffort: true },
		...overrides,
	};
}

function createResponsesModel(): Model<"openai-responses"> {
	return {
		id: "compat-responses-model",
		name: "Compat Responses Model",
		api: "openai-responses",
		provider: "custom-provider:test",
		baseUrl: "https://compat.example/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 20000,
	};
}

function createAzureResponsesModel(): Model<"azure-openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "Azure GPT-5 Mini",
		api: "azure-openai-responses",
		provider: "azure-openai-responses",
		baseUrl: "https://my-resource.openai.azure.com/openai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 20000,
	};
}
