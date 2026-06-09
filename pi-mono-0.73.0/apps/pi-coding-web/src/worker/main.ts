import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type ThinkingLevel,
} from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import {
	createServerDirectProjectTools,
	createServerDirectSkillTools,
	loadStorageConfig,
	RedisRunQueue,
	RuntimeDbStore,
	type RuntimeMessageRecord,
	type SkillSummary,
	type WorkerAgent,
	type WorkerAgentEvent,
	type WorkerAgentInput,
	WorkspaceDiagnosticLogService,
	WorkspaceRunWorkerService,
	WorkspaceSkillService,
} from "@mariozechner/pi-web-workspace";
import { compactProjectToolHistory } from "../project-tools/history.js";
import { buildCodingSystemPrompt } from "../prompts/coding-system-prompt.js";
import { expandSkillCommandsInMessages, getLatestRequiredSkillNames } from "../skill-tools/skill-command.js";
import { readServerProviderApiKey } from "./provider-keys.js";

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

async function main(): Promise<void> {
	const config = loadStorageConfig(process.cwd());
	const diagnostics = new WorkspaceDiagnosticLogService(config);
	diagnostics.ensureDirs();

	const runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
	runtimeDb.ensureSchema();

	const queue = new RedisRunQueue({ redisUrl: config.redisUrl, queueName: config.runQueueName });
	const skills = new WorkspaceSkillService(config, diagnostics);
	const skillList = skills.list();

	const worker = new WorkspaceRunWorkerService({
		db: runtimeDb,
		queue,
		workerId: config.workerId,
		concurrency: config.workerConcurrency,
		diagnostics,
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
		let exitCode = 0;
		try {
			await worker.stop();
		} catch (error) {
			exitCode = 1;
			logCleanupError("worker.stop", error);
		}
		try {
			await diagnostics.flushLangfuse();
		} catch (error) {
			exitCode = 1;
			logCleanupError("diagnostics.flushLangfuse", error);
		}
		try {
			runtimeDb.close();
		} catch (error) {
			exitCode = 1;
			logCleanupError("runtimeDb.close", error);
		}
		return exitCode;
	};

	process.once("SIGINT", () => {
		void shutdown("SIGINT").then((exitCode) => process.exit(exitCode), exitAfterShutdownFailure);
	});
	process.once("SIGTERM", () => {
		void shutdown("SIGTERM").then((exitCode) => process.exit(exitCode), exitAfterShutdownFailure);
	});

	worker.markOwnedRunningRunsInterrupted();
	await worker.start();
	console.log(
		`PI worker ${config.workerId} started with concurrency ${config.workerConcurrency} on queue ${config.runQueueName}.`,
	);
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
	skills: WorkspaceSkillService;
	promptSkills: SkillSummary[];
	defaultSkills: SkillSummary[];
};

function createRunAgent(input: WorkerAgentInput, options: CreateRunAgentOptions): WorkerAgent {
	const messages = toInitialAgentMessages(input.messages);
	const defaultSkillNames = options.defaultSkills.map((skill) => skill.name);
	const activeSkillNames = getLatestRequiredSkillNames(toAgentMessages(input.messages), defaultSkillNames);
	const tools = [
		...createServerDirectSkillTools(options.config, options.diagnostics),
		...createServerDirectProjectTools(
			options.config,
			{
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
		getApiKey: async (provider) => readServerProviderApiKey(options.config, provider),
		repairToolCalls: true,
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
	const initialMessages = tail?.role === "user" ? messages.slice(0, -1) : messages;
	return toAgentMessages(initialMessages);
}

function toAgentMessages(messages: RuntimeMessageRecord[]): AgentMessage[] {
	return messages.map(toAgentMessage);
}

function toAgentMessage(message: RuntimeMessageRecord): AgentMessage {
	return {
		...message.payload,
		role: message.role,
	} as AgentMessage;
}

function toWorkerAgentEvent(event: AgentEvent): WorkerAgentEvent {
	return event as unknown as WorkerAgentEvent;
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
	return THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : "high";
}

void main().catch((error) => {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
});
