import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	AgentV2Error,
	AgentV2Phase,
	AgentV2RunEventRecord,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
	AgentV2TaskKind,
	AgentV2TaskStatus,
	AgentV2ValidationStatus,
} from "@mariozechner/pi-web-workspace";

type AgentV2ArtifactValidationStatus = "not_started" | "pending" | "passed" | "failed" | "accepted";

export interface AgentV2TaskUpdatedPayload {
	type: "agent_v2.task_updated";
	taskId: string;
	kind: AgentV2TaskKind;
	status: AgentV2TaskStatus;
	phase: AgentV2Phase;
	at: string;
}

export interface AgentV2ArtifactIndexedPayload {
	type: "agent_v2.artifact_indexed";
	artifactId: string;
	path: string;
	validationStatus: AgentV2ArtifactValidationStatus;
	revision: string;
	at: string;
}

export interface AgentV2ValidationRecordedPayload {
	type: "agent_v2.validation_recorded";
	validationId: string;
	taskId: string;
	attempt: number;
	status: AgentV2ValidationStatus;
	summary: string;
	at: string;
}

export interface AgentV2OutputRecordedPayload {
	type: "agent_v2.output_recorded";
	taskId: string;
	summary: string;
	provider: string;
	model: string;
	usage?: {
		input: number;
		output: number;
		totalTokens: number;
		costTotal: number;
	};
	at: string;
}

export interface AgentV2DiagnosticRecordedPayload {
	type: "agent_v2.diagnostic_recorded";
	diagnosticId: string;
	severity: "debug" | "info" | "warn" | "error";
	code: string;
	message: string;
	at: string;
}

export interface AgentV2BrowserRunSink {
	beginRun(runId: string): void;
	setPhase(phase: AgentV2Phase, status: AgentV2RunStatus): void;
	setTask(event: AgentV2TaskUpdatedPayload): void;
	setArtifact(event: AgentV2ArtifactIndexedPayload): void;
	setValidation(event: AgentV2ValidationRecordedPayload): void;
	appendOutput(event: AgentV2OutputRecordedPayload): void;
	appendDiagnostic(event: AgentV2DiagnosticRecordedPayload): void;
	settle(status: AgentV2RunStatus, error?: AgentV2Error): void;
}

export type AgentV2BrowserRunEventDrainResult =
	| { ok: true; afterSeq: number }
	| { ok: false; afterSeq: number; error: unknown };

export type AgentV2BrowserTerminalSettlementResult =
	| { status: "inactive" }
	| { status: "retry"; drainResult?: AgentV2BrowserRunEventDrainResult }
	| { status: "settled"; drainResult: Extract<AgentV2BrowserRunEventDrainResult, { ok: true }> };

export async function settleAgentV2BrowserTerminalSnapshot(options: {
	controller?: AgentV2BrowserController;
	runId: string;
	status: AgentV2RunStatus;
	error?: AgentV2Error;
	drain: () => Promise<AgentV2BrowserRunEventDrainResult | undefined>;
	onSettled: () => void;
}): Promise<AgentV2BrowserTerminalSettlementResult> {
	const { controller, runId, status, error, drain, onSettled } = options;
	if (!controller || controller.activeRunId !== runId) return { status: "inactive" };

	const drainResult = await drain();
	if (!drainResult?.ok) return { status: "retry", ...(drainResult ? { drainResult } : {}) };
	if (controller.activeRunId !== runId) return { status: "inactive" };

	controller.settle(status, error);
	onSettled();
	return { status: "settled", drainResult };
}

export function agentV2OutputToAssistantMessage(event: AgentV2OutputRecordedPayload): AssistantMessage {
	const usage = event.usage ?? { input: 0, output: 0, totalTokens: 0, costTotal: 0 };
	return {
		role: "assistant",
		content: [{ type: "text", text: event.summary }],
		api: "agent-v2",
		provider: event.provider,
		model: event.model,
		usage: {
			input: usage.input,
			output: usage.output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage.totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.costTotal },
		},
		stopReason: "stop",
		timestamp: Date.parse(event.at),
	};
}

