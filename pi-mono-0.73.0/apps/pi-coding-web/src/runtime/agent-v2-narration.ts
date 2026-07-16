import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	AgentV2OutputRecordedTransportEvent,
	AgentV2Phase,
	AgentV2RunTransportEvent,
} from "@mariozechner/pi-web-workspace";
import { type AgentV2UserStage, agentV2StageForPhase } from "./agent-v2-run-presentation.js";

type AgentV2ModelUsageSummary = NonNullable<AgentV2OutputRecordedTransportEvent["usage"]>;

export interface AgentV2NarrationState {
	seenSemanticKeys: ReadonlySet<string>;
	lastText?: string;
}

interface AgentV2NarrationCandidateBase {
	semanticKey: string;
	text: string;
	at: string;
	alreadyNarrated: boolean;
}

export interface AgentV2PhaseNarrationCandidate extends AgentV2NarrationCandidateBase {
	source: "phase";
	stage: AgentV2UserStage;
	phase: AgentV2Phase;
}

export interface AgentV2OutputNarrationCandidate extends AgentV2NarrationCandidateBase {
	source: "output";
	taskId: string;
	provider: string;
	model: string;
	usage?: AgentV2ModelUsageSummary;
}

export type AgentV2NarrationCandidate = AgentV2PhaseNarrationCandidate | AgentV2OutputNarrationCandidate;

export interface AgentV2NarrationProjection {
	state: AgentV2NarrationState;
	candidate?: AgentV2NarrationCandidate;
}

type SupportedNarrationLocale = "zh" | "en" | "de" | "ms";

const STAGE_COPY: Record<SupportedNarrationLocale, Record<AgentV2UserStage, string>> = {
	zh: {
		understanding: "正在理解你的需求。",
		planning: "正在整理方案和实施步骤。",
		implementation: "正在实现方案。",
		validation: "正在检查结果并修复问题。",
		delivery: "正在整理交付结果。",
	},
	en: {
		understanding: "I’m understanding what you need.",
		planning: "I’m organizing the plan and implementation steps.",
		implementation: "I’m implementing the plan.",
		validation: "I’m checking the result and fixing issues.",
		delivery: "I’m preparing the result for delivery.",
	},
	de: {
		understanding: "Ich erfasse, was Sie benötigen.",
		planning: "Ich strukturiere den Plan und die Umsetzungsschritte.",
		implementation: "Ich setze den Plan um.",
		validation: "Ich prüfe das Ergebnis und behebe Probleme.",
		delivery: "Ich bereite das Ergebnis für die Übergabe vor.",
	},
	ms: {
		understanding: "Saya sedang memahami keperluan anda.",
		planning: "Saya sedang menyusun pelan dan langkah pelaksanaan.",
		implementation: "Saya sedang melaksanakan pelan.",
		validation: "Saya sedang menyemak hasil dan membaiki masalah.",
		delivery: "Saya sedang menyediakan hasil untuk diserahkan.",
	},
};

const REPAIR_COPY: Record<SupportedNarrationLocale, string> = {
	zh: "检查发现问题，正在自动修复。",
	en: "I found a validation issue and I’m repairing it.",
	de: "Ich habe ein Validierungsproblem gefunden und behebe es.",
	ms: "Saya menemui isu pengesahan dan sedang membaikinya.",
};

export function createAgentV2NarrationState(): AgentV2NarrationState {
	return { seenSemanticKeys: new Set() };
}

export function projectAgentV2Narration(
	state: AgentV2NarrationState,
	input: { runId: string; locale: string; event: AgentV2RunTransportEvent },
): AgentV2NarrationProjection {
	const candidate = narrationCandidate(input.runId, input.locale, input.event);
	if (!candidate) return { state };

	const seenSemanticKeys = new Set(state.seenSemanticKeys);
	if (seenSemanticKeys.has(candidate.semanticKey)) return { state };
	seenSemanticKeys.add(candidate.semanticKey);
	const nextState: AgentV2NarrationState = {
		seenSemanticKeys,
		...(state.lastText ? { lastText: state.lastText } : {}),
	};
	if (candidate.text === state.lastText) return { state: nextState };

	return { state: { seenSemanticKeys, lastText: candidate.text }, candidate };
}

export function markAgentV2NarrationCandidateNarrated(candidate: AgentV2NarrationCandidate): AgentV2NarrationCandidate {
	return { ...candidate, alreadyNarrated: true };
}

export function narrationCandidateToAssistantMessage(candidate: AgentV2NarrationCandidate): AssistantMessage {
	const usage = candidate.source === "output" ? candidate.usage : undefined;
	return {
		role: "assistant",
		content: [{ type: "text", text: candidate.text }],
		api: "agent-v2",
		provider: candidate.source === "output" ? candidate.provider : "agent-v2",
		model: candidate.source === "output" ? candidate.model : "event",
		usage: {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage?.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.costTotal ?? 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(candidate.at),
	};
}

function narrationCandidate(
	runId: string,
	locale: string,
	event: AgentV2RunTransportEvent,
): AgentV2NarrationCandidate | undefined {
	if (event.type === "agent_v2.output_recorded") return outputCandidate(runId, event);
	if (
		event.type !== "agent_v2.run_created" &&
		event.type !== "agent_v2.planning_ready" &&
		event.type !== "agent_v2.phase_changed"
	) {
		return undefined;
	}
	const stage = agentV2StageForPhase(event.phase);
	const normalizedLocale = normalizeLocale(locale);
	return {
		source: "phase",
		semanticKey: `phase\u0000${runId}\u0000${event.phase}\u0000${event.at}`,
		text: event.phase === "repair" ? REPAIR_COPY[normalizedLocale] : STAGE_COPY[normalizedLocale][stage],
		at: event.at,
		stage,
		phase: event.phase,
		alreadyNarrated: false,
	};
}

function outputCandidate(runId: string, event: AgentV2OutputRecordedTransportEvent): AgentV2OutputNarrationCandidate {
	return {
		source: "output",
		semanticKey: `output\u0000${runId}\u0000${event.taskId}\u0000${event.provider}\u0000${event.model}\u0000${event.at}\u0000${event.summary}`,
		text: event.summary,
		at: event.at,
		taskId: event.taskId,
		provider: event.provider,
		model: event.model,
		...(event.usage ? { usage: event.usage } : {}),
		alreadyNarrated: false,
	};
}

function normalizeLocale(locale: string): SupportedNarrationLocale {
	const language = locale.trim().toLowerCase().split(/[-_]/u)[0];
	return language === "zh" || language === "de" || language === "ms" ? language : "en";
}
