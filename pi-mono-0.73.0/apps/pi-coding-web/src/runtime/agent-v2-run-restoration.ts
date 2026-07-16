import type {
	AgentV2Error,
	AgentV2RunEventRecord,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
} from "@mariozechner/pi-web-workspace";
import { AgentV2BrowserController, type AgentV2BrowserRunSink } from "./agent-v2-browser-controller.js";

const TERMINAL_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);

export interface RestoreAgentV2BrowserRunProjectionOptions {
	snapshot: AgentV2RunSnapshot;
	events: readonly AgentV2RunEventRecord[];
	sink: AgentV2BrowserRunSink;
	terminalStatus?: AgentV2RunStatus;
	terminalAt?: string;
	error?: AgentV2Error;
}

export interface RestoredAgentV2BrowserRunProjection {
	controller: AgentV2BrowserController;
	active: boolean;
}

export function restoreAgentV2BrowserRunProjection(
	options: RestoreAgentV2BrowserRunProjectionOptions,
): RestoredAgentV2BrowserRunProjection {
	const controller = new AgentV2BrowserController(options.sink);
	controller.start(options.snapshot);
	if (options.events.length > 0) {
		controller.hydrate(options.events, Math.max(...options.events.map((event) => event.seq)));
	}
	if (options.terminalStatus && TERMINAL_STATUSES.has(options.terminalStatus)) {
		controller.settle(options.terminalStatus, options.terminalAt ?? options.snapshot.updatedAt, options.error);
		return { controller, active: false };
	}
	return { controller, active: true };
}
