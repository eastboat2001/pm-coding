import { randomUUID } from "node:crypto";
import type { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import { AgentV2RunInputContractError, validateAgentV2RunInput } from "./agent-v2-run-input-contract.js";
import type { AgentV2RunQueue } from "./agent-v2-run-queue.js";
import type { AgentV2RunApiStore } from "./agent-v2-runtime-store.js";
import type { AgentV2RunUpdateResult, CreateAgentV2RunInput, UpdateAgentV2RunInput } from "./agent-v2-store.js";
import type { AgentV2Phase, AgentV2RunInput, AgentV2RunSnapshot, AgentV2RunStatus } from "./agent-v2-types.js";

type AgentV2RunStore = AgentV2RunApiStore & {
	createAgentV2Run(input: CreateAgentV2RunInput): Promise<AgentV2RunSnapshot> | AgentV2RunSnapshot;
	updateAgentV2RunWithResult(input: UpdateAgentV2RunInput): Promise<AgentV2RunUpdateResult> | AgentV2RunUpdateResult;
};

export interface AgentV2StartRunRequest {
	input: AgentV2RunInput;
	model?: unknown;
	runId?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AgentV2RunApiServiceOptions {
	store: AgentV2RunStore;
	queue: AgentV2RunQueue;
	events: Pick<AgentV2RunEventLog, "append" | "list">;
	now?: () => string;
	createRunId?: () => string;
}

export class AgentV2RunApiError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
		this.name = "AgentV2RunApiError";
	}
}

export class AgentV2RunApiService {
	private readonly createRunId: () => string;
	private readonly events: Pick<AgentV2RunEventLog, "append" | "list">;
	private readonly now: () => string;
	private readonly queue: AgentV2RunQueue;
	private readonly store: AgentV2RunStore;

	constructor(options: AgentV2RunApiServiceOptions) {
		this.store = options.store;
		this.queue = options.queue;
		this.events = options.events;
		this.now = options.now ?? (() => new Date().toISOString());
		this.createRunId = options.createRunId ?? (() => randomUUID());
	}

	async startRun(clientId: string, request: AgentV2StartRunRequest): Promise<AgentV2RunSnapshot> {
		const input = validateStartRunInput(request.input);
		const createdAt = request.createdAt ?? this.now();
		const run = await this.store.createAgentV2Run({
			clientId,
			runId: request.runId ?? this.createRunId(),
			input,
			model: request.model ?? {},
			createdAt,
			updatedAt: request.updatedAt ?? createdAt,
		});
		try {
			await this.queue.enqueue({ clientId: run.clientId, runId: run.runId });
		} catch (error) {
			throw await this.handleEnqueueFailure(run, error);
		}
		await this.events.append({
			clientId: run.clientId,
			runId: run.runId,
			type: "agent_v2.run_created",
			payload: {
				type: "agent_v2.run_created",
				status: run.status,
				phase: run.phase,
				attempt: run.attempt,
				at: run.updatedAt,
			},
			createdAt: run.updatedAt,
		});
		return run;
	}

	async cancelRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot> {
		const run = await this.requireRun(clientId, runId);
		if (isTerminalRun(run.status)) {
			return run;
		}

		await this.queue.requestCancel({ clientId, runId });
		const updatedAt = this.now();
		if (run.status === "queued") {
			const cancelled = await this.store.updateAgentV2RunWithResult({
				clientId,
				runId,
				status: "cancelled",
				phase: "cancelled",
				updatedAt,
				endedAt: updatedAt,
				expectedStatuses: ["queued"],
			});
			if (cancelled.applied) {
				await this.appendPhaseEvent(cancelled.run, "cancelled");
			}
			return cancelled.run;
		}
		if (run.status === "cancelling") {
			return run;
		}

		const cancelling = await this.store.updateAgentV2RunWithResult({
			clientId,
			runId,
			status: "cancelling",
			updatedAt,
			expectedStatuses: ["running"],
		});
		if (cancelling.applied) {
			await this.appendPhaseEvent(cancelling.run, cancelling.run.status);
		}
		return cancelling.run;
	}

	async getRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot | undefined> {
		return await this.store.getAgentV2Run(clientId, runId);
	}

	async listRuns(clientId: string): Promise<AgentV2RunSnapshot[]> {
		return await this.store.listAgentV2Runs(clientId);
	}

	async listRunEvents(clientId: string, runId: string, afterSeq: number) {
		return await this.events.list(clientId, runId, afterSeq);
	}

	private async handleEnqueueFailure(run: AgentV2RunSnapshot, error: unknown): Promise<AgentV2RunApiError> {
		const updatedAt = this.now();
		const message = errorMessage(error);
		const interrupted = await this.store.updateAgentV2RunWithResult({
			clientId: run.clientId,
			runId: run.runId,
			status: "interrupted",
			updatedAt,
			endedAt: updatedAt,
			error: {
				code: "agent_v2.run_enqueue_failed",
				message,
				retryable: true,
			},
			expectedStatuses: ["queued"],
		});
		if (interrupted.applied) {
			await this.appendPhaseEvent(interrupted.run, interrupted.run.status);
		}
		return new AgentV2RunApiError(`Failed to enqueue agent v2 run: ${message}`, 503);
	}

	private async appendPhaseEvent(run: AgentV2RunSnapshot, status: AgentV2RunStatus): Promise<void> {
		await this.events.append({
			clientId: run.clientId,
			runId: run.runId,
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: run.phase,
				status,
				attempt: run.attempt,
				at: run.updatedAt,
			},
			createdAt: run.updatedAt,
		});
	}

	private async requireRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot> {
		const run = await this.store.getAgentV2Run(clientId, runId);
		if (!run) {
			throw new AgentV2RunApiError("Agent v2 run not found", 404);
		}
		return run;
	}
}

function isTerminalRun(status: AgentV2RunStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function validateStartRunInput(input: unknown): AgentV2RunInput {
	try {
		return validateAgentV2RunInput(input);
	} catch (error) {
		if (error instanceof AgentV2RunInputContractError) {
			throw new AgentV2RunApiError(error.message, 400);
		}
		throw error;
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

export type { AgentV2RunStore, AgentV2RunInput, AgentV2RunSnapshot, AgentV2RunStatus, AgentV2Phase };
