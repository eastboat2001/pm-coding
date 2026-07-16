import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AgentV2Error,
	AgentV2Phase,
	AgentV2RunStatus,
	AgentV2RunTransportEvent,
} from "@mariozechner/pi-web-workspace";
import type {
	AgentV2ArtifactIndexedPayload,
	AgentV2BrowserRunSink,
	AgentV2DeliveryReportPayload,
	AgentV2DiagnosticRecordedPayload,
	AgentV2OutputRecordedPayload,
	AgentV2SkillAppliedPayload,
	AgentV2SkillResourceLoadedPayload,
	AgentV2TaskUpdatedPayload,
	AgentV2ValidationRecordedPayload,
} from "./agent-v2-browser-controller.js";
import {
	createAgentV2NarrationState,
	narrationCandidateToAssistantMessage,
	projectAgentV2Narration,
} from "./agent-v2-narration.js";
import {
	type AgentV2RunPresentation,
	type AgentV2RunPresentationAction,
	createAgentV2RunPresentationStore,
	reduceAgentV2RunPresentation,
	serializeAgentV2TerminalRunPresentation,
	type TerminalAgentV2RunStatus,
} from "./agent-v2-run-presentation.js";
import {
	appendOrReplaceAgentV2RunResultMessage,
	createAgentV2RunResultMessage,
} from "./agent-v2-run-result-message.js";

export type AgentV2BrowserProjectedEvent =
	| AgentV2TaskUpdatedPayload
	| AgentV2ArtifactIndexedPayload
	| AgentV2ValidationRecordedPayload
	| AgentV2DiagnosticRecordedPayload
	| AgentV2OutputRecordedPayload
	| AgentV2SkillAppliedPayload
	| AgentV2SkillResourceLoadedPayload
	| AgentV2DeliveryReportPayload;

export interface AgentV2BrowserAgentState {
	messages: AgentMessage[];
	isStreaming: boolean;
	streamingMessage?: AgentMessage;
	pendingToolCalls: ReadonlySet<string>;
	errorMessage?: string;
}

export interface AgentV2BrowserAgent {
	state: AgentV2BrowserAgentState;
}

export interface AgentV2BrowserRunSinkOptions {
	browserAgent: AgentV2BrowserAgent;
	locale: () => string;
	onPresentationChange: (presentation: AgentV2RunPresentation | undefined) => void;
	onPhaseProjected?: (runId: string, phase: AgentV2Phase, status: AgentV2RunStatus, at: string) => void;
	onEventProjected?: (runId: string, event: AgentV2BrowserProjectedEvent) => void;
}

const TERMINAL_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);

