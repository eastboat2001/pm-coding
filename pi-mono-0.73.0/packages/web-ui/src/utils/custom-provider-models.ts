import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import {
	type AutoDiscoveryProviderType,
	type CustomProvider,
	customProviderIdentity,
} from "../storage/stores/custom-providers-store.js";
import { discoverModels } from "./model-discovery.js";

export const CUSTOM_PROVIDER_DISCOVERY_TIMEOUT_MS = 5000;

type DiscoverModelsFn = (type: AutoDiscoveryProviderType, baseUrl: string, apiKey?: string) => Promise<Model<any>[]>;

export type CustomProviderModelEntry = {
	providerLabel: string;
	model: Model<any>;
};

type LoadCustomProviderModelsOptions = {
	discover?: DiscoverModelsFn;
	timeoutMs?: number;
};

export async function loadCustomProviderModels(
	providers: CustomProvider[],
	options: LoadCustomProviderModelsOptions = {},
): Promise<CustomProviderModelEntry[]> {
	const discover = options.discover ?? discoverModels;
	const timeoutMs = options.timeoutMs ?? CUSTOM_PROVIDER_DISCOVERY_TIMEOUT_MS;
	const providerResults = await Promise.all(
		providers.map((provider) => loadCustomProviderModelsForProvider(provider, discover, timeoutMs)),
	);
	return providerResults.flat();
}

async function loadCustomProviderModelsForProvider(
	provider: CustomProvider,
	discover: DiscoverModelsFn,
	timeoutMs: number,
): Promise<CustomProviderModelEntry[]> {
	if (!isAutoDiscoveryType(provider.type)) {
		return (provider.models ?? []).map((model) => ({
			providerLabel: provider.name,
			model: normalizeCustomProviderModel(model, provider),
		}));
	}

	try {
		const models = await withTimeout(discover(provider.type, provider.baseUrl, provider.apiKey), timeoutMs, []);
		return models.map((model) => ({
			providerLabel: provider.name,
			model: normalizeCustomProviderModel(
				applyAutoDiscoveryCompat(model, provider.useNonStreamingToolCalls),
				provider,
			),
		}));
	} catch (error) {
		console.debug(`Failed to load models from ${provider.name}:`, error);
		return [];
	}
}

function isAutoDiscoveryType(type: CustomProvider["type"]): type is AutoDiscoveryProviderType {
	return type === "ollama" || type === "llama.cpp" || type === "vllm" || type === "lmstudio";
}

function normalizeCustomProviderModel(model: Model<any>, provider: Pick<CustomProvider, "id">): Model<any> {
	return {
		...model,
		provider: customProviderIdentity(provider),
	};
}

type OpenAICompletionsCompatWithToolMode = OpenAICompletionsCompat & {
	useNonStreamingToolCalls?: boolean;
};

export function applyAutoDiscoveryCompat(model: Model<any>, useNonStreamingToolCalls = false): Model<any> {
	if (model.api !== "openai-completions") return model;

	const compat: OpenAICompletionsCompatWithToolMode = {
		...(model.compat as OpenAICompletionsCompat | undefined),
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
	};
	if (useNonStreamingToolCalls) {
		compat.useNonStreamingToolCalls = true;
	} else {
		delete compat.useNonStreamingToolCalls;
	}

	return {
		...model,
		compat: compat as Model<any>["compat"],
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timeoutId = setTimeout(() => resolve(fallback), Math.max(0, timeoutMs));
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}
