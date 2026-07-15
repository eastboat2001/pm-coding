import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	type AgentV2InputMaterializer,
	type AgentV2ModelExecution,
	AgentV2OutboxDispatcher,
	AgentV2RunEventLog,
	type AgentV2RunQueue,
	type AgentV2RunSnapshot,
	type AgentV2WorkerExecution,
	type AgentV2WorkerExecutionInput,
	AgentV2WorkerService,
	type AgentV2WorkerStopResult,
	createAgentV2DiagnosticProjectionAdapters,
	DurableAgentV2InputMaterializer,
	executeAgentV2NextTask,
	parseAgentV2RunContext,
	RedisAgentV2RunEventBus,
	type RedisAgentV2RunEventBusOptions,
	runAgentV2ShutdownSteps,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import {
	type AgentV2ProductionStore,
	type AgentV2SchemaStore,
	createAgentV2RuntimeStore,
	createRedisAgentV2RunQueue,
	type DiagnosticLogEventInput,
	type JsonObject,
	loadStorageConfig,
	type StorageConfig,
	WorkspaceDiagnosticLogService,
} from "@mariozechner/pi-web-workspace/runtime-infra";
import { AgentV2PiModelExecution, ConfiguredAgentV2ServerModelRegistry } from "./agent-v2-pi-model-execution.js";
import {
	createGlobalProviderApiKeyResolver,
	type GlobalProviderApiKeySources,
	loadAgentV2ServerSettingsSnapshot,
} from "./global-provider-keys.js";
import { runWorkerShutdownDeadline } from "./shutdown-deadline.js";

type WorkerProcessDiagnosticLevel = "info" | "warn" | "error";

export async function ensureRuntimeSchemas(runtimeDb: AgentV2SchemaStore): Promise<void> {
	await runtimeDb.ensureAgentV2Schema();
}

export function createAgentV2WorkerRunEventOptions(config: StorageConfig): {
	queue: { redisUrl: string; queueName: string };
	bus: RedisAgentV2RunEventBusOptions;
} {
	return {
		queue: {
			redisUrl: config.redisUrl,
			queueName: config.agentV2.queueName,
		},
		bus: {
			redisUrl: config.redisUrl,
			maxLen: config.agentV2.eventStreamMaxLen,
			ttlSeconds: config.agentV2.eventStreamTtlSeconds,
		},
	};
}

export function createAgentV2WorkerExecution(
	config: StorageConfig,
	store: AgentV2ProductionStore,
	dependencies: {
		settingsSources?: GlobalProviderApiKeySources;
		complete?: ConstructorParameters<typeof AgentV2PiModelExecution>[0]["complete"];
	} = {},
): AgentV2WorkerExecution & {
	readonly materializer: AgentV2InputMaterializer;
	readonly modelExecution: AgentV2ModelExecution;
} {
	// Settings are intentionally a restart-scoped snapshot: endpoint, capabilities and credentials
	// must never be paired across two file versions while concurrent tasks are executing.
	const settingsSnapshot = loadAgentV2ServerSettingsSnapshot(config, dependencies.settingsSources);
	const modelExecution = new AgentV2PiModelExecution({
		modelRegistry: new ConfiguredAgentV2ServerModelRegistry(settingsSnapshot),
		resolveApiKey: createGlobalProviderApiKeyResolver(settingsSnapshot),
		complete: dependencies.complete,
		maxOutputTokens: config.modelMaxOutputTokens,
	});
	const materializer = new DurableAgentV2InputMaterializer(store);
	return {
		materializer,
		modelExecution,
		async executeNextTask(
			input: AgentV2WorkerExecutionInput,
		): Promise<Awaited<ReturnType<typeof executeAgentV2NextTask>>> {
			return await executeAgentV2NextTask({
				store,
				config,
				context: agentV2ContextFromRunInput(input.run),
				runId: input.run.runId,
				materializer,
				modelExecution,
				signal: input.signal,
			});
		},
	};
}