export function createAgentV2BrowserRunSink(options: AgentV2BrowserRunSinkOptions): AgentV2BrowserRunSink {
	let activeRunId: string | undefined;
	let startedAt: string | undefined;
	let presentationStore = createAgentV2RunPresentationStore();
	let narrationState = createAgentV2NarrationState();

	const publish = (action: AgentV2RunPresentationAction): AgentV2RunPresentation => {
		presentationStore = reduceAgentV2RunPresentation(presentationStore, action);
		const presentation = presentationStore.runs.get(action.runId);
		if (!presentation) throw new Error(`Agent v2 run ${action.runId} presentation is unavailable.`);
		options.onPresentationChange(presentation);
		return presentation;
	};

	const requireActiveRunId = (): string => {
		if (!activeRunId) throw new Error("Agent v2 browser run sink has no active run.");
		return activeRunId;
	};

	const ensurePresentation = (phase: AgentV2Phase, status: AgentV2RunStatus, at: string): string => {
		const runId = requireActiveRunId();
		if (!presentationStore.runs.has(runId)) {
			publish({ type: "begin", runId, phase, status, at: startedAt ?? at });
		}
		return runId;
	};

	const narrate = (runId: string, event: AgentV2RunTransportEvent): void => {
		const projection = projectAgentV2Narration(narrationState, { runId, locale: options.locale(), event });
		narrationState = projection.state;
		if (!projection.candidate) return;
		appendAssistantMessageOnce(
			options.browserAgent.state,
			narrationCandidateToAssistantMessage(projection.candidate),
		);
	};

	const projectEvent = (action: AgentV2RunPresentationAction, event: AgentV2BrowserProjectedEvent): void => {
		const runId = requireActiveRunId();
		publish(action);
		if (event.type === "agent_v2.output_recorded") narrate(runId, event);
		options.onEventProjected?.(runId, event);
	};

	return {
		beginRun(runId, at) {
			if (activeRunId) throw new Error(`Agent v2 browser run ${activeRunId} is already active in the sink.`);
			activeRunId = runId;
			startedAt = at;
			presentationStore = createAgentV2RunPresentationStore();
			narrationState = createAgentV2NarrationState();
			const state = options.browserAgent.state;
			state.isStreaming = true;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = undefined;
		},
		setPhase(phase, status, at) {
			const hadPresentation = activeRunId ? presentationStore.runs.has(activeRunId) : false;
			const runId = ensurePresentation(phase, status, at);
			publish({ type: "phase", runId, phase, status, at });
			if (hadPresentation) narrate(runId, { type: "agent_v2.phase_changed", phase, status, at });
			options.onPhaseProjected?.(runId, phase, status, at);
		},
		setTask(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "task", runId, event }, event);
		},
		setArtifact(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "artifact", runId, event }, event);
		},
		setValidation(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "validation", runId, event }, event);
		},
		appendOutput(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "output", runId, event }, event);
		},
		appendDiagnostic(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "diagnostic", runId, event }, event);
		},
		setSkill(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "skill", runId, event }, event);
		},
		setSkillResource(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "resource", runId, event }, event);
		},
		setDeliveryReport(event) {
			const runId = requireActiveRunId();
			projectEvent({ type: "delivery", runId, event }, event);
		},
		settle(status, at, error) {
			const runId = requireActiveRunId();
			if (!TERMINAL_STATUSES.has(status)) throw new Error(`Agent v2 browser run status ${status} is not terminal.`);
			const run = presentationStore.runs.get(runId);
			if (!run) throw new Error(`Agent v2 run ${runId} presentation is unavailable.`);
			const resolvedError = resolveTerminalError(status, error, run);
			presentationStore = reduceAgentV2RunPresentation(presentationStore, {
				type: "settle",
				runId,
				status: status as TerminalAgentV2RunStatus,
				at,
				...(resolvedError ? { error: resolvedError } : {}),
			});
			const terminal = serializeAgentV2TerminalRunPresentation(presentationStore, runId);
			const state = options.browserAgent.state;
			state.messages = appendOrReplaceAgentV2RunResultMessage(
				state.messages,
				createAgentV2RunResultMessage(terminal),
			);
			state.isStreaming = false;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = resolvedError?.message;
			activeRunId = undefined;
			startedAt = undefined;
			options.onPresentationChange(undefined);
		},
	};
}

function appendAssistantMessageOnce(
	state: AgentV2BrowserAgentState,
	message: Extract<AgentMessage, { role: "assistant" }>,
): void {
	const text =
		message.content.length === 1 && message.content[0]?.type === "text" ? message.content[0].text : undefined;
	const duplicate = state.messages.some((candidate) => {
		if (candidate.role !== "assistant" || candidate.content.length !== 1 || candidate.content[0]?.type !== "text") {
			return false;
		}
		return (
			candidate.api === message.api &&
			candidate.provider === message.provider &&
			candidate.model === message.model &&
			candidate.timestamp === message.timestamp &&
			candidate.content[0].text === text
		);
	});
	if (!duplicate) state.messages = [...state.messages, message];
}

function resolveTerminalError(
	status: AgentV2RunStatus,
	error: AgentV2Error | undefined,
	presentation: AgentV2RunPresentation,
): AgentV2Error | undefined {
	if (error?.message.trim()) return error;
	if (status !== "failed" && status !== "interrupted") return undefined;
	const diagnostic = Array.from(presentation.diagnostics.values()).at(-1);
	if (!diagnostic) return undefined;
	return { code: diagnostic.code, message: diagnostic.message, retryable: false };
}
