import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Agent,
} from "../../../../packages/agent/src/agent.js";
import type { AgentEvent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "../../../../packages/agent/src/types.js";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import {
	createServerDirectProjectTools,
	createServerDirectSkillTools,
	type JsonObject,
	loadStorageConfig,
	type RedisRunEventBusOptions,
	type RunEventSinkOptions,
	type RuntimeMessageRecord,
	type SkillSummary,
	type StorageConfig,
	type WorkerAgent,
	type WorkerAgentEvent,
	type WorkerAgentInput,
	WorkspaceDiagnosticLogService,
	WorkspaceSkillService,
} from "../../../../packages/web-workspace/src/index.js";
import type { DiagnosticClient, DiagnosticEvent } from "../diagnostics/diagnostic-client.js";
import { createLoggedStreamFn } from "../diagnostics/model-stream-logger.js";
import {
	type ProjectContextCompactionSummary,
	resolveProjectContextProviderPayloadBudget,
} from "../project-tools/context-manifest.js";
import { buildCodingSystemPrompt } from "../prompts/coding-system-prompt.js";
import { convertAgentMessagesToLlm } from "../runtime/agent-message-conversion.js";
import { capabilityPlanDiagnosticData, planCapabilities } from "../runtime/capability-planner.js";
import {
	type ContextOrchestratorDecision,
	contextDecisionDiagnosticData,
	prepareContextPacket,
} from "../runtime/context-orchestrator.js";
import { STATIC_PREVIEW_CONTRACT } from "../runtime/platform-contract.js";
import { runtimeMessageToAgentMessage } from "../runtime/runtime-message-conversion.js";
import {
	buildSpecArtifact,
	buildSpecExecutionContract,
	completedSpecExecutionReadsFromMessages,
	parseSpecArtifactProjectFiles,
	SPEC_ARTIFACT_PROJECT_FILES,
	type SpecArtifact,
	specArtifactDiagnosticData,
} from "../runtime/spec-artifact.js";
import { expandSkillCommandsInMessages, getLatestRequiredSkillNames } from "../skill-tools/skill-command.js";
import { readServerProviderApiKey } from "./provider-keys.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

export function createWorkerRunEventOptions(config: StorageConfig): {
	bus: RedisRunEventBusOptions;
	sink: Pick<RunEventSinkOptions, "checkpointIntervalMs" | "checkpointMinChars">;
} {
	return {
		bus: {
			redisUrl: config.redisUrl,
			maxLen: config.runEventStreamMaxLen,
			ttlSeconds: config.runEventStreamTtlSeconds,
		},
		sink: {
			checkpointIntervalMs: config.runEventCheckpointIntervalMs,
			checkpointMinChars: config.runEventCheckpointMinChars,
		},
	};
}

type CreateRunAgentOptions = {
	config: ReturnType<typeof loadStorageConfig>;
	diagnostics: WorkspaceDiagnosticLogService;
	skills: Pick<WorkspaceSkillService, "load">;
	promptSkills: SkillSummary[];
	defaultSkills: SkillSummary[];
	streamFn?: StreamFn;
};

export function createRunAgent(input: WorkerAgentInput, options: CreateRunAgentOptions): WorkerAgent {
	const messages = toInitialAgentMessages(input.messages);
	const runMessages = toAgentMessages(input.messages);
	const defaultSkillNames = options.defaultSkills.map((skill) => skill.name);
	const activeSkillNames = getLatestRequiredSkillNames(runMessages, defaultSkillNames);
	const diagnosticClient = createWorkerDiagnosticClient(options.diagnostics, input.run.clientId);
	const capabilityPlan = planCapabilities({
		messages: runMessages,
		platform: STATIC_PREVIEW_CONTRACT,
		source: "worker",
	});
	const inferredSpecArtifact = buildSpecArtifact({
		messages: runMessages,
		capabilityPlan,
		platform: STATIC_PREVIEW_CONTRACT,
	});
	const specArtifact = loadSeededSpecArtifact(input, inferredSpecArtifact);
	const specExecutionContract = buildSpecExecutionContract(specArtifact);
	const completedSpecReads = completedSpecExecutionReadsFromMessages(runMessages, specExecutionContract);
	const tools = [
		...createServerDirectSkillTools(options.config, options.diagnostics),
		...createServerDirectProjectTools(
			options.config,
			{
				clientId: input.run.clientId,
				sessionId: input.session.sessionId,
				title: input.session.title,
				activeSkillNames,
			},
			options.diagnostics,
			{ specExecution: { ...specExecutionContract, completedReads: completedSpecReads } },
		),
	] as AgentTool[];
	writeWorkerCapabilityPlanDiagnostic(diagnosticClient, input.session.sessionId, capabilityPlan);
	writeWorkerSpecArtifactDiagnostic(diagnosticClient, input.session.sessionId, specArtifact);

	const agent = new Agent({
		initialState: {
			systemPrompt: buildCodingSystemPrompt(options.promptSkills, {
				platformContract: STATIC_PREVIEW_CONTRACT,
				capabilityPlan,
				specArtifact,
			}),
			model: input.model as unknown as Model<any>,
			thinkingLevel: normalizeThinkingLevel(input.thinkingLevel),
			messages,
			tools,
		},
		sessionId: input.session.sessionId,
		getApiKey: async (provider) => readServerProviderApiKey(options.config, provider, input.run.clientId),
		repairToolCalls: true,
		convertToLlm: convertAgentMessagesToLlm,
		streamFn: createLoggedStreamFn(
			options.streamFn ?? streamSimple,
			diagnosticClient,
			() => ({
				sessionId: input.session.sessionId,
				traceId: input.session.sessionId,
			}),
			() => ({
				rawProviderLoggingEnabled: options.config.rawProviderLoggingEnabled,
				rawProviderLogMaxChars: options.config.rawProviderLogMaxChars,
				promptSnapshotLoggingEnabled: options.config.promptSnapshotLoggingEnabled,
				promptSnapshotMaxChars: options.config.promptSnapshotMaxChars,
				modelOutputSnapshotLoggingEnabled: options.config.modelOutputSnapshotLoggingEnabled,
				modelOutputSnapshotMaxChars: options.config.modelOutputSnapshotMaxChars,
				streamIdleTimeoutMs: options.config.modelStreamIdleTimeoutMs,
				maxOutputTokens: options.config.modelMaxOutputTokens,
			}),
		),
		transformContext: async (contextMessages, signal) => {
			const providerBudget = resolveProjectContextProviderPayloadBudget({
				model: agent.state.model,
				thinkingLevel: agent.state.thinkingLevel,
				systemPrompt: agent.state.systemPrompt,
				tools: agent.state.tools,
				providerPayloadBudgetChars: options.config.contextProviderPayloadBudgetChars,
			});
			const result = await prepareContextPacket(
				await expandSkillCommandsInMessages(contextMessages as unknown as import("@mariozechner/pi-agent-core").AgentMessage[], {
					defaultSkillNames,
					loadSkill: async (name) => options.skills.load({ name }),
					signal,
				}),
				{
					capabilityPlan,
					specArtifact,
					providerPayloadBudgetChars: providerBudget.providerPayloadBudgetChars,
					providerPayloadFixedOverheadChars: providerBudget.providerPayloadFixedOverheadChars,
					onCompaction: (summary) =>
						writeWorkerContextCompactionDiagnostic(diagnosticClient, input.session.sessionId, summary),
					onDecision: (decision) =>
						writeWorkerContextPacketDiagnostic(diagnosticClient, input.session.sessionId, decision),
				},
			);
			return result.messages as unknown as AgentMessage[];
		},
	});
	agent.subscribe((event) => writeWorkerAgentEventDiagnostic(diagnosticClient, input.session.sessionId, event));

	return new RuntimeAgentAdapter(agent);
}

function loadSeededSpecArtifact(input: WorkerAgentInput, fallback: SpecArtifact): SpecArtifact {
	const projectDir = input.projectContext?.projectDir;
	if (!projectDir) return fallback;
	const files = SPEC_ARTIFACT_PROJECT_FILES.flatMap((filename) => {
		const path = join(projectDir, ...filename.split("/"));
		if (!existsSync(path)) return [];
		try {
			return [{ filename, content: readFileSync(path, "utf8") }];
		} catch {
			return [];
		}
	});
	return parseSpecArtifactProjectFiles(files, fallback);
}

function writeWorkerCapabilityPlanDiagnostic(
	client: DiagnosticClient,
	sessionId: string,
	capabilityPlan: ReturnType<typeof planCapabilities>,
): void {
	client.write({
		level: "info",
		category: "model",
		eventType: "model.capability_plan",
		sessionId,
		traceId: sessionId,
		data: capabilityPlanDiagnosticData(capabilityPlan),
	});
}

function writeWorkerSpecArtifactDiagnostic(
	client: DiagnosticClient,
	sessionId: string,
	specArtifact: SpecArtifact,
): void {
	client.write({
		level: "info",
		category: "model",
		eventType: "model.spec_artifact",
		sessionId,
		traceId: sessionId,
		data: specArtifactDiagnosticData(specArtifact),
	});
}

function writeWorkerContextPacketDiagnostic(
	client: DiagnosticClient,
	sessionId: string,
	decision: ContextOrchestratorDecision,
): void {
	client.write({
		level: "info",
		category: "model",
		eventType: "model.context_packet",
		sessionId,
		traceId: sessionId,
		data: contextDecisionDiagnosticData(decision),
	});
}

function writeWorkerContextCompactionDiagnostic(
	client: DiagnosticClient,
	sessionId: string,
	summary: ProjectContextCompactionSummary,
): void {
	client.write({
		level: "info",
		category: "model",
		eventType: "model.context_compaction",
		sessionId,
		traceId: sessionId,
		data: { ...summary },
	});
}

function writeWorkerAgentEventDiagnostic(client: DiagnosticClient, sessionId: string, event: AgentEvent): void {
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return;
	client.write({
		level: event.type === "tool_execution_end" && event.isError ? "error" : "info",
		category: "tool",
		eventType: `agent.${event.type}`,
		sessionId,
		traceId: sessionId,
		data: workerToolEventDiagnosticData(event),
	});
}

function workerToolEventDiagnosticData(
	event: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_end" }>,
): Record<string, unknown> {
	if (event.type === "tool_execution_start") {
		return {
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			args: event.args,
			argsSummary: summarizeUnknown(event.args),
		};
	}
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		isError: event.isError,
		result: event.result,
		resultSummary: summarizeUnknown(event.result),
	};
}

