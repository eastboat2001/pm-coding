import { existsSync } from "node:fs";
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
	createServerDirectProjectTools,
	createServerDirectSkillTools,
	type DiagnosticLogEventInput,
	type JsonObject,
	loadStorageConfig,
	PreviewReadinessChecker,
	RedisRunEventBus,
	type RedisRunEventBusOptions,
	RedisRunQueue,
	RunEventSink,
	type RunEventSinkOptions,
	createRuntimeStore,
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
} from "@mariozechner/pi-web-workspace";
import type { DiagnosticClient, DiagnosticEvent } from "../diagnostics/diagnostic-client.js";
import { createLoggedStreamFn } from "../diagnostics/model-stream-logger.js";
import { compactProjectToolHistory } from "../project-tools/history.js";
import { buildCodingSystemPrompt } from "../prompts/coding-system-prompt.js";
import { convertAgentMessagesToLlm } from "../runtime/agent-message-conversion.js";
import { runtimeMessageToAgentMessage } from "../runtime/runtime-message-conversion.js";
import { expandSkillCommandsInMessages, getLatestRequiredSkillNames } from "../skill-tools/skill-command.js";
import { readServerProviderApiKey } from "./provider-keys.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
type WorkerProcessDiagnosticLevel = "info" | "warn" | "error";

async function main(): Promise<void> {
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
					runQueueName: config.runQueueName,
				},
			},
		],
	});

	let runtimeDb: RuntimeStore | undefined;
	let runEventBus: RedisRunEventBus | undefined;
	try {
		runtimeDb = createRuntimeStore(config);
		await runtimeDb.ensureSchema();

		const queue = new RedisRunQueue({ redisUrl: config.redisUrl, queueName: config.runQueueName });
		const runEventOptions = createWorkerRunEventOptions(config);
		runEventBus = new RedisRunEventBus(runEventOptions.bus);
		const runEventSink = new RunEventSink({ store: runtimeDb, bus: runEventBus, ...runEventOptions.sink });
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
			diagnostics,
			goalSupervisor: appPreviewGoalSupervisor,
			runEventSink,
			createAgent(input) {
				return createRunAgent(input, {
					config,
					diagnostics,
					skills,
					promptSkills: skillList.promptSkills,
					defaultSkills: skillList.defaultSkills,
				});
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
				clientIdRequired: config.clientIdRequired,
				loggingEnabled: config.loggingEnabled,
				logStdoutEnabled: config.logStdoutEnabled,
				logsDbFile: config.logsDbFile,
				modelStreamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
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
	const messages = toInitialAgentMessages(input.messages);
	const defaultSkillNames = options.defaultSkills.map((skill) => skill.name);
	const activeSkillNames = getLatestRequiredSkillNames(toAgentMessages(input.messages), defaultSkillNames);
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
		),
	] as AgentTool[];

	const agent = new Agent({
		initialState: {
			systemPrompt: buildCodingSystemPrompt(options.promptSkills),
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
			createWorkerDiagnosticClient(options.diagnostics, input.run.clientId),
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
			}),
		),
		transformContext: async (contextMessages, signal) =>
			compactProjectToolHistory(
				await expandSkillCommandsInMessages(contextMessages, {
					defaultSkillNames,
					loadSkill: async (name) => options.skills.load({ name }),
					signal,
				}),
			),
	});

	return new RuntimeAgentAdapter(agent);
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
				diagnostics.writeEvents({ events: events.map((event) => ({ ...event, clientId })) });
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
	void main().catch((error) => {
		console.error(error instanceof Error ? error.stack || error.message : error);
		process.exitCode = 1;
	});
}

function isDirectWorkerEntry(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return import.meta.url === pathToFileURL(entry).href;
}
