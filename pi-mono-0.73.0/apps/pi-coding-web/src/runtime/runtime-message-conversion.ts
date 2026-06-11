import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { RuntimeMessageRecord } from "@mariozechner/pi-web-workspace";

export function runtimeMessageToAgentMessage(message: RuntimeMessageRecord): AgentMessage {
	const payload = message.payload;
	return {
		...payload,
		role: typeof payload.role === "string" ? payload.role : message.role,
	} as AgentMessage;
}
