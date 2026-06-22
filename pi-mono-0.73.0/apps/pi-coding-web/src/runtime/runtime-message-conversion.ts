import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { RuntimeMessageRecord } from "@mariozechner/pi-web-workspace";

export function runtimeMessageToAgentMessage(message: RuntimeMessageRecord): AgentMessage {
	const payload = message.payload;
	return {
		...payload,
		role: message.role,
	} as AgentMessage;
}

export function trimRecoverableProviderStallErrors(messages: RuntimeMessageRecord[]): RuntimeMessageRecord[] {
	return messages.filter((message) => !isRecoverableProviderStallError(message));
}

function isRecoverableProviderStallError(message: RuntimeMessageRecord): boolean {
	if (message.role !== "assistant") return false;
	const errorMessage =
		typeof message.payload.errorMessage === "string"
			? message.payload.errorMessage
			: typeof message.error === "string"
				? message.error
				: "";
	return /^Model stream stalled for \d+ms without events\.$/.test(errorMessage);
}
