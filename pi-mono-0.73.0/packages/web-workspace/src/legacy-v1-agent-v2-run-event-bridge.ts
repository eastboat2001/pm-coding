import type { AgentV2RunTransportEvent } from "./agent-v2-run-events.js";
import { AGENT_V2_RUN_EVENT_TYPES } from "./agent-v2-types.js";
import type { RunEventSink } from "./run-event-sink.js";
import type { RuntimeRunRecord } from "./types.js";

const AGENT_V2_RUN_EVENT_TYPE_SET = new Set<string>(AGENT_V2_RUN_EVENT_TYPES);

export async function appendAgentV2RunEvent(
	sink: Pick<RunEventSink, "persistAgentEvent">,
	run: RuntimeRunRecord,
	event: AgentV2RunTransportEvent,
): Promise<void> {
	if (!AGENT_V2_RUN_EVENT_TYPE_SET.has(event.type)) {
		throw new Error(`Unsupported Agent v2 transport event type: ${event.type}`);
	}

	await sink.persistAgentEvent(run, event);
}
