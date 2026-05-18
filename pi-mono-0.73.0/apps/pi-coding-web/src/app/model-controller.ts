import { getModels, getProviders, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "../storage/configured-server-storage.js";

const FALLBACK_MODEL_PROVIDER: KnownProvider = "anthropic";
const FALLBACK_MODEL_ID = "claude-sonnet-4-5-20250929";
export const SELECTED_MODEL_KEY = "example.selectedModel";

export class ModelController {
	constructor(
		private readonly storage: AppStorage,
		private readonly configuredStorage: ConfiguredServerStorage,
	) {}

	async getDefaultModel(): Promise<Model<any>> {
		const storedModel = await this.storage.settings.get<Model<any>>(SELECTED_MODEL_KEY);
		if (storedModel && typeof storedModel === "object" && storedModel.id && storedModel.provider) return storedModel;
		const configuredSettings = await this.configuredStorage.readSettings();
		if (configuredSettings?.selectedModel && typeof configuredSettings.selectedModel === "object")
			return configuredSettings.selectedModel;
		const status = await this.configuredStorage.getStatus();
		const provider = isKnownProvider(status?.defaultModelProvider)
			? status.defaultModelProvider
			: FALLBACK_MODEL_PROVIDER;
		const configuredModel = getModels(provider).find((model) => model.id === status?.defaultModelId);
		const fallbackModel = getModels(FALLBACK_MODEL_PROVIDER).find((model) => model.id === FALLBACK_MODEL_ID);
		if (!fallbackModel) throw new Error(`Fallback model not found: ${FALLBACK_MODEL_PROVIDER}/${FALLBACK_MODEL_ID}`);
		return configuredModel || fallbackModel;
	}

	async persistSelectedModel(model: Model<any>): Promise<void> {
		await this.storage.settings.set(SELECTED_MODEL_KEY, model);
		await this.configuredStorage.writeSettings({ selectedModel: model });
	}
}

function isKnownProvider(provider: string | undefined): provider is KnownProvider {
	return !!provider && getProviders().includes(provider as KnownProvider);
}
