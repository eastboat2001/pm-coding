import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type StreamFn,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import { type Model, streamSimple } from "@mariozechner/pi-ai";
import {
	AppPreviewGoalService,
	AppPreviewGoalSupervisor,
	createRuntimeStore,
	createServerDirectProjectTools,
	createServerDirectSkillTools,
	type DiagnosticLogEventInput,
	type JsonObject,
	loadStorageConfig,
	PreviewReadinessChecker,
	RedisRunEventBus,
	type RedisRunEventBusOptions,
	RedisRunQueue,
	RetryPolicy,
	RunEventSink,
	type RunEventSinkOptions,
	type RuntimeMessageRecord,
	type RuntimeStore,
	type SkillSummary,
	type StorageConfig,
	type WorkerAgent,
	type WorkerAgentEvent,
	type WorkerAgentInput,
	WorkspaceDiagnosticLogService,
	WorkspaceRunWorkerService,
	WorkspaceSkillService,
	workspaceContext,
} from "@mariozechner/pi-web-workspace";
import { selectApplicationGenerationRuntime } from "../agent-v2/runtime-entry.js";
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
type WorkerProcessDiagnosticLevel = "info" | "warn" | "error";

export async function ensureRuntimeSchemas(
	runtimeDb: Pick<RuntimeStore, "ensureSchema" | "ensureAgentV2Schema">,
): Promise<void> {
	await runtimeDb.ensureSchema();
	await runtimeDb.ensureAgentV2Schema();
}

export async function runLegacyV1Worker(): Promise<void> {
	const config = loadStorageConfig(process.cwd());
	const diagnostics = new WorkspaceDiagnosticLogService(config);
	diagnostics.ensureDirs();
	const removeFatalDiagnostics = installWorkerFatalDiagnostics(config, diagnostics);
	const removeProcessLifecycleDiagnostics = installWorkerProcessLifecycleDiagnostics(config, diagnostics);
	diagnostics.writeEvents({
		events: [
			...createWorkerStartupDiagnosticEvents(config),
			{
				level: "info",
				category: "system",
				eventType: "system.worker.starting",
				data: {
					workerId: config.workerId,
					workerConcurrency: config.workerConcurrency,
					runMaxAgentTurns: config.runMaxAgentTurns,
					runMaxAgentToolExecutions: config.runMaxAgentToolExecutions,
					runRetryMaxAttempts: config.runRetryMaxAttempts,
					runRetryBaseDelayMs: config.runRetryBaseDelayMs,
					runRetryMaxDelayMs: config.runRetryMaxDelayMs,
					runRetryJitterRatio: config.runRetryJitterRatio,
					runQueueName: config.runQueueName,
				},
			},
		],
	});

	let runtimeDb: RuntimeStore | undefined;
	let runEventBus: RedisRunEventBus | undefined;
	try {
		runtimeDb = createRuntimeStore(config);
		await ensureRuntimeSchemas(runtimeDb);

		const queue = new RedisRunQueue({
			redisUrl: config.redisUrl,
			queueName: config.runQueueName,
		});
		const runEventOptions = createWorkerRunEventOptions(config);
		runEventBus = new RedisRunEventBus(runEventOptions.bus);
		const runEventSink = new RunEventSink({
			store: runtimeDb,
			bus: runEventBus,
			...runEventOptions.sink,
		});
		const appPreviewGoals = new AppPreviewGoalService(runtimeDb);
		const previewReadiness = new PreviewReadinessChecker(config);
		const appPreviewGoalSupervisor = new AppPreviewGoalSupervisor({
			db: runtimeDb,
			queue,
			goals: appPreviewGoals,
			readiness: previewReadiness,
		});
		const skills = new WorkspaceSkillService(config, diagnostics);
		const skillList = skills.list();

		const worker = new WorkspaceRunWorkerService({
			db: runtimeDb,
			queue,
			workerId: config.workerId,
			concurrency: config.workerConcurrency,
			maxAgentTurns: config.runMaxAgentTurns,
			maxAgentToolExecutions: config.runMaxAgentToolExecutions,
			retry: {
				policy: new RetryPolicy({
					maxAttempts: config.runRetryMaxAttempts,
					baseDelayMs: config.runRetryBaseDelayMs,
					maxDelayMs: config.runRetryMaxDelayMs,
					jitterRatio: config.runRetryJitterRatio,
				}),
			},
			diagnostics,
			goalSupervisor: appPreviewGoalSupervisor,
			runEventSink,
			createAgent(input) {
				return createRunAgent(
					{
						...input,
						projectContext:
							input.projectContext ??
							workspaceContext(config, {
								clientId: input.run.clientId,
								sessionId: input.session.sessionId,
								title: input.session.title,
							}),
					},
					{
						config,
						diagnostics,
						skills,
						promptSkills: skillList.promptSkills,
						defaultSkills: skillList.defaultSkills,
					},
				);
			},
		});

		let shuttingDown = false;
		const shutdown = async (signal: NodeJS.Signals): Promise<number> => {
			if (shuttingDown) {
				console.error(`PI worker received ${signal} while shutdown is already in progress; forcing exit.`);
				return 1;
			}
			shuttingDown = true;
			console.log(`PI worker received ${signal}; stopping.`);
			writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.stopping", "info", { signal });
			let exitCode = 0;
			try {
				await worker.stop();
			} catch (error) {
				exitCode = 1;
				logCleanupError("worker.stop", error);
			}
			try {
				await runEventBus?.close();
			} catch (error) {
				exitCode = 1;
				logCleanupError("runEventBus.close", error);
			}
			try {
				await diagnostics.flushLangfuse();
			} catch (error) {
				exitCode = 1;
				logCleanupError("diagnostics.flushLangfuse", error);
			}
			try {
				await runtimeDb?.close();
			} catch (error) {
				exitCode = 1;
				logCleanupError("runtimeDb.close", error);
			}
			writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.stopped", exitCode === 0 ? "info" : "error", {
				signal,
				exitCode,
			});
			removeProcessLifecycleDiagnostics();
			removeFatalDiagnostics();
			return exitCode;
		};

		process.once("SIGINT", () => {
			void shutdown("SIGINT").then((exitCode) => process.exit(exitCode), exitAfterShutdownFailure);
		});
		process.once("SIGTERM", () => {
			void shutdown("SIGTERM").then((exitCode) => process.exit(exitCode), exitAfterShutdownFailure);
		});

		await worker.start();
		console.log(
			`PI worker ${config.workerId} started with concurrency ${config.workerConcurrency} on queue ${config.runQueueName}.`,
		);
	} catch (error) {
		writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.start_failed", "error", {
			...diagnosticErrorData(error),
			hint: "The worker process failed before it could stay online and claim queued runs.",
		});
		try {
			await diagnostics.flushLangfuse();
		} catch (flushError) {
			logCleanupError("diagnostics.flushLangfuse", flushError);
		}
		try {
			await runEventBus?.close();
		} catch (closeError) {
			logCleanupError("runEventBus.close", closeError);
		}
		try {
			await runtimeDb?.close();
		} catch (closeError) {
			logCleanupError("runtimeDb.close", closeError);
		}
		removeProcessLifecycleDiagnostics();
		removeFatalDiagnostics();
		throw error;
	}
}

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

