import { createHash, randomUUID } from "node:crypto";
import type {
	AgentV2DurableCommitStore,
	AgentV2ExpectedRunState,
	AgentV2StartRunCommitInput,
	AgentV2StartRunCommitResult,
} from "./agent-v2-durable-store.js";
import { buildAgentV2PlanningBootstrap, toAgentV2PlanningCommit } from "./agent-v2-planning-bootstrap.js";
import type { AgentV2RunEventLog } from "./agent-v2-run-event-log.js";
import type { AgentV2RunApiStore } from "./agent-v2-runtime-store.js";
import {
	type AgentV2NormalizedStartPayload,
	AgentV2StartInputError,
	bindAgentV2StartPayload,
	normalizeAgentV2RunId,
	normalizeAgentV2StartPayload,
} from "./agent-v2-start-input.js";
import type { AgentV2Phase, AgentV2RunInput, AgentV2RunSnapshot, AgentV2RunStatus } from "./agent-v2-types.js";

export interface AgentV2StartRunRequest {
	input: unknown;
	model: unknown;
	runId?: string;
}

export interface AgentV2RunApiServiceOptions {
	store: AgentV2DurableCommitStore & Pick<AgentV2RunApiStore, "getAgentV2Run" | "listAgentV2Runs">;
	events: Pick<AgentV2RunEventLog, "list">;
	queueName: string;
	wakeDispatcher?: () => void | Promise<void>;
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
	private readonly events: Pick<AgentV2RunEventLog, "list">;
	private readonly now: () => string;
	private readonly queueName: string;
	private readonly store: AgentV2DurableCommitStore & Pick<AgentV2RunApiStore, "getAgentV2Run" | "listAgentV2Runs">;
	private readonly wakeDispatcher?: () => void | Promise<void>;

	constructor(options: AgentV2RunApiServiceOptions) {
		this.store = options.store;
		this.events = options.events;
		this.queueName = requireQueueName(options.queueName);
		this.wakeDispatcher = options.wakeDispatcher;
		this.now = options.now ?? (() => new Date().toISOString());
		this.createRunId = options.createRunId ?? (() => randomUUID());
	}

	async startRun(clientId: string, request: AgentV2StartRunRequest): Promise<AgentV2RunSnapshot> {
		const hasExplicitRunId = request.runId !== undefined;
		const runId = normalizeRunId(request.runId ?? this.createRunId());
		const payload = normalizeStartPayload(request, runId);
		const existing = hasExplicitRunId ? await this.store.getAgentV2Run(clientId, runId) : undefined;
		const createdAt = existing?.createdAt ?? this.now();
		let committed: AgentV2StartRunCommitResult;
		try {
			committed = await this.store.commitAgentV2RunStart(
				buildStartCommitInput(payload, { clientId, runId, createdAt }, this.queueName),
			);
		} catch (error) {
			if (!existing && hasExplicitRunId && isStartReplayConflict(error)) {
				const winner = await this.store.getAgentV2Run(clientId, runId);
				if (winner) {
					try {
						committed = await this.store.commitAgentV2RunStart(
							buildStartCommitInput(payload, { clientId, runId, createdAt: winner.createdAt }, this.queueName),
						);
					} catch (retryError) {
						throw mapStartConflict(retryError);
					}
				} else {
					throw mapStartConflict(error);
				}
			} else {
				throw mapStartConflict(error);
			}
		}
		await this.wakeDispatcherSafely();
		return committed.run;
	}

