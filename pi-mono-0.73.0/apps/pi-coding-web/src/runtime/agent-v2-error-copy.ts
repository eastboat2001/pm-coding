import type { AgentV2Error, AgentV2ResponseLanguage } from "@mariozechner/pi-web-workspace";

const CHINESE_ERROR_COPY: Readonly<Record<string, string>> = Object.freeze({
	"agent_v2.model.invalid_model_reference": "当前模型配置无效，请在模型选择器中重新选择模型。",
	"agent_v2.model.unknown_model": "服务器未配置当前模型，请在模型选择器中选择其他可用模型。",
	"agent_v2.model.missing_api_key": "服务器尚未配置当前模型提供方的访问凭据。",
	"agent_v2.model.provider_failed": "模型服务请求失败，未能生成完整结果。",
	"agent_v2.model.provider_identity_mismatch": "模型服务返回了与所选模型不一致的标识。",
	"agent_v2.model.invalid_provider_content": "模型服务返回了无法识别的内容。",
	"agent_v2.model.provider_length": "模型输出达到长度上限，未能返回完整应用。请改用输出容量更大的模型后重试。",
	"agent_v2.model.provider_tool_use": "模型尝试调用当前应用生成流程不支持的工具。",
	"agent_v2.model.provider_error": "模型服务返回错误，未能生成完整结果。",
	"agent_v2.model.provider_timeout": "模型服务在等待完整结果时超时。",
	"agent_v2.model.provider_network": "连接模型服务时发生网络错误。",
	"agent_v2.model.provider_rate_limit": "模型服务已达到请求频率限制，请稍后重试。",
	"agent_v2.model.provider_server_error": "模型服务暂时不可用，请稍后重试。",
	"agent_v2.model_contract.invalid_protocol": "模型回复未遵循应用生成所需的 JSON 协议，自动修复后仍未成功。",
	"agent_v2.model_contract.invalid_schema": "模型回复不符合应用生成结果的数据结构，自动修复后仍未成功。",
	"agent_v2.model_contract.invalid_identifier": "模型生成结果包含无效标识。",
	"agent_v2.model_contract.invalid_unicode": "模型生成结果包含无效文本编码。",
	"agent_v2.model_contract.unsafe_path": "模型生成结果包含不安全的文件路径。",
	"agent_v2.model_contract.duplicate_path": "模型生成结果包含冲突的文件路径。",
	"agent_v2.model_contract.limit_exceeded": "模型生成结果超过了安全限制。",
	"agent_v2.model_contract.repair_workspace_limit_exceeded":
		"修复上下文暂时无法装入安全预算。系统应分批提取相关代码并继续修复；请查看诊断确认是否存在异常大的单段内容。",
	"agent_v2.model_contract.prompt_invalid": "应用生成请求无法转换为有效的模型输入。",
	"agent_v2.model_contract.prompt_limit_exceeded": "应用生成请求超过了模型输入安全限制。",
});

export function agentV2UserFacingError(
	error: Pick<AgentV2Error, "code" | "message">,
	language: AgentV2ResponseLanguage,
): string {
	if (language !== "zh") return error.message;
	const base = CHINESE_ERROR_COPY[error.code];
	if (!base) return error.message;
	if (error.code !== "agent_v2.model.provider_timeout") return base;

	const details = error.message.match(/within\s+(\d+)ms\s+\((\d+)\s+provider attempts?\)/iu);
	if (!details) return base;
	const seconds = Math.max(1, Math.round(Number(details[1]) / 1000));
	const attempts = Number(details[2]);
	return `模型服务在连续 ${attempts} 次尝试中均未返回任何响应数据（每次等待 ${seconds} 秒），因此本次生成已停止。`;
}
