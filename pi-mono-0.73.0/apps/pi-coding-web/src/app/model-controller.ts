import type { Model, OpenAICompletionsCompat } from "@mariozechner/pi-ai";
import type { AppStorage } from "@mariozechner/pi-web-ui";
import type { ConfiguredServerStorage } from "../storage/configured-server-storage.js";

export const SELECTED_MODEL_KEY = "example.selectedModel";
export const AGENT_V2_MIN_MODEL_OUTPUT_TOKENS = 8_192;
type CustomProviderModelSource = {
	id: string;
	name: string;
	type: string;
	baseUrl: string;
	useNonStreamingToolCalls?: boolean;
};

export type AgentV2ModelSynchronizationErrorCode =
	| "agent_v2.model.not_synchronized"
	| "agent_v2.model.settings_unavailable"
	| "agent_v2.model.stale_configuration";

export class AgentV2ModelSynchronizationError extends Error {
	constructor(
		readonly code: AgentV2ModelSynchronizationErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "AgentV2ModelSynchronizationError";
	}
}

export class ModelController {
	constructor(
		private readonly storage: AppStorage,
		private readonly configuredStorage: ConfiguredServerStorage,
	) {}

	async getDefaultModel(): Promise<Model<any> | undefined> {
		const configuredSettings = await this.configuredStorage.readSettings();
		const resolvedConfiguredModel = await this.resolveCustomModel(configuredSettings?.selectedModel);
		if (resolvedConfiguredModel) return resolvedConfiguredModel;

		const status = await this.configuredStorage.getStatus();
		const configuredDefault = await this.resolveCustomModel({
			provider: status?.defaultModelProvider,
			id: status?.defaultModelId,
		});
		if (configuredDefault) return configuredDefault;

		const storedModel = await this.storage.settings.get<Model<any>>(SELECTED_MODEL_KEY);
		const resolvedStoredModel = await this.resolveCustomModel(storedModel);
		if (resolvedStoredModel) return resolvedStoredModel;

		return await this.getFirstManualCustomModel();
	}

	async persistSelectedModel(model: Model<any> | undefined): Promise<boolean> {
		const resolvedModel = await this.resolveCustomModel(model);
		if (!resolvedModel) return false;
		try {
			return (await this.persistResolvedCustomModel(resolvedModel)) === "ready";
		} catch {
			return false;
		}
	}

	async synchronizeSelectedModelForV2(model: Model<any> | undefined): Promise<Model<any>> {
		if (!model) {
			throw new AgentV2ModelSynchronizationError(
				"agent_v2.model.not_synchronized",
				"当前没有可用于应用生成的模型，请先在模型选择器中选择并保存模型。",
			);
		}
		if (!model.provider.startsWith("custom-provider:")) return model;

		let resolvedModel: Model<any> | undefined;
		try {
			resolvedModel = await this.resolveCustomModel(model);
		} catch (error) {
			throw new AgentV2ModelSynchronizationError(
				"agent_v2.model.settings_unavailable",
				"无法读取服务器上的模型配置，请检查 PI 服务连接后重试。",
				{ cause: error },
			);
		}
		if (!resolvedModel) {
			throw new AgentV2ModelSynchronizationError(
				"agent_v2.model.not_synchronized",
				"当前会话引用的是浏览器旧模型状态，但服务器没有对应配置。请在模型设置中重新保存该提供方和模型后重试。",
			);
		}

		let status: Awaited<ReturnType<ModelController["persistResolvedCustomModel"]>>;
		try {
			status = await this.persistResolvedCustomModel(resolvedModel);
		} catch (error) {
			throw new AgentV2ModelSynchronizationError(
				"agent_v2.model.settings_unavailable",
				"模型配置无法同步到 PI 服务器，请检查服务连接和服务器存储权限后重试。",
				{ cause: error },
			);
		}
		if (status === "ready") return resolvedModel;
		if (status === "stale") {
			throw new AgentV2ModelSynchronizationError(
				"agent_v2.model.stale_configuration",
				"模型提供方配置已发生变化，当前选择尚未与新版本对齐。请重新选择该模型后重试。",
			);
		}
		throw new AgentV2ModelSynchronizationError(
			"agent_v2.model.settings_unavailable",
			"模型配置未能写入并从 PI 服务器读回确认，请检查服务连接和服务器存储权限后重试。",
		);
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

	private async persistResolvedCustomModel(
		model: Model<any>,
	): Promise<"ready" | "write_failed" | "readback_failed" | "stale"> {
		if (!(await this.configuredStorage.writeSettings({ selectedModel: model }))) return "write_failed";
		const confirmed = await this.configuredStorage.readSettings();
		if (confirmed?.selectedModel?.provider !== model.provider || confirmed.selectedModel.id !== model.id) {
			return "readback_failed";
		}
		const modelRevision = confirmed.modelConfigRevision ?? 0;
		const selectedRevision = confirmed.selectedModelConfigRevision ?? 0;
		if (modelRevision !== selectedRevision) return "stale";
		await this.storage.settings.set(SELECTED_MODEL_KEY, model);
		return "ready";
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

export function supportsApplicationGeneration(model: Model<any> | undefined): model is Model<any> {
	return !!model && Number.isSafeInteger(model.maxTokens) && model.maxTokens >= AGENT_V2_MIN_MODEL_OUTPUT_TOKENS;
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