	async cancelRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot> {
		const run = await this.requireRun(clientId, runId);
		if (isTerminalRun(run.status) || run.status === "cancelling") return run;
		if (run.status !== "queued" && run.status !== "running") {
			throw new AgentV2RunApiError("Agent v2 run cannot be cancelled from its current state", 409);
		}
		const cancelledAt = nextCanonicalTimestamp(this.now(), run.updatedAt);
		try {
			const result = await this.store.commitAgentV2RunCancel({
				clientId,
				runId,
				expectedStatuses: [run.status],
				expectedRun: expectedRunState(run),
				queueName: this.queueName,
				cancelToken: deterministicCancelToken(clientId, runId),
				cancelledAt,
				reason: "user_requested",
			});
			await this.wakeDispatcherSafely();
			return result.run;
		} catch (error) {
			if (isCancelConflict(error)) {
				const current = await this.store.getAgentV2Run(clientId, runId);
				if (current && isTerminalRun(current.status)) return current;
			}
			throw mapCancelConflict(error);
		}
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

	private async requireRun(clientId: string, runId: string): Promise<AgentV2RunSnapshot> {
		const run = await this.store.getAgentV2Run(clientId, runId);
		if (!run) throw new AgentV2RunApiError("Agent v2 run not found", 404);
		return run;
	}

	private async wakeDispatcherSafely(): Promise<void> {
		if (!this.wakeDispatcher) return;
		await Promise.resolve()
			.then(() => this.wakeDispatcher?.())
			.catch(() => undefined);
	}
}

function normalizeStartPayload(request: AgentV2StartRunRequest, runId: string): AgentV2NormalizedStartPayload {
	try {
		return normalizeAgentV2StartPayload(request, runId);
	} catch (error) {
		if (error instanceof AgentV2StartInputError) throw new AgentV2RunApiError(error.message, 400);
		throw error;
	}
}

function buildStartCommitInput(
	payload: AgentV2NormalizedStartPayload,
	identity: { clientId: string; runId: string; createdAt: string },
	queueName: string,
): AgentV2StartRunCommitInput {
	const normalized = bindAgentV2StartPayload(payload, identity);
	const initialRun: AgentV2RunSnapshot = {
		clientId: identity.clientId,
		runId: identity.runId,
		status: "queued",
		phase: "intake",
		attempt: 1,
		input: normalized.runInput,
		model: normalized.model,
		createdAt: identity.createdAt,
		updatedAt: identity.createdAt,
	};
	const bootstrap = buildAgentV2PlanningBootstrap({
		run: initialRun,
		inputBlobs: normalized.inputBlobs,
		now: () => identity.createdAt,
	});
	const planning = toAgentV2PlanningCommit(bootstrap);
	return {
		run: {
			clientId: identity.clientId,
			runId: identity.runId,
			input: normalized.runInput,
			model: normalized.model,
			createdAt: identity.createdAt,
			updatedAt: identity.createdAt,
		},
		bootstrapVersion: planning.bootstrapVersion,
		bootstrapChecksum: planning.bootstrapChecksum,
		inputBlobs: normalized.inputBlobs,
		inputReferences: normalized.inputReferences,
		readyPhase: "implementation",
		documents: planning.documents,
		tasks: planning.tasks,
		artifacts: planning.artifacts,
		diagnostics: planning.diagnostics,
		queueName,
		createdAt: identity.createdAt,
	};
}

function normalizeRunId(value: unknown): string {
	try {
		return normalizeAgentV2RunId(value);
	} catch (error) {
		if (error instanceof AgentV2StartInputError) throw new AgentV2RunApiError(error.message, 400);
		throw error;
	}
}

function expectedRunState(run: AgentV2RunSnapshot): AgentV2ExpectedRunState {
	return {
		status: run.status,
		phase: run.phase,
		attempt: run.attempt,
		workerId: run.workerId ?? null,
		updatedAt: run.updatedAt,
	};
}

function deterministicCancelToken(clientId: string, runId: string): string {
	return `cancel:${createHash("sha256").update(`${clientId}\0${runId}\0cancel`).digest("hex")}`;
}

function nextCanonicalTimestamp(proposed: string, current: string): string {
	const proposedMs = canonicalTimestamp(proposed, "cancelledAt");
	const currentMs = canonicalTimestamp(current, "current run revision");
	return new Date(Math.max(proposedMs, currentMs + 1)).toISOString();
}

function canonicalTimestamp(value: string, label: string): number {
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
		throw new AgentV2RunApiError(`Agent v2 ${label} must be a canonical UTC millisecond timestamp`, 500);
	}
	return epoch;
}

function requireQueueName(value: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error("Agent v2 queueName is required");
	return value.trim();
}

function isTerminalRun(status: AgentV2RunStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled" || status === "interrupted";
}

function isStartReplayConflict(error: unknown): boolean {
	return error instanceof Error && error.message === "Agent v2 run start replay conflict";
}

function isCancelConflict(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "Agent v2 cancel replay conflict" ||
			error.message === "Agent v2 cancel compare-and-set conflict")
	);
}

function mapStartConflict(error: unknown): unknown {
	if (isStartReplayConflict(error))
		return new AgentV2RunApiError("Agent v2 durable request conflicts with existing state", 409);
	return error;
}

function mapCancelConflict(error: unknown): unknown {
	if (isCancelConflict(error))
		return new AgentV2RunApiError("Agent v2 durable request conflicts with existing state", 409);
	return error;
}

export type { AgentV2RunInput, AgentV2RunSnapshot, AgentV2RunStatus, AgentV2Phase };
