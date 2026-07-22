import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type PreviewReadinessChecker, WorkspaceSessionService } from "@mariozechner/pi-web-workspace";
import {
	type AgentV2InputMaterializer,
	AgentV2ModelContractError,
	type AgentV2ModelExecution,
	AgentV2OutboxDispatcher,
	AgentV2Readiness,
	AgentV2ReadinessGate,
	type AgentV2ReadinessReport,
	AgentV2RunEventLog,
	type AgentV2RunQueue,
	type AgentV2RunSnapshot,
	type AgentV2WorkerExecution,
	AgentV2WorkerExecutionFailure,
	type AgentV2WorkerExecutionInput,
	type AgentV2WorkerIdentityLease,
	AgentV2WorkerService,
	type AgentV2WorkerStopResult,
	createAgentV2DiagnosticEvent,
	createAgentV2DiagnosticProjectionAdapters,
	DurableAgentV2InputMaterializer,
	executeAgentV2NextTask,
	loadAgentV2SkillContext,
	parseAgentV2RunContext,
	RedisAgentV2RunEventBus,
	type RedisAgentV2RunEventBusOptions,
	RedisAgentV2WorkerIdentityLease,
	runAgentV2ShutdownSteps,
	WorkspaceSkillService,
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
import { AgentV2PiModelExecution, AgentV2PiModelExecutionError } from "./agent-v2-pi-model-execution.js";
import {
	type GlobalProviderApiKeySources,
	loadAgentV2ServerSettingsSnapshot,
	loadAgentV2ServerSettingsSnapshotFromRecord,
} from "./global-provider-keys.js";
import { runWorkerShutdownDeadline } from "./shutdown-deadline.js";

type WorkerProcessDiagnosticLevel = "info" | "warn" | "error";
const WORKER_READINESS_REFRESH_INTERVAL_MS = 1_000;
const WORKER_IDENTITY_LEASE_TTL_MS = 15_000;
const WORKER_IDENTITY_REFRESH_INTERVAL_MS = 3_000;

export async function ensureRuntimeSchemas(runtimeDb: AgentV2SchemaStore): Promise<void> {
	await runtimeDb.ensureAgentV2Schema();
}

export function createReadinessGatedAgentV2RunQueue(
	queue: AgentV2RunQueue,
	gate: AgentV2ReadinessGate,
	signal: AbortSignal = new AbortController().signal,
): AgentV2RunQueue {
	return {
		ping: async (signal) => {
			if (!queue.ping) throw new Error("Agent v2 queue readiness is not configured.");
			await queue.ping(signal);
		},
		enqueue: async (run) => await queue.enqueue(run),
		async claim(workerId, timeoutMs) {
			const report = await gate.check(signal);
			return report.ready ? await queue.claim(workerId, timeoutMs) : undefined;
		},
		complete: async (claim) => await queue.complete(claim),
		confirmOwnership: async (claim, timeoutMs) => await queue.confirmOwnership(claim, timeoutMs),
		requeueActive: async (workerId) => await queue.requeueActive(workerId),
		renewLease: async (claim) => await queue.renewLease(claim),
		requeueExpiredClaims: async (nowMs) => await queue.requeueExpiredClaims(nowMs),
		requestCancel: async (run, cancelToken) => await queue.requestCancel(run, cancelToken),
		isCancelRequested: async (run) => await queue.isCancelRequested(run),
		clear: async () => await queue.clear(),
		close: async (options) => await queue.close(options),
	};
}

export async function runAgentV2WorkerReadinessRefresh(input: {
	gate: AgentV2ReadinessGate;
	signal: AbortSignal;
	intervalMs?: number;
	onReport?: (report: AgentV2ReadinessReport) => void;
}): Promise<void> {
	const intervalMs = Math.max(1, input.intervalMs ?? WORKER_READINESS_REFRESH_INTERVAL_MS);
	while (!input.signal.aborted) {
		const report = await input.gate.check(input.signal, { force: true });
		input.onReport?.(report);
		await waitForAbortOrDelay(input.signal, intervalMs);
	}
}

export async function runAgentV2WorkerIdentityLeaseRefresh(input: {
	lease: Pick<AgentV2WorkerIdentityLease, "renew">;
	signal: AbortSignal;
	intervalMs?: number;
	onLost: (reason: "superseded" | "unavailable") => void;
}): Promise<void> {
	const intervalMs = Math.max(1, input.intervalMs ?? WORKER_IDENTITY_REFRESH_INTERVAL_MS);
	while (!input.signal.aborted) {
		await waitForAbortOrDelay(input.signal, intervalMs);
		if (input.signal.aborted) return;
		let owned = false;
		try {
			owned = await input.lease.renew();
		} catch {
			input.onLost("unavailable");
			return;
		}
		if (!owned) {
			input.onLost("superseded");
			return;
		}
	}
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
		previewReadinessChecker?: Pick<PreviewReadinessChecker, "check">;
	} = {},
): AgentV2WorkerExecution & {
	readonly materializer: AgentV2InputMaterializer;
	readonly modelExecution: AgentV2ModelExecution;
} {
	const sessionSettings = new WorkspaceSessionService(config);
	const modelExecution = new AgentV2PiModelExecution({
		loadServerSettingsSnapshot: (clientId) =>
			dependencies.settingsSources?.readSettingsFile
				? loadAgentV2ServerSettingsSnapshot(config, dependencies.settingsSources)
				: loadAgentV2ServerSettingsSnapshotFromRecord(
						sessionSettings.readSettings(clientId),
						dependencies.settingsSources,
					),
		complete: dependencies.complete,
		maxOutputTokens: config.modelMaxOutputTokens,
		streamIdleTimeoutMs: config.modelStreamIdleTimeoutMs,
	});
	const materializer = new DurableAgentV2InputMaterializer(store);
	const skills = new WorkspaceSkillService(config);
	return {
		materializer,
		modelExecution,
		async executeNextTask(
			input: AgentV2WorkerExecutionInput,
		): Promise<Awaited<ReturnType<typeof executeAgentV2NextTask>>> {
			let skillContext: ReturnType<typeof loadAgentV2SkillContext>;
			try {
				skillContext = loadAgentV2SkillContext({
					selectedSkillNames: readSelectedSkillNames(input.run.input.selectedSkillNames),
					skills,
				});
			} catch (error) {
				const code = agentV2SkillLoadErrorCode(error);
				const createdAt = new Date().toISOString();
				await store.commitAgentV2Diagnostic({
					diagnostic: createAgentV2DiagnosticEvent({
						diagnosticId: `${code}:${input.run.runId}`,
						clientId: input.run.clientId,
						runId: input.run.runId,
						severity: "error",
						category: "worker",
						code,
						phase: input.run.phase,
						message:
							"A selected Agent v2 skill or referenced resource could not be loaded from server configuration.",
						data: { retryable: false },
						createdAt,
					}),
					emitRunEvent: true,
				});
				throw new Error("Agent v2 server skill loading failed.");
			}
			try {
				return await executeAgentV2NextTask({
					store,
					config,
					context: agentV2ContextFromRunInput(input.run),
					runId: input.run.runId,
					materializer,
					modelExecution,
					previewReadinessChecker: dependencies.previewReadinessChecker,
					...(skillContext.skills.length > 0 || skillContext.resources.length > 0 ? { skillContext } : {}),
					signal: input.signal,
				});
			} catch (error) {
				if (error instanceof AgentV2ModelContractError) {
					throw new AgentV2WorkerExecutionFailure(
						`agent_v2.model_contract.${error.code}`,
						error.message,
						!error.code.startsWith("prompt_"),
					);
				}
				if (error instanceof AgentV2PiModelExecutionError) {
					throw new AgentV2WorkerExecutionFailure(
						`agent_v2.model.${error.code}`,
						error.message,
						error.retryable === true,
					);
				}
				throw error;
			}
		},
	};
}

