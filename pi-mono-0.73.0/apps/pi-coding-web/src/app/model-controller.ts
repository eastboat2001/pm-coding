import { getModel, type Model } from "@mariozechner/pi-ai";
import type { AppStorage } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "../storage/configured-server-storage.js";

export const DEFAULT_MODEL_PROVIDER = "anthropic";
export const DEFAULT_MODEL_ID = "claude-sonnet-4-5-20250929";
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
		return getModel(DEFAULT_MODEL_PROVIDER, DEFAULT_MODEL_ID);
	}

	async persistSelectedModel(model: Model<any>): Promise<void> {
		await this.storage.settings.set(SELECTED_MODEL_KEY, model);
		await this.configuredStorage.writeSettings({ selectedModel: model });
	}
}
