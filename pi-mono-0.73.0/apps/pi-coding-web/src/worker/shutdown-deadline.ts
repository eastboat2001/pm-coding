import {
	type AgentV2CloseOptions,
	type AgentV2WorkerStopResult,
	createAgentV2ShutdownDeadline,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";

export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

export async function runWorkerShutdownDeadline(input: {
	run(options: AgentV2CloseOptions): Promise<AgentV2WorkerStopResult>;
	timeoutMs?: number;
}): Promise<AgentV2WorkerStopResult> {
	const deadline = createAgentV2ShutdownDeadline(input.timeoutMs ?? DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS);
	try {
		return await input.run(deadline);
	} finally {
		deadline.dispose();
	}
}