export function agentV2ContextFromRunInput(run: AgentV2RunSnapshot): {
	clientId: string;
	sessionId: string;
	title: string;
} {
	return { clientId: run.clientId, ...parseAgentV2RunContext(run.input) };
}

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
					agentV2: config.agentV2,
				},
			},
		],
	});

	let runtimeDb: AgentV2ProductionStore | undefined;
	let agentV2RunEventBus: RedisAgentV2RunEventBus | undefined;
	let worker: AgentV2WorkerService | undefined;
	let outboxDispatcherAbort: AbortController | undefined;
	let outboxDispatcherPromise: Promise<void> | undefined;
	try {
		runtimeDb = createAgentV2RuntimeStore(config);
		await ensureRuntimeSchemas(runtimeDb);

		const options = createAgentV2WorkerRunEventOptions(config);
		const queue: AgentV2RunQueue = createRedisAgentV2RunQueue({
			redisUrl: config.redisUrl,
			queueName: config.agentV2.queueName,
		});
		agentV2RunEventBus = new RedisAgentV2RunEventBus(options.bus);
		const events = new AgentV2RunEventLog({ store: runtimeDb, bus: agentV2RunEventBus });
		const outboxDispatcher = AgentV2OutboxDispatcher.forQueueAndLive({
			store: runtimeDb,
			queue,
			queueName: config.agentV2.queueName,
			bus: agentV2RunEventBus,
			additionalAdapters: createAgentV2DiagnosticProjectionAdapters({ store: runtimeDb, diagnostics }),
			onError: (event) => {
				writeWorkerProcessDiagnostic(config, diagnostics, event.code, "error", { message: event.message });
			},
		});
		outboxDispatcherAbort = new AbortController();
		outboxDispatcherPromise = outboxDispatcher
			.start({
				ownerId: `worker:${config.workerId}`,
				intervalMs: 250,
				signal: outboxDispatcherAbort.signal,
			})
			.catch(() => {
				writeWorkerProcessDiagnostic(config, diagnostics, "agent_v2.outbox_dispatcher_failed", "error", {
					message: "Agent v2 outbox dispatcher stopped unexpectedly",
				});
			});
		worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events,
			execution: createAgentV2WorkerExecution(config, runtimeDb),
			workerId: config.workerId,
			concurrency: config.workerConcurrency,
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
			const stopResult = await stopWorkerRuntime({
				worker,
				agentV2RunEventBus,
				runtimeDb,
				diagnostics,
				outboxDispatcherAbort,
				outboxDispatcherPromise,
			});
			const exitCode = stopResult.completed ? 0 : 1;
			writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.stopped", exitCode === 0 ? "info" : "error", {
				signal,
				exitCode,
				stopResult,
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
			`PI agent v2 worker ${config.workerId} started with concurrency ${config.workerConcurrency} on queue ${config.agentV2.queueName}.`,
		);
	} catch (error) {
		writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.start_failed", "error", {
			...diagnosticErrorData(error),
			hint: "The agent v2 worker process failed before it could stay online and claim queued runs.",
		});
		await stopWorkerRuntime({
			worker,
			agentV2RunEventBus,
			runtimeDb,
			diagnostics,
			outboxDispatcherAbort,
			outboxDispatcherPromise,
		});
		removeProcessLifecycleDiagnostics();
		removeFatalDiagnostics();
		throw error;
	}
}

export async function stopWorkerRuntime(input: {
	worker?: AgentV2WorkerService;
	agentV2RunEventBus?: RedisAgentV2RunEventBus;
	runtimeDb?: AgentV2ProductionStore;
	diagnostics: Pick<WorkspaceDiagnosticLogService, "flushLangfuse">;
	outboxDispatcherAbort?: AbortController;
	outboxDispatcherPromise?: Promise<void>;
	shutdownTimeoutMs?: number;
}): Promise<AgentV2WorkerStopResult> {
	input.outboxDispatcherAbort?.abort();
	return await runWorkerShutdownDeadline({
		timeoutMs: input.shutdownTimeoutMs,
		run: async (options) => {
			const dispatcher = await runAgentV2ShutdownSteps(
				[{ step: "outbox_dispatcher.stop", run: async () => await input.outboxDispatcherPromise }],
				options,
			);
			let worker: AgentV2WorkerStopResult = { completed: true, timedOutSteps: [], errors: [] };
			try {
				worker = (await input.worker?.stop(options)) ?? worker;
			} catch {
				worker = {
					completed: false,
					timedOutSteps: [],
					errors: [
						{
							step: "worker.stop",
							code: "agent_v2.shutdown_step_failed",
							message: "Agent v2 shutdown step failed",
						},
					],
				};
			}
			const remaining = await runAgentV2ShutdownSteps(
				[
					{
						step: "event_bus.close",
						run: async (closeOptions) => await input.agentV2RunEventBus?.close(closeOptions),
					},
					{
						step: "langfuse.flush",
						run: async (closeOptions) => await input.diagnostics.flushLangfuse(closeOptions.signal),
					},
					{ step: "runtime_store.close", run: async () => await input.runtimeDb?.close() },
				],
				options,
			);
			const timedOutSteps = [...dispatcher.timedOutSteps, ...worker.timedOutSteps, ...remaining.timedOutSteps];
			const errors = [...dispatcher.errors, ...worker.errors, ...remaining.errors];
			return { completed: timedOutSteps.length === 0 && errors.length === 0, timedOutSteps, errors };
		},
	});
}

export function createWorkerStartupDiagnosticEvents(config: StorageConfig): DiagnosticLogEventInput[] {
	const envFileExists = Boolean(config.envFile && existsSync(config.envFile));
	const events: DiagnosticLogEventInput[] = [
		{
			level: "info",
			category: "system",
			eventType: "system.startup.config",
			data: {
				envFile: config.envFile,
				envFileExists,
				redisUrl: redactConnectionUrl(config.redisUrl),
				agentV2: config.agentV2,
				runtimeDbFile: config.runtimeDbFile,
				workerId: config.workerId,
				workerConcurrency: config.workerConcurrency,
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

export function installWorkerFatalDiagnostics(
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
	const onUncaughtException = (error: Error): void => exitAfterFatal("system.worker.uncaught_exception", error);
	const onUnhandledRejection = (reason: unknown): void => exitAfterFatal("system.worker.unhandled_rejection", reason);
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
					agentV2: config.agentV2,
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
	return { message: stringifyDiagnosticValue(error) };
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