const PHASES = new Set<string>([
	"intake",
	"capability_routing",
	"spec_draft",
	"spec_review",
	"plan_draft",
	"task_generation",
	"implementation",
	"validation",
	"repair",
	"preview",
	"delivery",
	"blocked",
	"failed",
	"cancelled",
]);
const RUN_STATUSES = new Set<string>([
	"queued",
	"running",
	"cancelling",
	"succeeded",
	"failed",
	"cancelled",
	"interrupted",
]);
const TERMINAL_RUN_STATUSES = new Set<AgentV2RunStatus>(["cancelled", "succeeded", "failed", "interrupted"]);
const TASK_STATUSES = new Set<string>(["pending", "ready", "running", "blocked", "succeeded", "failed", "cancelled"]);
const VALIDATION_STATUSES = new Set<string>(["passed", "failed", "blocked", "warning"]);
const TASK_KINDS = new Set<string>([
	"capability",
	"spec",
	"plan",
	"implementation",
	"validation",
	"repair",
	"artifact",
	"delivery",
]);
const ARTIFACT_VALIDATION_STATUSES = new Set<string>(["not_started", "pending", "passed", "failed", "accepted"]);
const DIAGNOSTIC_SEVERITIES = new Set<string>(["debug", "info", "warn", "error"]);

export class AgentV2BrowserController {
	private _activeRunId: string | undefined;
	private _lastSeq = 0;
	private status: AgentV2RunStatus | undefined;
	private phase: AgentV2Phase | undefined;

	constructor(private readonly sink: AgentV2BrowserRunSink) {}

	start(run: AgentV2RunSnapshot): void {
		const runId = nonEmptyString(run.runId, "run.runId");
		if (this._activeRunId) throw new Error(`Agent v2 browser run ${this._activeRunId} is already active.`);
		const phase = requirePhase(run.phase, "run.phase");
		const status = requireRunStatus(run.status, "run.status");

		this.sink.beginRun(runId);
		this.sink.setPhase(phase, status);
		this._activeRunId = runId;
		this._lastSeq = 0;
		this.phase = phase;
		this.status = status;
	}

	apply(event: AgentV2RunEventRecord): void {
		const activeRunId = this.requireActiveRun("apply()");
		if (event.runId !== activeRunId) {
			throw new Error(`Agent v2 browser event ${event.runId} does not match active run ${activeRunId}.`);
		}
		const seq = requirePositiveSafeInteger(event.seq, "event.seq");
		if (seq <= this._lastSeq) return;
		const payload = requireRecord(event.payload, "event.payload");
		const payloadType = nonEmptyString(payload.type, "event.payload.type");
		if (event.type !== payloadType) {
			throw new Error(`Agent v2 event type ${event.type} does not match payload type ${payloadType}.`);
		}

		this.project(payloadType, payload);
		this._lastSeq = seq;
	}