function summarizeUnknown(value: unknown): string {
	if (typeof value === "string") return `string:${value.length}`;
	if (Array.isArray(value)) return `array:${value.length}`;
	if (isPlainObject(value)) return `object:${Object.keys(value).length}`;
	if (value === undefined || value === null) return "empty";
	return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createWorkerDiagnosticClient(
	diagnostics: Pick<WorkspaceDiagnosticLogService, "writeEvents">,
	clientId: string,
): DiagnosticClient {
	return {
		write(event) {
			this.writeMany([event]);
		},
		writeMany(events: DiagnosticEvent[]) {
			if (events.length === 0) return;
			try {
				diagnostics.writeEvents({
					events: events.map((event) => ({ ...event, clientId })),
				});
			} catch {
				// Diagnostics must not interrupt worker run processing.
			}
		},
		async flush() {},
	};
}

class RuntimeAgentAdapter implements WorkerAgent {
	constructor(private readonly agent: Agent) {}

	subscribe(listener: (event: WorkerAgentEvent) => void): () => void {
		return this.agent.subscribe((event) => {
			listener(toWorkerAgentEvent(event));
		});
	}

	async prompt(message: RuntimeMessageRecord | RuntimeMessageRecord[]): Promise<void> {
		await this.agent.prompt(toAgentMessages(Array.isArray(message) ? message : [message]));
	}

	async continue(): Promise<void> {
		await this.agent.continue();
	}

	abort(): void {
		this.agent.abort();
	}

	async waitForIdle(): Promise<void> {
		await this.agent.waitForIdle();
	}
}

function toInitialAgentMessages(messages: RuntimeMessageRecord[]): AgentMessage[] {
	const tail = messages.at(-1);
	const initialMessages = tail && isUserPromptRole(tail.role) ? messages.slice(0, -1) : messages;
	return toAgentMessages(initialMessages);
}

function toAgentMessages(messages: RuntimeMessageRecord[]): AgentMessage[] {
	return messages.map(runtimeMessageToAgentMessage) as unknown as AgentMessage[];
}

function isUserPromptRole(role: string): boolean {
	return role === "user" || role === "user-with-attachments";
}

function toWorkerAgentEvent(event: AgentEvent): WorkerAgentEvent {
	return event as unknown as WorkerAgentEvent;
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
	return THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : "high";
}
