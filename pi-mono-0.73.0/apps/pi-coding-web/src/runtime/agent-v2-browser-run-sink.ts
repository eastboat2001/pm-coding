import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AgentV2Error,
	AgentV2Phase,
	AgentV2ResponseLanguage,
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
	responseLanguage: AgentV2ResponseLanguage;
	onPresentationChange: (presentation: AgentV2RunPresentation | undefined) => void;
	onNarrationChange?: () => void;
	narrationTypingIntervalMs?: number;
	onPhaseProjected?: (runId: string, phase: AgentV2Phase, status: AgentV2RunStatus, at: string) => void;
	onEventProjected?: (runId: string, event: AgentV2BrowserProjectedEvent) => void;
}

const TERMINAL_STATUSES = new Set<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"]);
type NarrationMessage = Extract<AgentMessage, { role: "assistant" }>;

export function createAgentV2BrowserRunSink(options: AgentV2BrowserRunSinkOptions): AgentV2BrowserRunSink {
	let activeRunId: string | undefined;
	let startedAt: string | undefined;
	let objective: string | undefined;
	let presentationStore = createAgentV2RunPresentationStore();
	let narrationState = createAgentV2NarrationState();
	let narrationTimer: ReturnType<typeof setTimeout> | undefined;
	let activeNarration: { message: NarrationMessage; length: number } | undefined;
	let narrationQueue: NarrationMessage[] = [];
	const narrationTypingIntervalMs = Math.max(0, options.narrationTypingIntervalMs ?? 0);

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

	const notifyNarrationChange = (): void => {
		options.onNarrationChange?.();
	};

	const clearNarrationTimer = (): void => {
		if (narrationTimer !== undefined) clearTimeout(narrationTimer);
		narrationTimer = undefined;
	};

	const finishPendingNarration = (): void => {
		clearNarrationTimer();
		const state = options.browserAgent.state;
		if (activeNarration) appendAssistantMessageOnce(state, activeNarration.message);
		for (const message of narrationQueue) appendAssistantMessageOnce(state, message);
		activeNarration = undefined;
		narrationQueue = [];
		state.streamingMessage = undefined;
		notifyNarrationChange();
	};

	const typeNextNarrationFrame = (): void => {
		narrationTimer = undefined;
		if (!activeRunId) return;
		if (!activeNarration) {
			const message = narrationQueue.shift();
			if (!message) return;
			activeNarration = { message, length: 0 };
		}
		const current = activeNarration;
		const text = assistantMessageText(current.message);
		current.length = Math.min(text.length, current.length + 1);
		options.browserAgent.state.streamingMessage = withAssistantText(current.message, text.slice(0, current.length));
		notifyNarrationChange();
		if (current.length >= text.length) {
			appendAssistantMessageOnce(options.browserAgent.state, current.message);
			activeNarration = undefined;
			options.browserAgent.state.streamingMessage = undefined;
			notifyNarrationChange();
			if (narrationQueue.length > 0) narrationTimer = setTimeout(typeNextNarrationFrame, narrationTypingIntervalMs);
			return;
		}
		narrationTimer = setTimeout(typeNextNarrationFrame, narrationTypingIntervalMs);
	};

	const enqueueNarration = (message: NarrationMessage): void => {
		if (hasAssistantMessage(options.browserAgent.state.messages, message)) return;
		if (narrationTypingIntervalMs === 0) {
			appendAssistantMessageOnce(options.browserAgent.state, message);
			notifyNarrationChange();
			return;
		}
		narrationQueue.push(message);
		if (!activeNarration && narrationTimer === undefined) typeNextNarrationFrame();
	};

	const narrate = (runId: string, event: AgentV2RunTransportEvent, artifactPaths: readonly string[] = []): void => {
		const projection = projectAgentV2Narration(narrationState, {
			runId,
			locale: options.responseLanguage,
			event,
			...(objective ? { objective } : {}),
			artifactPaths,
		});
		narrationState = projection.state;
		if (!projection.candidate) return;
		enqueueNarration(narrationCandidateToAssistantMessage(projection.candidate));
	};

	const projectEvent = (action: AgentV2RunPresentationAction, event: AgentV2BrowserProjectedEvent): void => {
		const runId = requireActiveRunId();
		const presentation = publish(action);
		if (event.type === "agent_v2.output_recorded") {
			narrate(
				runId,
				event,
				Array.from(presentation.artifacts.values(), (artifact) => artifact.path),
			);
		} else if (event.type === "agent_v2.validation_recorded") {
			narrate(runId, event);
		}
		options.onEventProjected?.(runId, event);
	};

	return {
		beginRun(runId, at, runObjective) {
			if (activeRunId) throw new Error(`Agent v2 browser run ${activeRunId} is already active in the sink.`);
			finishPendingNarration();
			activeRunId = runId;
			startedAt = at;
			objective = runObjective?.trim() || undefined;
			presentationStore = createAgentV2RunPresentationStore();
			narrationState = createAgentV2NarrationState();
			const state = options.browserAgent.state;
			state.isStreaming = true;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = undefined;
			narrate(runId, { type: "agent_v2.phase_changed", phase: "intake", status: "running", at });
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
			finishPendingNarration();
			state.messages = appendOrReplaceAgentV2RunResultMessage(
				state.messages,
				createAgentV2RunResultMessage(terminal, options.responseLanguage),
			);
			state.isStreaming = false;
			state.streamingMessage = undefined;
			state.pendingToolCalls = new Set<string>();
			state.errorMessage = resolvedError?.message;
			activeRunId = undefined;
			startedAt = undefined;
			objective = undefined;
			options.onPresentationChange(undefined);
		},
	};
}

function appendAssistantMessageOnce(state: AgentV2BrowserAgentState, message: NarrationMessage): void {
	if (!hasAssistantMessage(state.messages, message)) state.messages = [...state.messages, message];
}

function hasAssistantMessage(messages: readonly AgentMessage[], message: NarrationMessage): boolean {
	const text = assistantMessageText(message);
	return messages.some((candidate) => {
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
}

function assistantMessageText(message: NarrationMessage): string {
	const content = message.content[0];
	return content?.type === "text" ? content.text : "";
}

function withAssistantText(message: NarrationMessage, text: string): NarrationMessage {
	return { ...message, content: [{ type: "text", text }] };
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