	hydrate(events: readonly AgentV2RunEventRecord[], afterSeq: number): void {
		this.requireActiveRun("hydrate()");
		const checkpoint = requireNonNegativeSafeInteger(afterSeq, "afterSeq");
		for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
			this.apply(event);
		}
		this._lastSeq = Math.max(this._lastSeq, checkpoint);
	}

	settle(status: AgentV2RunStatus, error?: AgentV2Error): void {
		this.requireActiveRun("settle()");
		const terminalStatus = requireRunStatus(status, "status");
		if (!TERMINAL_RUN_STATUSES.has(terminalStatus)) {
			throw new Error(`Agent v2 browser run status ${terminalStatus} is not terminal.`);
		}
		this.sink.settle(terminalStatus, error);
		this._activeRunId = undefined;
		this.status = terminalStatus;
	}

	get activeRunId(): string | undefined {
		return this._activeRunId;
	}

	get lastSeq(): number {
		return this._lastSeq;
	}

	private project(type: string, payload: Record<string, unknown>): void {
		switch (type) {
			case "agent_v2.run_created": {
				assertOnlyPayloadFields(payload, type, ["type", "status", "phase", "attempt", "at"]);
				const status = requireRunStatus(payload.status, `${type}.status`);
				const phase = requirePhase(payload.phase, `${type}.phase`);
				requireNonNegativeSafeInteger(payload.attempt, `${type}.attempt`);
				requireTimestamp(payload.at, `${type}.at`);
				this.sink.setPhase(phase, status);
				this.status = status;
				this.phase = phase;
				return;
			}
			case "agent_v2.planning_ready": {
				assertOnlyPayloadFields(payload, type, ["type", "phase", "at"]);
				const phase = requirePhase(payload.phase, `${type}.phase`);
				requireTimestamp(payload.at, `${type}.at`);
				this.sink.setPhase(phase, this.requireStatus(type));
				this.phase = phase;
				return;
			}
			case "agent_v2.phase_changed": {
				assertOnlyPayloadFields(payload, type, [
					"type",
					"phase",
					"status",
					"attempt",
					"at",
					"reason",
					"cancelFingerprint",
				]);
				const phase = requirePhase(payload.phase, `${type}.phase`);
				const status = requireRunStatus(payload.status, `${type}.status`);
				if (payload.attempt !== undefined) requireNonNegativeSafeInteger(payload.attempt, `${type}.attempt`);
				requireTimestamp(payload.at, `${type}.at`);
				if (payload.reason !== undefined || payload.cancelFingerprint !== undefined) {
					if (phase !== "cancelled" || status !== "cancelled") {
						throw new Error(`Invalid ${type} cancellation metadata.`);
					}
					if (payload.reason !== undefined) nonEmptyString(payload.reason, `${type}.reason`);
					if (
						typeof payload.cancelFingerprint !== "string" ||
						!/^[a-f0-9]{64}$/u.test(payload.cancelFingerprint)
					) {
						throw new Error(`Invalid ${type}.cancelFingerprint.`);
					}
				}
				this.sink.setPhase(phase, status);
				this.phase = phase;
				this.status = status;
				return;
			}
			case "agent_v2.task_updated": {
				assertOnlyPayloadFields(payload, type, ["type", "taskId", "kind", "status", "phase", "at"]);
				const event: AgentV2TaskUpdatedPayload = {
					type,
					taskId: nonEmptyString(payload.taskId, `${type}.taskId`),
					kind: requireSetValue(payload.kind, TASK_KINDS, `${type}.kind`) as AgentV2TaskKind,
					status: requireSetValue(payload.status, TASK_STATUSES, `${type}.status`) as AgentV2TaskStatus,
					phase: requirePhase(payload.phase, `${type}.phase`),
					at: requireTimestamp(payload.at, `${type}.at`),
				};
				this.sink.setTask(event);
				return;
			}
			case "agent_v2.artifact_indexed": {
				assertOnlyPayloadFields(payload, type, [
					"type",
					"artifactId",
					"path",
					"validationStatus",
					"revision",
					"at",
				]);
				const event: AgentV2ArtifactIndexedPayload = {
					type,
					artifactId: nonEmptyString(payload.artifactId, `${type}.artifactId`),
					path: nonEmptyString(payload.path, `${type}.path`),
					validationStatus: requireSetValue(
						payload.validationStatus,
						ARTIFACT_VALIDATION_STATUSES,
						`${type}.validationStatus`,
					) as AgentV2ArtifactValidationStatus,
					revision: nonEmptyString(payload.revision, `${type}.revision`),
					at: requireTimestamp(payload.at, `${type}.at`),
				};
				this.sink.setArtifact(event);
				return;
			}
			case "agent_v2.validation_recorded": {
				assertOnlyPayloadFields(payload, type, [
					"type",
					"validationId",
					"taskId",
					"attempt",
					"status",
					"summary",
					"at",
				]);
				const event: AgentV2ValidationRecordedPayload = {
					type,
					validationId: nonEmptyString(payload.validationId, `${type}.validationId`),
					taskId: nonEmptyString(payload.taskId, `${type}.taskId`),
					attempt: requirePositiveSafeInteger(payload.attempt, `${type}.attempt`),
					status: requireSetValue(
						payload.status,
						VALIDATION_STATUSES,
						`${type}.status`,
					) as AgentV2ValidationStatus,
					summary: nonEmptyString(payload.summary, `${type}.summary`),
					at: requireTimestamp(payload.at, `${type}.at`),
				};
				this.sink.setValidation(event);
				return;
			}
			case "agent_v2.diagnostic_recorded": {
				assertOnlyPayloadFields(payload, type, ["type", "diagnosticId", "severity", "code", "message", "at"]);
				const event: AgentV2DiagnosticRecordedPayload = {
					type,
					diagnosticId: nonEmptyString(payload.diagnosticId, `${type}.diagnosticId`),
					severity: requireSetValue(
						payload.severity,
						DIAGNOSTIC_SEVERITIES,
						`${type}.severity`,
					) as AgentV2DiagnosticRecordedPayload["severity"],
					code: nonEmptyString(payload.code, `${type}.code`),
					message: nonEmptyString(payload.message, `${type}.message`),
					at: requireTimestamp(payload.at, `${type}.at`),
				};
				this.sink.appendDiagnostic(event);
				return;
			}
			case "agent_v2.output_recorded": {
				assertOnlyPayloadFields(payload, type, ["type", "taskId", "summary", "provider", "model", "usage", "at"]);
				const event: AgentV2OutputRecordedPayload = {
					type,
					taskId: nonEmptyString(payload.taskId, `${type}.taskId`),
					summary: nonEmptyString(payload.summary, `${type}.summary`),
					provider: nonEmptyString(payload.provider, `${type}.provider`),
					model: nonEmptyString(payload.model, `${type}.model`),
					...(payload.usage === undefined ? {} : { usage: requireUsage(payload.usage, `${type}.usage`) }),
					at: requireTimestamp(payload.at, `${type}.at`),
				};
				this.sink.appendOutput(event);
				return;
			}
			default:
				throw new Error(`Unsupported Agent v2 browser event payload type ${type}.`);
		}
	}

	private requireActiveRun(operation: string): string {
		if (!this._activeRunId) throw new Error(`start() must be called before ${operation}.`);
		return this._activeRunId;
	}

	private requireStatus(eventType: string): AgentV2RunStatus {
		if (!this.status) throw new Error(`Agent v2 run status is unavailable while applying ${eventType}.`);
		return this.status;
	}
}

