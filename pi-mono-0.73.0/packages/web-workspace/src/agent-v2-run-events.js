import { AGENT_V2_RUN_EVENT_TYPES } from "./agent-v2-types.js";
const AGENT_V2_RUN_EVENT_TYPE_SET = new Set(AGENT_V2_RUN_EVENT_TYPES);
export async function appendAgentV2RunEvent(sink, run, event) {
    if (!AGENT_V2_RUN_EVENT_TYPE_SET.has(event.type)) {
        throw new Error(`Unsupported Agent v2 transport event type: ${event.type}`);
    }
    await sink.persistAgentEvent(run, event);
}
//# sourceMappingURL=agent-v2-run-events.js.map