function readSelectedSkillNames(value: unknown): string[] {
	if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return [];
	return value as string[];
}

function agentV2SkillLoadErrorCode(error: unknown): string {
	if (typeof error !== "object" || error === null || !("code" in error)) return "agent_v2.skill_load_failed";
	const code = (error as { code?: unknown }).code;
	return code === "skill_not_authorized" ||
		code === "skill_load_failed" ||
		code === "skill_limit_exceeded" ||
		code === "skill_resource_failed"
		? `agent_v2.${code}`
		: "agent_v2.skill_load_failed";
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
	let readinessAbort: AbortController | undefined;
	let readinessPromise: Promise<void> | undefined;
	let identityLease: AgentV2WorkerIdentityLease | undefined;
	let identityLeaseAbort: AbortController | undefined;
	let identityLeasePromise: Promise<void> | undefined;
	try {
		runtimeDb = createAgentV2RuntimeStore(config);
		await ensureRuntimeSchemas(runtimeDb);

		const options = createAgentV2WorkerRunEventOptions(config);
		const queue: AgentV2RunQueue = createRedisAgentV2RunQueue({
			redisUrl: config.redisUrl,
			queueName: config.agentV2.queueName,
		});
		agentV2RunEventBus = new RedisAgentV2RunEventBus(options.bus);
		const readinessGate = new AgentV2ReadinessGate(
			new AgentV2Readiness([
				{ name: "store", check: async (signal) => await runtimeDb!.ping(signal) },
				{
					name: "queue",
					check: async (signal) => {
						if (!queue.ping) throw new Error("Agent v2 queue readiness is not configured.");
						await queue.ping(signal);
					},
				},
				{
					name: "event_bus",
					check: async (signal) => {
						if (!agentV2RunEventBus?.ping) throw new Error("Agent v2 event bus readiness is not configured.");
						await agentV2RunEventBus.ping(signal);
					},
				},
			]),
		);
		readinessAbort = new AbortController();
		const initialReadiness = await readinessGate.check(readinessAbort.signal, { force: true });
		if (!initialReadiness.ready) throw new Error("Agent v2 worker dependencies are unavailable during startup.");
		const readinessGatedQueue = createReadinessGatedAgentV2RunQueue(queue, readinessGate, readinessAbort.signal);
		const events = new AgentV2RunEventLog({ store: runtimeDb });
		const outboxDispatcher = AgentV2OutboxDispatcher.forQueueAndLive({
			store: runtimeDb,
			queue: readinessGatedQueue,
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
			queue: readinessGatedQueue,
			events,
			execution: createAgentV2WorkerExecution(config, runtimeDb),
			workerId: config.workerId,
			queueName: config.agentV2.queueName,
			concurrency: config.workerConcurrency,
		});
		identityLease = new RedisAgentV2WorkerIdentityLease({
			redisUrl: config.redisUrl,
			queueName: config.agentV2.queueName,
			workerId: config.workerId,
			leaseTtlMs: WORKER_IDENTITY_LEASE_TTL_MS,
		});
		const identityTakeover = await identityLease.acquire();
		if (identityTakeover.replacedExistingOwner) {
			writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.identity_takeover", "warn", {
				message: "A newer process replaced the previous owner of this queue and worker identity.",
			});
		}
		readinessPromise = runAgentV2WorkerReadinessRefresh({
			gate: readinessGate,
			signal: readinessAbort.signal,
			onReport: (report) => {
				if (!report.ready) {
					writeWorkerProcessDiagnostic(config, diagnostics, "agent_v2.worker_dependencies_unavailable", "error", {
						message: "Agent v2 worker dependency readiness check failed; new claims are paused.",
					});
				}
			},
		}).catch(() => {
			if (!readinessAbort?.signal.aborted) {
				writeWorkerProcessDiagnostic(config, diagnostics, "agent_v2.worker_readiness_failed", "error", {
					message: "Agent v2 worker readiness monitoring stopped unexpectedly.",
				});
			}
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
				readinessAbort,
				readinessPromise,
				identityLease,
				identityLeaseAbort,
				identityLeasePromise,
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
		identityLeaseAbort = new AbortController();
		identityLeasePromise = runAgentV2WorkerIdentityLeaseRefresh({
			lease: identityLease,
			signal: identityLeaseAbort.signal,
			onLost: (reason) => {
				writeWorkerProcessDiagnostic(config, diagnostics, "system.worker.identity_lost", "warn", {
					reason,
					message:
						reason === "superseded"
							? "A newer process took over this worker identity; the old process is stopping."
							: "Worker identity ownership could not be renewed; the process is stopping to avoid duplicate consumers.",
				});
				void shutdown("SIGTERM").then((exitCode) => process.exit(exitCode), exitAfterShutdownFailure);
			},
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
			readinessAbort,
			readinessPromise,
			identityLease,
			identityLeaseAbort,
			identityLeasePromise,
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
	readinessAbort?: AbortController;
	readinessPromise?: Promise<void>;
	identityLease?: AgentV2WorkerIdentityLease;
	identityLeaseAbort?: AbortController;
	identityLeasePromise?: Promise<void>;
	shutdownTimeoutMs?: number;
}): Promise<AgentV2WorkerStopResult> {
	input.outboxDispatcherAbort?.abort();
	input.readinessAbort?.abort();
	input.identityLeaseAbort?.abort();
	return await runWorkerShutdownDeadline({
		timeoutMs: input.shutdownTimeoutMs,
		run: async (options) => {
			const dispatcher = await runAgentV2ShutdownSteps(
				[
					{ step: "readiness_monitor.stop", run: async () => await input.readinessPromise },
					{ step: "outbox_dispatcher.stop", run: async () => await input.outboxDispatcherPromise },
					{ step: "identity_monitor.stop", run: async () => await input.identityLeasePromise },
				],
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
					{ step: "identity_lease.release", run: async () => void (await input.identityLease?.release()) },
					{ step: "identity_lease.close", run: async () => await input.identityLease?.close() },
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

function waitForAbortOrDelay(signal: AbortSignal, delayMs: number): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onDone = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", onDone);
			resolve();
		};
		const timer = setTimeout(onDone, delayMs);
		timer.unref?.();
		signal.addEventListener("abort", onDone, { once: true });
	});
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