function requireUsage(value: unknown, label: string): NonNullable<AgentV2OutputRecordedPayload["usage"]> {
	const usage = requireRecord(value, label);
	assertOnlyPayloadFields(usage, label, ["input", "output", "totalTokens", "costTotal"]);
	return {
		input: requireNonNegativeFiniteNumber(usage.input, `${label}.input`),
		output: requireNonNegativeFiniteNumber(usage.output, `${label}.output`),
		totalTokens: requireNonNegativeFiniteNumber(usage.totalTokens, `${label}.totalTokens`),
		costTotal: requireNonNegativeFiniteNumber(usage.costTotal, `${label}.costTotal`),
	};
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`Invalid ${label}.`);
	}
	return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid ${label}.`);
	return value;
}

function requireTimestamp(value: unknown, label: string): string {
	const timestamp = nonEmptyString(value, label);
	if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Invalid ${label}.`);
	return timestamp;
}

function requirePhase(value: unknown, label: string): AgentV2Phase {
	return requireSetValue(value, PHASES, label) as AgentV2Phase;
}

function requireRunStatus(value: unknown, label: string): AgentV2RunStatus {
	return requireSetValue(value, RUN_STATUSES, label) as AgentV2RunStatus;
}

function requireSetValue(value: unknown, allowed: ReadonlySet<string>, label: string): string {
	const text = nonEmptyString(value, label);
	if (!allowed.has(text)) throw new Error(`Invalid ${label}.`);
	return text;
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}.`);
	return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
	return value;
}

function requireNonNegativeFiniteNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}.`);
	return value;
}

function assertOnlyPayloadFields(payload: Record<string, unknown>, label: string, fields: readonly string[]): void {
	const allowed = new Set(fields);
	if (Object.keys(payload).some((field) => !allowed.has(field))) throw new Error(`Invalid ${label} payload fields.`);
}
