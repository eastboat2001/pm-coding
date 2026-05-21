import type { Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "../storage/configured-server-storage.js";

export const SELECTED_MODEL_KEY = "example.selectedModel";

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
		const customProvider = customProviders.find((provider) => provider.name === model.provider);
		if (!customProvider) return undefined;

		if (customProvider.models?.length) {
			return customProvider.models.find((item) => item.id === model.id);
		}

		if (isCompleteModel(model)) return model as Model<any>;
		return createCustomProviderModel(customProvider, model.id);
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

function createCustomProviderModel(
	provider: { name: string; type: string; baseUrl: string },
	modelId: string,
): Model<any> | undefined {
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
	return {
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
}
