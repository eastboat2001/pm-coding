import type { AgentV2RunEventBus } from "./agent-v2-run-event-bus.js";
import type { AgentV2RunEventReadRequest } from "./agent-v2-run-events.js";
import type { AgentV2RunEventLogStore } from "./agent-v2-runtime-store.js";
import type { AgentV2RunEventRecord, AppendAgentV2RunEventInput } from "./agent-v2-store.js";

export interface AgentV2RunEventLogOptions {
	store: AgentV2RunEventLogStore;
	bus: AgentV2RunEventBus;
}

export class AgentV2RunEventLog {
	private readonly bus: AgentV2RunEventBus;
	private readonly store: AgentV2RunEventLogStore;

	constructor(options: AgentV2RunEventLogOptions) {
		this.store = options.store;
		this.bus = options.bus;
	}

	async append(input: AppendAgentV2RunEventInput): Promise<AgentV2RunEventRecord> {
		const event = await this.store.appendAgentV2RunEvent(input);
		await this.bus.publish(event);
		return event;
	}

	async list(clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> {
		return await this.store.listAgentV2RunEvents(clientId, runId, afterSeq);
	}

	async readLive(request: AgentV2RunEventReadRequest): Promise<AgentV2RunEventRecord[]> {
		const durableEvents = await this.list(request.clientId, request.runId, request.afterSeq);
		if (durableEvents.length > 0) {
			return durableEvents;
		}
		return await this.bus.read(request);
	}
}