function createWorkerStartupDiagnosticEvents(config: StorageConfig): DiagnosticLogEventInput[] {
	const envFileExists = Boolean(config.envFile && existsSync(config.envFile));
	const events: DiagnosticLogEventInput[] = [
		{
			level: "info",
			category: "system",
			eventType: "system.startup.config",
			data: {
				envFile: config.envFile,
				envFileExists,
				runsEnabled: config.runsEnabled,
				redisUrl: redactConnectionUrl(config.redisUrl),
				runQueueName: config.runQueueName,
				runtimeDbFile: config.runtimeDbFile,
				workerId: config.workerId,
				workerConcurrency: config.workerConcurrency,
				runMaxAgentTurns: config.runMaxAgentTurns,
				runMaxAgentToolExecutions: config.runMaxAgentToolExecutions,
				runRetryMaxAttempts: config.runRetryMaxAttempts,
				runRetryBaseDelayMs: config.runRetryBaseDelayMs,
				runRetryMaxDelayMs: config.runRetryMaxDelayMs,
				runRetryJitterRatio: config.runRetryJitterRatio,
				clientIdRequired: config.clientIdRequired,
				loggingEnabled: config.loggingEnabled,
				logStdoutEnabled: config.logStdoutEnabled,
				logsDbFile: config.logsDbFile,
				modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
				modelMaxOutputTokens: config.modelMaxOutputTokens,
				contextProviderPayloadBudgetChars: config.contextProviderPayloadBudgetChars,
				pid: process.pid,
				ppid: process.ppid,
				nodeVersion: process.version,
			},
		},
	];

	if (config.envFile && !envFileExists) {
		events.push({
			level: "warn",
			category: "system",
			eventType: "system.config.env_missing",
			data: {
				envFile: config.envFile,
				message: "PI configuration file was not found; defaults are in use.",
			},
		});
	}

	return events;
}

