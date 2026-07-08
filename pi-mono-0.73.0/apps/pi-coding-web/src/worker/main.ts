import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	AgentV2RunEventLog,
	AgentV2WorkerService,
	createAgentV2RunQueue,
	executeAgentV2NextTask,
	RedisAgentV2RunEventBus,
	type AgentV2RunSnapshot,
	type AgentV2WorkerExecution,
	type AgentV2WorkerExecutionInput,
	type RedisAgentV2RunEventBusOptions,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import {
	createRuntimeStore,
	loadStorageConfig,
	RedisRunQueue,
	type DiagnosticLogEventInput,
	type JsonObject,
	type RuntimeStore,
	type StorageConfig,
	WorkspaceDiagnosticLogService,
} from "@mariozechner/pi-web-workspace/runtime-infra";

type WorkerProcessDiagnosticLevel = "info" | "warn" | "error";

export async function ensureRuntimeSchemas(
	runtimeDb: Pick<RuntimeStore, "ensureSchema" | "ensureAgentV2Schema">,
): Promise<void> {
	await runtimeDb.ensureSchema();
	await runtimeDb.ensureAgentV2Schema();
}

export function createAgentV2WorkerRunEventOptions(config: StorageConfig): {
	queue: { redisUrl: string; queueName: string };
	bus: RedisAgentV2RunEventBusOptions;
} {
	return {
		queue: {
			redisUrl: config.redisUrl,
			queueName: config.agentV2RunQueueName,
		},
		bus: {
			redisUrl: config.redisUrl,
			maxLen: config.agentV2RunEventStreamMaxLen,
			ttlSeconds: config.agentV2RunEventStreamTtlSeconds,
		},
	};
}

export function createAgentV2WorkerExecution(config: StorageConfig): AgentV2WorkerExecution {
	return {
		async executeNextTask(input: AgentV2WorkerExecutionInput): Promise<Awaited<ReturnType<typeof executeAgentV2NextTask>>> {
			return await executeAgentV2NextTask({
				store: input.store as RuntimeStore,
				config,
				context: agentV2ContextFromRunInput(input.run),
				runId: input.run.runId,
			});
		},
	};
}

export function agentV2ContextFromRunInput(run: AgentV2RunSnapshot): { clientId: string; sessionId: string; title: string } {
	const sessionId = nonEmptyInputString(run.input.sessionId);
	const title = nonEmptyInputString(run.input.title);
	if (!sessionId || !title) {
		throw new Error("Agent v2 run input must include non-empty string sessionId and title fields.");
	}
	return { clientId: run.clientId, sessionId, title };
}

async function main(): Promise<void> {
	const config = loadStorageConfig(process.cwd());
	if (config.appAgentVersion === "v1") {
		const legacy = await import("./legacy-v1-main.js");
		await legacy.runLegacyV1Worker();
		return;
	}

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
					appAgentVersion: config.appAgentVersion,
					workerId: config.workerId,
					workerConcurrency: config.workerConcurrency,
					agentV2RunQueueName: config.agentV2RunQueueName,
				},
			},
		],
	});

	let runtimeDb: RuntimeStore | undefined;
	let runEventBus: RedisAgentV2RunEventBus | undefined;
	let worker: AgentV2WorkerService | undefined;
	try {
		runtimeDb = createRuntimeStore(config);
		await ensureRuntimeSchemas(runtimeDb);

		const options = createAgentV2WorkerRunEventOptions(config);
		const queue = createAgentV2RunQueue(new RedisRunQueue(options.queue));
		runEventBus = new RedisAgentV2RunEventBus(options.bus);
		const events = new AgentV2RunEventLog({ store: runtimeDb, bus: runEventBus });
		worker = new AgentV2WorkerService({
			store: runtimeDb,
			queue,
			events,
			execution: createAgentV2WorkerExecution(config),
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
			const exitCode = await stopWorkerRuntime({ worker, runEventBus, runtimeDb, diagnostics });
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
			`PI agent v2 worker ${config.workerId} started with concurrency ${config.workerConcurrency} on queue ${config.agentV2RunQueueName}.`,
		);
	} catch (error) {
		writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.start_failed", "error", {
			...diagnosticErrorData(error),
			hint: "The agent v2 worker process failed before it could stay online and claim queued runs.",
		});
		await stopWorkerRuntime({ worker, runEventBus, runtimeDb, diagnostics });
		removeProcessLifecycleDiagnostics();
		removeFatalDiagnostics();
		throw error;
	}
}

async function stopWorkerRuntime(input: {
	worker?: AgentV2WorkerService;
	runEventBus?: RedisAgentV2RunEventBus;
	runtimeDb?: RuntimeStore;
	diagnostics: Pick<WorkspaceDiagnosticLogService, "flushLangfuse">;
}): Promise<number> {
	let exitCode = 0;
	try {
		await input.worker?.stop();
	} catch (error) {
		exitCode = 1;
		logCleanupError("worker.stop", error);
	}
	try {
		await input.runEventBus?.close();
	} catch (error) {
		exitCode = 1;
		logCleanupError("runEventBus.close", error);
	}
	try {
		await input.diagnostics.flushLangfuse();
	} catch (error) {
		exitCode = 1;
		logCleanupError("diagnostics.flushLangfuse", error);
	}
	try {
		await input.runtimeDb?.close();
	} catch (error) {
		exitCode = 1;
		logCleanupError("runtimeDb.close", error);
	}
	return exitCode;
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
				runsEnabled: config.runsEnabled,
				appAgentVersion: config.appAgentVersion,
				redisUrl: redactConnectionUrl(config.redisUrl),
				runQueueName: config.runQueueName,
				agentV2RunQueueName: config.agentV2RunQueueName,
				runtimeDbFile: config.runtimeDbFile,
				workerId: config.workerId,
				workerConcurrency: config.workerConcurrency,
				agentV2RunEventStreamMaxLen: config.agentV2RunEventStreamMaxLen,
				agentV2RunEventStreamTtlSeconds: config.agentV2RunEventStreamTtlSeconds,
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
					appAgentVersion: config.appAgentVersion,
					workerId: config.workerId,
					workerConcurrency: config.workerConcurrency,
					agentV2RunQueueName: config.agentV2RunQueueName,
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

function nonEmptyInputString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
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
