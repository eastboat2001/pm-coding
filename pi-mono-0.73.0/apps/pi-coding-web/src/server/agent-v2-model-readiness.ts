import type { JsonObject } from "@mariozechner/pi-web-workspace/runtime-infra";
import { ConfiguredAgentV2ServerModelRegistry } from "../worker/agent-v2-pi-model-execution.js";
import { loadAgentV2ServerSettingsSnapshotFromRecord } from "../worker/global-provider-keys.js";

export interface AgentV2ModelReadinessInput {
	model: { provider: string; id: string };
	settings: JsonObject | undefined;
}

export interface AgentV2ModelReadinessFailure {
	code: string;
	message: string;
	statusCode: number;
}

export function validateAgentV2ModelReadiness(
	input: AgentV2ModelReadinessInput,
): AgentV2ModelReadinessFailure | undefined {
	const snapshot = loadAgentV2ServerSettingsSnapshotFromRecord(input.settings);
	if (snapshot.configurationState() === "invalid") {
		return failure(
			"agent_v2.model.settings_invalid",
			"服务器模型配置文件无效或已损坏。请重新保存模型配置，或检查服务器设置文件后重试。",
			409,
		);
	}

	const registry = new ConfiguredAgentV2ServerModelRegistry(snapshot);
	const model = registry.resolve(input.model);
	if (!model) {
		if (!input.model.provider.startsWith("custom-provider:")) {
			return failure(
				"agent_v2.model.unknown_model",
				"服务器未配置当前模型。请在模型选择器中手动选择一个服务器可用模型后重试。",
				422,
			);
		}
		const providerId = input.model.provider.slice("custom-provider:".length);
		const provider = snapshot.customProvider(providerId);
		if (provider && !snapshot.isSelectedModelSynchronized()) {
			return failure(
				"agent_v2.model.stale_configuration",
				"当前模型选择对应的是旧版提供方配置。请重新选择并保存该模型，使其与服务器最新配置对齐。",
				409,
			);
		}
		return failure(
			"agent_v2.model.not_synchronized",
			"当前会话中的模型只存在于浏览器旧状态，尚未同步到服务器。请在模型设置中重新保存提供方和模型后重试。",
			409,
		);
	}

	const authentication = registry.resolveAuthentication?.(input.model) ?? "required";
	if (authentication !== "trusted-local-optional" && !snapshot.resolveApiKey(model.provider)) {
		return failure(
			"agent_v2.model.missing_api_key",
			"服务器尚未保存当前模型提供方的有效访问凭据。请重新保存 API Key 后重试。",
			422,
		);
	}
	return undefined;
}

function failure(code: string, message: string, statusCode: number): AgentV2ModelReadinessFailure {
	return { code, message, statusCode };
}