function installWorkerFatalDiagnostics(
	config: StorageConfig,
	diagnostics: Pick<WorkspaceDiagnosticLogService, "flushLangfuse" | "writeEvents">,
): () => void {
	let exiting = false;
	const exitAfterFatal = (eventType: string, error: unknown): void => {
		writeWorkerProcessDiagnostic(config, diagnostics, eventType, "error", {
			...diagnosticErrorData(error),
			hint: "The worker process received a fatal Node.js error and will exit.",
		});
		logCleanupError(eventType, error);
		if (exiting) return;
		exiting = true;
		const forcedExit = setTimeout(() => process.exit(1), 1000);
		forcedExit.unref();
		void diagnostics.flushLangfuse().finally(() => process.exit(1));
	};
	const onUncaughtException = (error: Error): void => {
		exitAfterFatal("system.worker.uncaught_exception", error);
	};
	const onUnhandledRejection = (reason: unknown): void => {
		exitAfterFatal("system.worker.unhandled_rejection", reason);
	};
	process.on("uncaughtException", onUncaughtException);
	process.on("unhandledRejection", onUnhandledRejection);
	return () => {
		process.off("uncaughtException", onUncaughtException);
		process.off("unhandledRejection", onUnhandledRejection);
	};
}

function installWorkerProcessLifecycleDiagnostics(
	config: StorageConfig,
	diagnostics: Pick<WorkspaceDiagnosticLogService, "writeEvents">,
): () => void {
	let beforeExitWritten = false;
	const lifecycleData = (code: number): JsonObject => ({
		code,
		pid: process.pid,
		ppid: process.ppid,
		uptimeMs: Math.round(process.uptime() * 1000),
	});
	const onBeforeExit = (code: number): void => {
		beforeExitWritten = true;
		writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.before_exit", "warn", lifecycleData(code));
	};
	const onExit = (code: number): void => {
		writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.exit", code === 0 ? "info" : "error", {
			...lifecycleData(code),
			beforeExitWritten,
		});
	};
	process.on("beforeExit", onBeforeExit);
	process.on("exit", onExit);
	return () => {
		process.off("beforeExit", onBeforeExit);
		process.off("exit", onExit);
	};
}

function writeWorkerProcessDiagnostic(
	config: StorageConfig,
	diagnostics: Pick<WorkspaceDiagnosticLogService, "writeEvents">,
	eventType: string,
	level: WorkerProcessDiagnosticLevel,
	data: JsonObject,
): void {
	diagnostics.writeEvents({
		events: [
			{
				level,
				category: "system",
				eventType,
				data: {
					workerId: config.workerId,
					workerConcurrency: config.workerConcurrency,
					runMaxAgentTurns: config.runMaxAgentTurns,
					runMaxAgentToolExecutions: config.runMaxAgentToolExecutions,
					runRetryMaxAttempts: config.runRetryMaxAttempts,
					runRetryBaseDelayMs: config.runRetryBaseDelayMs,
					runRetryMaxDelayMs: config.runRetryMaxDelayMs,
					runRetryJitterRatio: config.runRetryJitterRatio,
					runQueueName: config.runQueueName,
					...data,
				},
			},
		],
	});
}

function diagnosticErrorData(error: unknown): JsonObject {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack ?? null,
		};
	}
	return {
		message: stringifyDiagnosticValue(error),
	};
}

function stringifyDiagnosticValue(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		if (json) return json;
	} catch {}
	return String(value);
}

function redactConnectionUrl(value: string): string {
	try {
		const url = new URL(value);
		const credentials = url.username || url.password ? "[redacted]@" : "";
		const path = url.pathname === "/" ? "" : url.pathname;
		return `${url.protocol}//${credentials}${url.host}${path}${url.search}${url.hash}`;
	} catch {
		return value;
	}
}

function exitAfterShutdownFailure(error: unknown): never {
	logCleanupError("shutdown", error);
	process.exit(1);
}

function logCleanupError(step: string, error: unknown): void {
	console.error(`PI worker ${step} failed:`, error instanceof Error ? error.stack || error.message : error);
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
	selectApplicationGenerationRuntime({
		requestedVersion: process.env.PI_APP_AGENT_VERSION,
	});
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
				await expandSkillCommandsInMessages(contextMessages, {
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
			return result.messages;
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
	return messages.map(runtimeMessageToAgentMessage);
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

if (isDirectWorkerEntry()) {
	void runLegacyV1Worker().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : error);
		process.exitCode = 1;
	});
}

function isDirectWorkerEntry(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return import.meta.url === pathToFileURL(entry).href;
}
