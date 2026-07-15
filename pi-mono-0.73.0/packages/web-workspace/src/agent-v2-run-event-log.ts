import type { AgentV2RunEventLogStore } from "./agent-v2-runtime-store.js";
import type { AgentV2RunEventRecord, AppendAgentV2RunEventInput } from "./agent-v2-store.js";

export interface AgentV2RunEventLogOptions {
	store: AgentV2RunEventLogStore;
}

export class AgentV2RunEventLog {
	private readonly store: AgentV2RunEventLogStore;

	constructor(options: AgentV2RunEventLogOptions) {
		this.store = options.store;
	}

	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		return await this.store.appendAgentV2RunEvent(input);
	}

	async list(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		return await this.store.listAgentV2RunEvents(clientId, runId, afterSeq);
	}
}
