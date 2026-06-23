import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { AppStorage } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "../storage/configured-server-storage.js";

export const SELECTED_MODEL_KEY = "example.selectedModel";
type CustomProviderModelSource = {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	useNonStreamingToolCalls?: boolean;
};

export class ModelController {
	constructor(
		private readonly storage: AppStorage,
		private readonly configuredStorage: ConfiguredServerStorage,
	) {}

	async getDefaultModel(): Promise<Model<any> | undefined> {
		const storedModel = await this.storage.settings.get<Model<any>>(SELECTED_MODEL_KEY);
		const resolvedStoredModel = await this.resolveCustomModel(storedModel);
		if (resolvedStoredModel) return resolvedStoredModel;

		const configuredSettings = await this.configuredStorage.readSettings();
		const resolvedConfiguredModel = await this.resolveCustomModel(configuredSettings?.selectedModel);
		if (resolvedConfiguredModel) return resolvedConfiguredModel;

		const status = await this.configuredStorage.getStatus();
		const configuredDefault = await this.resolveCustomModel({
			provider: status?.defaultModelProvider,
			id: status?.defaultModelId,
		});
		if (configuredDefault) return configuredDefault;

		return await this.getFirstManualCustomModel();
	}

	async persistSelectedModel(model: Model<any> | undefined): Promise<void> {
		if (!(await this.isCustomProviderModel(model))) return;
		await this.storage.settings.set(SELECTED_MODEL_KEY, model);
		await this.configuredStorage.writeSettings({ selectedModel: model });
	}

	async resolveCustomModel(candidate: unknown): Promise<Model<any> | undefined> {
		if (!candidate || typeof candidate !== "object") return undefined;
		const model = candidate as Partial<Model<any>>;
		if (!model.provider || !model.id) return undefined;

		const customProviders = await this.storage.customProviders.getAll();
		const customProvider = customProviders.find((provider) =>
			customProviderMatchesIdentity(provider, model.provider),
		);
		if (!customProvider) return undefined;

		if (customProvider.models?.length) {
			const customModel = customProvider.models.find((item) => item.id === model.id);
			return customModel
				? applyCustomProviderCompat(customProvider, {
						...customModel,
						provider: customProviderIdentity(customProvider),
					})
				: undefined;
		}

		if (isCompleteModel(model)) return applyCustomProviderCompat(customProvider, model as Model<any>);
		return createCustomProviderModel(customProvider, model.id);
	}

	async resolveSavedCustomProviderModel(
		currentModel: Model<any> | undefined,
		provider: CustomProviderModelSource,
	): Promise<Model<any> | undefined> {
		if (!currentModel || !customProviderMatchesIdentity(provider, currentModel.provider)) return undefined;
		return await this.resolveCustomModel(currentModel);
	}

	private async isCustomProviderModel(model: Model<any> | undefined): Promise<boolean> {
		return !!(await this.resolveCustomModel(model));
	}

	private async getFirstManualCustomModel(): Promise<Model<any> | undefined> {
		const customProviders = await this.storage.customProviders.getAll();
		return customProviders.flatMap((provider) => provider.models || [])[0];
	}
}

function isCompleteModel(model: Partial<Model<any>>): boolean {
	return !!(
		model.name &&
		model.api &&
		model.baseUrl !== undefined &&
		model.input &&
		model.cost &&
		model.contextWindow &&
		model.maxTokens
	);
}

function createCustomProviderModel(provider: CustomProviderModelSource, modelId: string): Model<any> | undefined {
	const api =
		provider.type === "anthropic-messages"
			? "anthropic-messages"
			: provider.type === "openai-responses"
				? "openai-responses"
				: "openai-completions";
	const baseUrl =
		provider.type === "ollama" ||
		provider.type === "llama.cpp" ||
		provider.type === "vllm" ||
		provider.type === "lmstudio"
			? `${provider.baseUrl.replace(/\/+$/, "")}/v1`
			: provider.baseUrl;
	const model: Model<any> = {
		id: modelId,
		name: modelId,
		api,
		provider: provider.name,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	};
	return applyCustomProviderCompat(provider, model);
}

function applyCustomProviderCompat(provider: CustomProviderModelSource, model: Model<any>): Model<any> {
	const identity = customProviderIdentity(provider);
	const modelWithIdentity = model.provider === identity ? model : { ...model, provider: identity };
	if (model.api !== "openai-completions" || !["ollama", "llama.cpp", "vllm", "lmstudio"].includes(provider.type)) {
		return modelWithIdentity;
	}

	const compat: OpenAICompletionsCompat & { useNonStreamingToolCalls?: boolean } = {
		...(modelWithIdentity.compat as OpenAICompletionsCompat | undefined),
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
	};
	if (provider.useNonStreamingToolCalls) {
		compat.useNonStreamingToolCalls = true;
	} else {
		delete compat.useNonStreamingToolCalls;
	}

	return {
		...modelWithIdentity,
		compat: compat as Model<any>["compat"],
	};
}

function customProviderIdentity(provider: Pick<CustomProviderModelSource, "id">): string {
	return `custom-provider:${provider.id}`;
}

function customProviderMatchesIdentity(
	provider: Pick<CustomProviderModelSource, "id" | "name">,
	identity: string | undefined,
): boolean {
	if (!identity) return false;
	return identity === customProviderIdentity(provider) || identity === provider.id || identity === provider.name;
}
