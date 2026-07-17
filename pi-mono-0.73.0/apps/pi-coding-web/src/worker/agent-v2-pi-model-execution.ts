import { completeSimple } from "@mariozechner/pi-ai/complete-simple";
import { getModel } from "@mariozechner/pi-ai/models";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	Model,
	OpenAICompletionsCompat,
	OpenAIResponsesCompat,
	SimpleStreamOptions,
	Usage,
} from "@mariozechner/pi-ai/types";
import {
	type AgentV2ImplementationResult,
	AgentV2ModelContractError,
	type AgentV2ModelExecution,
	type AgentV2ModelExecutionEnvelope,
	type AgentV2ModelExecutionInput,
	type AgentV2ModelUsageSummary,
	type AgentV2RepairResult,
	normalizeAgentV2ModelReference,
	parseAgentV2ImplementationResult,
	parseAgentV2RepairResult,
	renderAgentV2ImplementationPrompt,
	renderAgentV2RepairPrompt,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import type { AgentV2ServerSettingsSnapshot } from "./global-provider-keys.js";

export type AgentV2ModelAuthentication = "required" | "ambient-or-key" | "trusted-local-optional";

export interface AgentV2ServerModelRegistry {
	resolve(reference: { provider: string; id: string }): Model<Api> | undefined;
	resolveAuthentication?(reference: { provider: string; id: string }): AgentV2ModelAuthentication;
}

export interface AgentV2PiModelExecutionOptions {
	modelRegistry: AgentV2ServerModelRegistry;
	resolveApiKey(provider: string): string | undefined;
	complete?: typeof completeSimple;
	maxOutputTokens?: number;
	streamIdleTimeoutMs?: number;
}

type AgentV2RepairExecutionInput = Parameters<AgentV2ModelExecution["generateRepair"]>[0];

export type AgentV2PiModelExecutionErrorCode =
	| "invalid_model_reference"
	| "unknown_model"
	| "missing_api_key"
	| "provider_failed"
	| "provider_identity_mismatch"
	| "invalid_provider_content"
	| "provider_length"
	| "provider_tool_use"
	| "provider_error"
	| "provider_timeout"
	| "provider_network"
	| "provider_rate_limit"
	| "provider_server_error";

const ERROR_MESSAGES: Readonly<Record<AgentV2PiModelExecutionErrorCode, string>> = Object.freeze({
	invalid_model_reference: "Agent v2 model reference is invalid.",
	unknown_model: "Agent v2 model reference is not configured on the server.",
	missing_api_key: "Agent v2 model provider credentials are not configured on the server.",
	provider_failed: "Agent v2 model provider request failed.",
	provider_identity_mismatch: "Agent v2 model provider returned an unexpected model identity.",
	invalid_provider_content: "Agent v2 model provider returned invalid assistant content.",
	provider_length: "Agent v2 model provider stopped because the output limit was reached.",
	provider_tool_use: "Agent v2 model provider attempted unsupported tool use.",
	provider_error: "Agent v2 model provider returned an error result.",
	provider_timeout: "Agent v2 model provider timed out before producing a complete result.",
	provider_network: "Agent v2 model provider network request failed.",
	provider_rate_limit: "Agent v2 model provider rate limit was reached.",
	provider_server_error: "Agent v2 model provider is temporarily unavailable.",
});

export interface AgentV2PiModelExecutionFailureDetails {
	attempts: number;
	retryable: boolean;
	hadObservableOutput: boolean;
	idleTimeoutMs?: number;
}

export class AgentV2PiModelExecutionError extends Error {
	readonly code: AgentV2PiModelExecutionErrorCode;
	readonly attempts?: number;
	readonly retryable?: boolean;
	readonly hadObservableOutput?: boolean;
	readonly idleTimeoutMs?: number;

	constructor(code: AgentV2PiModelExecutionErrorCode, details?: AgentV2PiModelExecutionFailureDetails) {
		super(providerFailureMessage(code, details));
		this.name = "AgentV2PiModelExecutionError";
		this.code = code;
		if (details) {
			this.attempts = details.attempts;
			this.retryable = details.retryable;
			this.hadObservableOutput = details.hadObservableOutput;
			this.idleTimeoutMs = details.idleTimeoutMs;
		}
	}
}

export class BuiltinAgentV2ServerModelRegistry implements AgentV2ServerModelRegistry {
	resolve(reference: { provider: string; id: string }): Model<Api> | undefined {
		const model = getModel(reference.provider as never, reference.id as never) as Model<Api> | undefined;
		return model?.provider === reference.provider && model.id === reference.id ? model : undefined;
	}

	resolveAuthentication(reference: { provider: string; id: string }): AgentV2ModelAuthentication {
		return reference.provider === "google-vertex" || reference.provider === "amazon-bedrock"
			? "ambient-or-key"
			: "required";
	}
}

export class ConfiguredAgentV2ServerModelRegistry implements AgentV2ServerModelRegistry {
	private readonly builtin = new BuiltinAgentV2ServerModelRegistry();

	constructor(private readonly snapshot: AgentV2ServerSettingsSnapshot) {}

	resolve(reference: { provider: string; id: string }): Model<Api> | undefined {
		const builtin = this.builtin.resolve(reference);
		if (builtin) return builtin;
		if (!reference.provider.startsWith("custom-provider:")) return undefined;
		const providerId = reference.provider.slice("custom-provider:".length);
		const provider = this.snapshot.customProvider(providerId);
		return provider ? configuredCustomModel(provider, this.snapshot.selectedModel(), reference) : undefined;
	}

	resolveAuthentication(reference: { provider: string; id: string }): AgentV2ModelAuthentication {
		if (!reference.provider.startsWith("custom-provider:")) return this.builtin.resolveAuthentication(reference);
		const provider = this.snapshot.customProvider(reference.provider.slice("custom-provider:".length));
		if (!provider || !isAutoDiscoveryType(provider.type) || !isStrictLoopbackUrl(provider.baseUrl)) return "required";
		return "trusted-local-optional";
	}
}

export class AgentV2PiModelExecution implements AgentV2ModelExecution {
	private readonly complete: typeof completeSimple;

	constructor(private readonly options: AgentV2PiModelExecutionOptions) {
		this.complete = options.complete ?? completeSimple;
	}

	async generateImplementation(
		input: AgentV2ModelExecutionInput,
	): Promise<AgentV2ModelExecutionEnvelope<AgentV2ImplementationResult>> {
		throwIfAborted(input.signal);
		const prompt = renderAgentV2ImplementationPrompt(input);
		return await this.execute(input, prompt, (text) => parseAgentV2ImplementationResult(text, input.task.taskId));
	}

	async generateRepair(
		input: AgentV2RepairExecutionInput,
	): Promise<AgentV2ModelExecutionEnvelope<AgentV2RepairResult>> {
		throwIfAborted(input.signal);
		const prompt = renderAgentV2RepairPrompt(input);
		return await this.execute(input, prompt, (text) => parseAgentV2RepairResult(text, input.task.taskId));
	}

	private async execute<T>(
		input: AgentV2ModelExecutionInput,
		prompt: { systemPrompt: string; userPrompt: string },
		parse: (text: string) => T,
	): Promise<AgentV2ModelExecutionEnvelope<T>> {
		throwIfAborted(input.signal);
		const reference = parseModelReference(input.run.model);
		let trustedModel: {
			model: Model<Api>;
			api: Api;
			provider: string;
			id: string;
			maxTokens: number;
		};
		try {
			const model = this.options.modelRegistry.resolve(reference);
			if (!model) throw new Error("unresolved model");
			const provider = model.provider;
			const id = model.id;
			const api = model.api;
			const maxTokens = trustedMaxTokens(model.maxTokens, this.options.maxOutputTokens);
			if (provider !== reference.provider || id !== reference.id || !boundedNonEmptyString(api, 128)) {
				throw new Error("invalid canonical model");
			}
			trustedModel = { model, api: api as Api, provider, id, maxTokens };
		} catch {
			throw new AgentV2PiModelExecutionError("unknown_model");
		}
		let authentication: AgentV2ModelAuthentication;
		try {
			authentication = this.options.modelRegistry.resolveAuthentication?.(reference) ?? "required";
			if (!isModelAuthentication(authentication)) throw new Error("invalid authentication policy");
		} catch {
			throw new AgentV2PiModelExecutionError("provider_failed");
		}
		let apiKey: string | undefined;
		try {
			apiKey = usableKey(this.options.resolveApiKey(trustedModel.provider), authentication);
		} catch {
			throw new AgentV2PiModelExecutionError("missing_api_key");
		}
		if (!apiKey && authentication !== "trusted-local-optional") {
			throw new AgentV2PiModelExecutionError("missing_api_key");
		}

		const { message, content } = await this.completeProviderRequest(input, prompt, trustedModel, apiKey);
		try {
			throwIfAborted(input.signal);
			const text = collectText(content);
			const result = parse(text);
			const usage = normalizeUsage(message.usage);
			return {
				result,
				provider: trustedModel.provider,
				model: trustedModel.id,
				usage,
			};
		} catch (error) {
			if (
				error instanceof AgentV2PiModelExecutionError ||
				error instanceof AgentV2ModelContractError ||
				isInternalAbortError(error)
			) {
				throw error;
			}
			throw new AgentV2PiModelExecutionError("provider_failed");
		}
	}

	private async completeProviderRequest(
		input: AgentV2ModelExecutionInput,
		prompt: { systemPrompt: string; userPrompt: string },
		trustedModel: { model: Model<Api>; api: Api; provider: string; id: string; maxTokens: number },
		apiKey: string | undefined,
	): Promise<{ message: AssistantMessage; content: readonly unknown[] }> {
		const idleTimeoutMs = positiveInteger(this.options.streamIdleTimeoutMs);
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			throwIfAborted(input.signal);
			const result = await this.completeProviderAttempt(input, prompt, trustedModel, apiKey, idleTimeoutMs);
			if ("error" in result) {
				if (input.signal.aborted) throw createAbortError();
				const failure = providerFailureFromThrownError(
					result.error,
					attempt,
					idleTimeoutMs,
					result.hadObservableOutput,
					result.idleTimedOut,
				);
				if (attempt === 1 && failure.retryable) continue;
				throw failure;
			}
			if (input.signal.aborted) throw createAbortError();
			const content = validateProviderMessage(result.message);
			validateMessageIdentity(result.message, trustedModel);
			const failure = providerFailureFromMessage(result, content, attempt, idleTimeoutMs);
			if (!failure) return { message: result.message, content };
			if (attempt === 1 && failure.retryable) continue;
			throw failure;
		}
		throw new AgentV2PiModelExecutionError("provider_failed");
	}

	private async completeProviderAttempt(
		input: AgentV2ModelExecutionInput,
		prompt: { systemPrompt: string; userPrompt: string },
		trustedModel: { model: Model<Api>; api: Api; provider: string; id: string; maxTokens: number },
		apiKey: string | undefined,
		idleTimeoutMs: number | undefined,
	): Promise<ProviderAttemptResult> {
		const controller = new AbortController();
		let idleTimedOut = false;
		let hadObservableOutput = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const abortForUser = (): void => controller.abort();
		const resetIdleWatchdog = (): void => {
			if (timeout !== undefined) clearTimeout(timeout);
			if (idleTimeoutMs === undefined) return;
			timeout = setTimeout(() => {
				idleTimedOut = true;
				controller.abort();
			}, idleTimeoutMs);
		};
		input.signal.addEventListener("abort", abortForUser, { once: true });
		if (input.signal.aborted) controller.abort();
		resetIdleWatchdog();
		try {
			const options: SimpleStreamOptions = {
				apiKey,
				signal: controller.signal,
				maxTokens: trustedModel.maxTokens,
				sessionId: `agent-v2:${input.run.runId}:${input.task.taskId}`,
				maxRetries: 0,
				onChunk: () => {
					hadObservableOutput = true;
					resetIdleWatchdog();
				},
			};
			const message = await this.complete(
				trustedModel.model,
				{
					systemPrompt: prompt.systemPrompt,
					messages: [
						{ role: "user", content: prompt.userPrompt, timestamp: stableTimestamp(input.run.updatedAt) },
					],
				},
				options,
			);
			return { message, idleTimedOut, hadObservableOutput };
		} catch (error) {
			return { error, idleTimedOut, hadObservableOutput };
		} finally {
			if (timeout !== undefined) clearTimeout(timeout);
			input.signal.removeEventListener("abort", abortForUser);
		}
	}
}

interface ProviderAttemptSuccess {
	message: AssistantMessage;
	idleTimedOut: boolean;
	hadObservableOutput: boolean;
}

interface ProviderAttemptFailure {
	error: unknown;
	idleTimedOut: boolean;
	hadObservableOutput: boolean;
}

type ProviderAttemptResult = ProviderAttemptSuccess | ProviderAttemptFailure;

type TransientProviderFailureCode =
	| "provider_timeout"
	| "provider_network"
	| "provider_rate_limit"
	| "provider_server_error";

function providerFailureMessage(
	code: AgentV2PiModelExecutionErrorCode,
	details: AgentV2PiModelExecutionFailureDetails | undefined,
): string {
	const base = ERROR_MESSAGES[code];
	if (!details || !isTransientProviderFailureCode(code)) return base;
	const attemptSummary = `${details.attempts} provider attempt${details.attempts === 1 ? "" : "s"}`;
	if (details.hadObservableOutput) {
		return `${base} Output had already started, so the request was not retried (${attemptSummary}).`;
	}
	if (code === "provider_timeout" && details.idleTimeoutMs !== undefined) {
		return `${base} No provider chunks were received within ${details.idleTimeoutMs}ms (${attemptSummary}).`;
	}
	return `${base} No provider output was received (${attemptSummary}).`;
}

function providerFailureFromMessage(
	result: ProviderAttemptSuccess,
	content: readonly unknown[],
	attempts: number,
	idleTimeoutMs: number | undefined,
): AgentV2PiModelExecutionError | undefined {
	const { message } = result;
	if (message.stopReason === "stop") return undefined;
	if (message.stopReason === "aborted") {
		if (!result.idleTimedOut) throw createAbortError();
		return transientProviderFailure(
			"provider_timeout",
			attempts,
			result.hadObservableOutput || content.length > 0,
			idleTimeoutMs,
		);
	}
	if (message.stopReason === "length") return new AgentV2PiModelExecutionError("provider_length");
	if (message.stopReason === "toolUse") return new AgentV2PiModelExecutionError("provider_tool_use");
	const code = classifyProviderFailureMessage(message.errorMessage);
	if (!code) return new AgentV2PiModelExecutionError("provider_error");
	return transientProviderFailure(code, attempts, result.hadObservableOutput || content.length > 0, idleTimeoutMs);
}

function providerFailureFromThrownError(
	error: unknown,
	attempts: number,
	idleTimeoutMs: number | undefined,
	hadObservableOutput: boolean,
	idleTimedOut: boolean,
): AgentV2PiModelExecutionError {
	if (idleTimedOut) {
		return transientProviderFailure("provider_timeout", attempts, hadObservableOutput, idleTimeoutMs);
	}
	const code = classifyProviderFailureMessage(safeErrorMessage(error));
	return code
		? transientProviderFailure(code, attempts, hadObservableOutput, idleTimeoutMs)
		: new AgentV2PiModelExecutionError("provider_failed");
}

function transientProviderFailure(
	code: TransientProviderFailureCode,
	attempts: number,
	hadObservableOutput: boolean,
	idleTimeoutMs: number | undefined,
): AgentV2PiModelExecutionError {
	return new AgentV2PiModelExecutionError(code, {
		attempts,
		retryable: !hadObservableOutput,
		hadObservableOutput,
		...(code === "provider_timeout" && idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
	});
}

function classifyProviderFailureMessage(value: string | undefined): TransientProviderFailureCode | undefined {
	if (!value) return undefined;
	if (
		/content.?filter|unauthori[sz]ed|forbidden|authentication|invalid.?api.?key|(?:^|\D)(?:400|401|402|403|404|405|409|410|422)(?:\D|$)/iu.test(
			value,
		)
	) {
		return undefined;
	}
	if (/rate.?limit|too many requests|(?:^|\D)429(?:\D|$)/iu.test(value)) return "provider_rate_limit";
	if (/(?:^|\D)(?:500|502|503|504)(?:\D|$)|service.?unavailable|server.?error|internal.?error/iu.test(value)) {
		return "provider_server_error";
	}
	if (/timed? out|timeout|stream stalled|ended without sending chunks/iu.test(value)) return "provider_timeout";
	if (
		/network.?error|connection.?error|connection.?refused|connection.?lost|fetch failed|upstream.?connect|reset before headers|socket hang up|http2 request did not get a response|terminated/iu.test(
			value,
		)
	) {
		return "provider_network";
	}
	return undefined;
}

function safeErrorMessage(error: unknown): string | undefined {
	try {
		return error instanceof Error && typeof error.message === "string" ? error.message : undefined;
	} catch {
		return undefined;
	}
}

function isTransientProviderFailureCode(code: AgentV2PiModelExecutionErrorCode): code is TransientProviderFailureCode {
	return (
		code === "provider_timeout" ||
		code === "provider_network" ||
		code === "provider_rate_limit" ||
		code === "provider_server_error"
	);
}

function parseModelReference(value: unknown): { provider: string; id: string } {
	try {
		if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
			throw new Error("invalid model reference container");
		}
		const keys = Reflect.ownKeys(value);
		if (keys.length !== 2 || !keys.includes("id") || !keys.includes("provider")) {
			throw new Error("invalid model reference fields");
		}
		const providerDescriptor = Object.getOwnPropertyDescriptor(value, "provider");
		const idDescriptor = Object.getOwnPropertyDescriptor(value, "id");
		if (!isDataDescriptor(providerDescriptor) || !isDataDescriptor(idDescriptor)) {
			throw new Error("invalid model reference descriptors");
		}
		return normalizeAgentV2ModelReference({
			provider: providerDescriptor.value,
			id: idDescriptor.value,
		});
	} catch {
		throw new AgentV2PiModelExecutionError("invalid_model_reference");
	}
}

function isDataDescriptor(value: PropertyDescriptor | undefined): value is PropertyDescriptor & { value: unknown } {
	return value !== undefined && Object.hasOwn(value, "value") && value.get === undefined && value.set === undefined;
}

function validateMessageIdentity(message: AssistantMessage, model: { api: Api; provider: string; id: string }): void {
	if (message.api !== model.api || message.provider !== model.provider || message.model !== model.id) {
		throw new AgentV2PiModelExecutionError("provider_identity_mismatch");
	}
}

const MAX_PROVIDER_CONTENT_BLOCKS = 256;
const MAX_PROVIDER_TEXT_CODE_UNITS = 16_777_216;
const MAX_PROVIDER_DIAGNOSTICS = 64;
const MAX_PROVIDER_DIAGNOSTIC_NODES = 4_096;
const MAX_PROVIDER_DIAGNOSTIC_DEPTH = 16;
const MAX_PROVIDER_DIAGNOSTIC_STRING_CODE_UNITS = 65_536;

function validateProviderMessage(value: unknown): readonly unknown[] {
	try {
		if (
			!isExactPlainDataRecord(
				value,
				["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
				["responseModel", "responseId", "diagnostics", "errorMessage"],
			)
		) {
			throw new AgentV2PiModelExecutionError("invalid_provider_content");
		}
		if (
			value.role !== "assistant" ||
			!boundedNonEmptyString(value.api, 128) ||
			!isCanonicalModelIdentity(value.provider, value.model) ||
			!isStopReason(value.stopReason) ||
			typeof value.timestamp !== "number" ||
			!Number.isFinite(value.timestamp) ||
			!optionalBoundedString(value.responseModel, 512) ||
			!optionalBoundedString(value.responseId, 4096) ||
			!optionalBoundedString(value.errorMessage, 65_536)
		) {
			throw new AgentV2PiModelExecutionError("invalid_provider_content");
		}
		const content = exactDataArrayValues(value.content, MAX_PROVIDER_CONTENT_BLOCKS);
		if (!content) throw new AgentV2PiModelExecutionError("invalid_provider_content");
		validateProviderDiagnostics(value.diagnostics);
		validateUsage(value.usage);
		if (value.stopReason !== "stop") return content;
		if (content.length === 0) throw new AgentV2PiModelExecutionError("invalid_provider_content");
		let contentCodeUnits = 0;
		for (let index = 0; index < content.length; index += 1) {
			const block = content[index];
			if (!isRecord(block) || Object.getPrototypeOf(block) !== Object.prototype) {
				throw new AgentV2PiModelExecutionError("invalid_provider_content");
			}
			const typeDescriptor = Object.getOwnPropertyDescriptor(block, "type");
			if (!isDataDescriptor(typeDescriptor)) throw new AgentV2PiModelExecutionError("invalid_provider_content");
			if (typeDescriptor.value === "text") {
				if (
					!isExactPlainDataRecord(block, ["type", "text"], ["textSignature"]) ||
					typeof block.text !== "string" ||
					!optionalBoundedString(block.textSignature, 65_536)
				) {
					throw new AgentV2PiModelExecutionError("invalid_provider_content");
				}
				contentCodeUnits += block.text.length;
				if (contentCodeUnits > MAX_PROVIDER_TEXT_CODE_UNITS)
					throw new AgentV2PiModelExecutionError("invalid_provider_content");
				continue;
			}
			if (typeDescriptor.value === "thinking") {
				if (
					!isExactPlainDataRecord(block, ["type", "thinking"], ["thinkingSignature", "redacted"]) ||
					typeof block.thinking !== "string" ||
					block.thinking.length > MAX_PROVIDER_TEXT_CODE_UNITS ||
					!optionalBoundedString(block.thinkingSignature, 65_536) ||
					(block.redacted !== undefined && typeof block.redacted !== "boolean")
				) {
					throw new AgentV2PiModelExecutionError("invalid_provider_content");
				}
				contentCodeUnits += block.thinking.length;
				if (contentCodeUnits > MAX_PROVIDER_TEXT_CODE_UNITS)
					throw new AgentV2PiModelExecutionError("invalid_provider_content");
				continue;
			}
			throw new AgentV2PiModelExecutionError("invalid_provider_content");
		}
		return content;
	} catch (error) {
		if (error instanceof AgentV2PiModelExecutionError) throw error;
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
	}
}

function validateProviderDiagnostics(value: unknown): void {
	if (value === undefined) return;
	const diagnostics = exactDataArrayValues(value, MAX_PROVIDER_DIAGNOSTICS);
	if (!diagnostics) throw new AgentV2PiModelExecutionError("invalid_provider_content");
	for (let index = 0; index < diagnostics.length; index += 1) {
		const diagnostic = diagnostics[index];
		if (
			!isExactPlainDataRecord(diagnostic, ["type", "timestamp"], ["error", "details"]) ||
			typeof diagnostic.type !== "string" ||
			diagnostic.type.length === 0 ||
			diagnostic.type.length > 256 ||
			typeof diagnostic.timestamp !== "number" ||
			!Number.isFinite(diagnostic.timestamp) ||
			diagnostic.timestamp < 0
		)
			throw new AgentV2PiModelExecutionError("invalid_provider_content");
		if (diagnostic.error !== undefined) validateProviderDiagnosticError(diagnostic.error);
		if (diagnostic.details !== undefined && !isBoundedPlainDiagnosticData(diagnostic.details)) {
			throw new AgentV2PiModelExecutionError("invalid_provider_content");
		}
	}
}

function validateProviderDiagnosticError(value: unknown): void {
	if (!isExactPlainDataRecord(value, ["message"], ["name", "stack", "code"])) {
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
	}
	if (
		typeof value.message !== "string" ||
		value.message.length > MAX_PROVIDER_DIAGNOSTIC_STRING_CODE_UNITS ||
		!optionalBoundedString(value.name, 256) ||
		!optionalBoundedString(value.stack, MAX_PROVIDER_DIAGNOSTIC_STRING_CODE_UNITS) ||
		(value.code !== undefined &&
			!(
				(typeof value.code === "string" && value.code.length <= 256) ||
				(typeof value.code === "number" && Number.isFinite(value.code))
			))
	)
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
}

function isBoundedPlainDiagnosticData(root: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop() as { value: unknown; depth: number };
		if (++nodes > MAX_PROVIDER_DIAGNOSTIC_NODES || current.depth > MAX_PROVIDER_DIAGNOSTIC_DEPTH) return false;
		if (
			current.value === null ||
			current.value === undefined ||
			typeof current.value === "boolean" ||
			(typeof current.value === "number" && Number.isFinite(current.value))
		)
			continue;
		if (typeof current.value === "string") {
			if (current.value.length > MAX_PROVIDER_DIAGNOSTIC_STRING_CODE_UNITS) return false;
			continue;
		}
		const array = exactDataArrayValues(current.value, 256);
		if (array) {
			for (let index = 0; index < array.length; index += 1)
				stack.push({ value: array[index], depth: current.depth + 1 });
			continue;
		}
		if (!isRecord(current.value) || Object.getPrototypeOf(current.value) !== Object.prototype) return false;
		const ownKeys = Reflect.ownKeys(current.value);
		if (ownKeys.some((key) => typeof key !== "string")) return false;
		const keys = ownKeys as string[];
		if (keys.length > 256) return false;
		for (const key of keys) {
			if (key.length === 0 || key.length > 256) return false;
			const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
			if (!isDataDescriptor(descriptor)) return false;
			stack.push({ value: descriptor.value, depth: current.depth + 1 });
		}
	}
	return true;
}

function exactDataArrayValues(value: unknown, maxLength: number): readonly unknown[] | undefined {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		!isDataDescriptor(lengthDescriptor) ||
		typeof lengthDescriptor.value !== "number" ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > maxLength
	)
		return undefined;
	const length = lengthDescriptor.value;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1 || !keys.includes("length")) return undefined;
	const items: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		const key = String(index);
		if (!keys.includes(key)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!isDataDescriptor(descriptor)) return undefined;
		items.push(descriptor.value);
	}
	return items;
}

function isStopReason(value: unknown): boolean {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function optionalBoundedString(value: unknown, maxLength: number): boolean {
	return value === undefined || (typeof value === "string" && value.length <= maxLength);
}

function isExactPlainDataRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = [],
): value is Record<string, unknown> {
	if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string")) return false;
	const keys = ownKeys as string[];
	if (keys.length < required.length || keys.length > required.length + optional.length) return false;
	const allowed = new Set([...required, ...optional]);
	if (keys.some((key) => !allowed.has(key)) || required.some((key) => !keys.includes(key))) return false;
	return keys.every((key) => isDataDescriptor(Object.getOwnPropertyDescriptor(value, key)));
}

function collectText(content: readonly unknown[]): string {
	const parts: string[] = [];
	for (let index = 0; index < content.length; index += 1) {
		const block = content[index] as Record<string, unknown>;
		const type = Object.getOwnPropertyDescriptor(block, "type")?.value;
		if (type === "toolCall") throw new AgentV2PiModelExecutionError("invalid_provider_content");
		if (type === "text") parts.push(Object.getOwnPropertyDescriptor(block, "text")?.value as string);
	}
	const text = parts.join("");
	if (text.length === 0) throw new AgentV2PiModelExecutionError("invalid_provider_content");
	return text;
}

function normalizeUsage(usage: Usage): AgentV2ModelUsageSummary {
	validateUsage(usage);
	return { input: usage.input, output: usage.output, totalTokens: usage.totalTokens, costTotal: usage.cost.total };
}

function validateUsage(value: unknown): asserts value is Usage {
	if (!isExactPlainDataRecord(value, ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"])) {
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
	}
	if (!isExactPlainDataRecord(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"])) {
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
	}
	const numbers = [
		value.input,
		value.output,
		value.cacheRead,
		value.cacheWrite,
		value.totalTokens,
		value.cost.input,
		value.cost.output,
		value.cost.cacheRead,
		value.cost.cacheWrite,
		value.cost.total,
	];
	if (numbers.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
		throw new AgentV2PiModelExecutionError("invalid_provider_content");
	}
}

function trustedMaxTokens(modelMaxTokens: number | undefined, configured: number | undefined): number {
	const modelMax = positiveInteger(modelMaxTokens);
	const configuredMax = positiveInteger(configured);
	if (modelMax === undefined && configuredMax === undefined) {
		throw new AgentV2PiModelExecutionError("unknown_model");
	}
	if (modelMax === undefined) return configuredMax as number;
	if (configuredMax === undefined) return modelMax;
	return Math.min(modelMax, configuredMax);
}

function positiveInteger(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stableTimestamp(value: string): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : 0;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw createAbortError();
}

function createAbortError(): Error {
	const error = new AgentV2InternalAbortError();
	INTERNAL_ABORT_ERRORS.add(error);
	return error;
}

class AgentV2InternalAbortError extends Error {
	constructor() {
		super("Agent v2 model execution was aborted.");
		this.name = "AbortError";
	}
}

const INTERNAL_ABORT_ERRORS = new WeakSet<object>();

function isInternalAbortError(error: unknown): boolean {
	return (typeof error === "object" && error !== null) || typeof error === "function"
		? INTERNAL_ABORT_ERRORS.has(error as object)
		: false;
}

function isModelAuthentication(value: unknown): value is AgentV2ModelAuthentication {
	return value === "required" || value === "ambient-or-key" || value === "trusted-local-optional";
}

function usableKey(value: string | undefined, authentication: AgentV2ModelAuthentication): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	if (trimmed === "<authenticated>") return authentication === "ambient-or-key" ? trimmed : undefined;
	if (/^<[^>]+>$/u.test(trimmed)) return undefined;
	return trimmed;
}

function isCanonicalModelIdentity(provider: unknown, id: unknown): provider is string {
	try {
		const normalized = normalizeAgentV2ModelReference({ provider, id });
		return normalized.provider === provider && normalized.id === id;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredCustomModel(
	provider: Readonly<Record<string, unknown>>,
	selectedModel: Readonly<Record<string, unknown>> | undefined,
	reference: { provider: string; id: string },
): Model<Api> | undefined {
	if (
		!isCanonicalModelIdentity(reference.provider, reference.id) ||
		reference.provider !== `custom-provider:${provider.id}` ||
		!isCustomProviderType(provider.type) ||
		!isSafeHttpUrl(provider.baseUrl)
	) {
		return undefined;
	}
	if (isAutoDiscoveryType(provider.type)) {
		return configuredAutoDiscoveryModel(provider, selectedModel, reference);
	}
	if (!Array.isArray(provider.models) || provider.models.length > 256) return undefined;
	const candidate = provider.models.find((item) => isRecord(item) && item.id === reference.id);
	if (!isRecord(candidate) || !isExactManualModel(candidate)) return undefined;
	return buildConfiguredModel(provider, candidate, reference, false);
}

function configuredAutoDiscoveryModel(
	provider: Readonly<Record<string, unknown>>,
	selectedModel: Readonly<Record<string, unknown>> | undefined,
	reference: { provider: string; id: string },
): Model<Api> | undefined {
	if (!selectedModel || !isExactSelectedModel(selectedModel)) return undefined;
	if (selectedModel.provider !== reference.provider || selectedModel.id !== reference.id) return undefined;
	return buildConfiguredModel(provider, selectedModel, reference, true);
}

function buildConfiguredModel(
	provider: Readonly<Record<string, unknown>>,
	candidate: Readonly<Record<string, unknown>>,
	reference: { provider: string; id: string },
	autoDiscovery: boolean,
): Model<Api> | undefined {
	const name = boundedNonEmptyString(candidate.name, 512);
	const input = modelInput(candidate.input);
	const cost = modelCost(candidate.cost);
	const contextWindow = positiveInteger(candidate.contextWindow as number | undefined);
	const maxTokens = positiveInteger(candidate.maxTokens as number | undefined);
	const api = providerApi(provider.type as string);
	const baseUrl = providerBaseUrl(provider.type as string, provider.baseUrl as string);
	if (
		!name ||
		candidate.id !== reference.id ||
		(candidate.reasoning !== false && candidate.reasoning !== true) ||
		!input ||
		!cost ||
		!contextWindow ||
		!maxTokens ||
		(!autoDiscovery &&
			(candidate.api !== api ||
				candidate.provider !== reference.provider ||
				normalizeUrl(candidate.baseUrl) !== baseUrl))
	) {
		return undefined;
	}
	const compat = autoDiscovery
		? autoDiscoveryCompat(provider.useNonStreamingToolCalls)
		: cloneCompat(api, candidate.compat);
	if (
		(autoDiscovery && compat === undefined) ||
		(!autoDiscovery && candidate.compat !== undefined && compat === undefined)
	)
		return undefined;
	const thinkingLevelMap = cloneThinkingLevelMap(candidate.thinkingLevelMap);
	if (candidate.thinkingLevelMap !== undefined && thinkingLevelMap === undefined) return undefined;
	const model: Model<Api> = {
		id: reference.id,
		name,
		api,
		provider: reference.provider,
		baseUrl,
		reasoning: candidate.reasoning,
		input,
		cost,
		contextWindow,
		maxTokens,
	};
	if (compat) model.compat = compat as Model<Api>["compat"];
	if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
	return Object.freeze(model);
}

function isCustomProviderType(value: unknown): value is string {
	return (
		value === "ollama" ||
		value === "llama.cpp" ||
		value === "vllm" ||
		value === "lmstudio" ||
		value === "openai-completions" ||
		value === "openai-responses" ||
		value === "anthropic-messages"
	);
}

function isAutoDiscoveryType(value: unknown): value is "ollama" | "llama.cpp" | "vllm" | "lmstudio" {
	return value === "ollama" || value === "llama.cpp" || value === "vllm" || value === "lmstudio";
}

function providerApi(type: string): Api {
	if (type === "anthropic-messages") return "anthropic-messages";
	if (type === "openai-responses") return "openai-responses";
	return "openai-completions";
}

function providerBaseUrl(type: string, baseUrl: unknown): string {
	const normalized = (baseUrl as string).replace(/\/+$/u, "");
	return type === "ollama" || type === "llama.cpp" || type === "vllm" || type === "lmstudio"
		? `${normalized}/v1`
		: normalized;
}

function normalizeUrl(value: unknown): string | undefined {
	return isSafeHttpUrl(value) ? value.replace(/\/+$/u, "") : undefined;
}

function modelInput(value: unknown): ("text" | "image")[] | undefined {
	if (
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		value.length === 0 ||
		value.length > 2
	)
		return undefined;
	if (value.some((item) => item !== "text" && item !== "image")) return undefined;
	const unique = [...new Set(value)] as ("text" | "image")[];
	return unique.length === value.length ? (Object.freeze(unique) as ("text" | "image")[]) : undefined;
}

function modelCost(value: unknown): Model<Api>["cost"] | undefined {
	if (!isExactPlainDataRecord(value, ["input", "output", "cacheRead", "cacheWrite"])) return undefined;
	const cost = [value.input, value.output, value.cacheRead, value.cacheWrite];
	if (cost.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) return undefined;
	return Object.freeze({
		input: value.input as number,
		output: value.output as number,
		cacheRead: value.cacheRead as number,
		cacheWrite: value.cacheWrite as number,
	});
}

function boundedNonEmptyString(value: unknown, maxLength: number): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function isSafeHttpUrl(value: unknown): value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
	try {
		const url = new URL(value);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
	} catch {
		return false;
	}
}

function isStrictLoopbackUrl(value: unknown): boolean {
	if (!isSafeHttpUrl(value)) return false;
	const authority = value.match(/^https?:\/\/([^/?#]+)/iu)?.[1];
	if (!authority || authority.includes("@")) return false;
	let rawHost = authority;
	if (rawHost.startsWith("[")) {
		const end = rawHost.indexOf("]");
		if (end < 0 || (rawHost.slice(end + 1) && !/^:\d{1,5}$/u.test(rawHost.slice(end + 1)))) return false;
		rawHost = rawHost.slice(0, end + 1);
		return rawHost.toLowerCase() === "[::1]";
	}
	const colon = rawHost.lastIndexOf(":");
	if (colon >= 0) {
		if (!/^\d{1,5}$/u.test(rawHost.slice(colon + 1))) return false;
		rawHost = rawHost.slice(0, colon);
	}
	if (rawHost.toLowerCase() === "localhost") return true;
	const parts = rawHost.split(".");
	return (
		parts.length === 4 &&
		parts.every(
			(part, index) =>
				/^\d{1,3}$/u.test(part) &&
				(part === "0" || !part.startsWith("0")) &&
				Number(part) <= 255 &&
				(index !== 0 || Number(part) === 127),
		)
	);
}

function isExactSelectedModel(value: Record<string, unknown>): boolean {
	return isExactPlainDataRecord(
		value,
		["id", "name", "provider", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
		["headers", "compat", "thinkingLevelMap"],
	);
}

function isExactManualModel(value: Record<string, unknown>): boolean {
	return isExactPlainDataRecord(
		value,
		["id", "name", "provider", "api", "baseUrl", "reasoning", "input", "cost", "contextWindow", "maxTokens"],
		["compat", "thinkingLevelMap"],
	);
}

function autoDiscoveryCompat(useNonStreamingToolCalls: unknown): OpenAICompletionsCompat | undefined {
	if (useNonStreamingToolCalls !== undefined && typeof useNonStreamingToolCalls !== "boolean") return undefined;
	const compat: OpenAICompletionsCompat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
	};
	if (useNonStreamingToolCalls === true) compat.useNonStreamingToolCalls = true;
	return Object.freeze(compat);
}

const OPENAI_COMPLETIONS_BOOLEAN_COMPAT = [
	"supportsStore",
	"supportsDeveloperRole",
	"supportsReasoningEffort",
	"supportsUsageInStreaming",
	"requiresToolResultName",
	"requiresAssistantAfterToolResult",
	"requiresThinkingAsText",
	"requiresReasoningContentOnAssistantMessages",
	"zaiToolStream",
	"supportsStrictMode",
	"sendSessionAffinityHeaders",
	"supportsLongCacheRetention",
	"useNonStreamingToolCalls",
] as const;

function cloneCompat(
	api: Api,
	value: unknown,
): OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat | undefined {
	if (value === undefined) return undefined;
	if (
		!isRecord(value) ||
		Object.getPrototypeOf(value) !== Object.prototype ||
		Object.getOwnPropertySymbols(value).length > 0
	)
		return undefined;
	const result: Record<string, boolean | string> = {};
	let allowed: readonly string[];
	if (api === "openai-completions") {
		allowed = [
			...OPENAI_COMPLETIONS_BOOLEAN_COMPAT,
			"maxTokensField",
			"thinkingFormat",
			"cacheControlFormat",
			"customProviderProfile",
		];
		for (const key of OPENAI_COMPLETIONS_BOOLEAN_COMPAT)
			if (value[key] !== undefined) {
				if (typeof value[key] !== "boolean") return undefined;
				result[key] = value[key] as boolean;
			}
		if (value.maxTokensField !== undefined) {
			if (value.maxTokensField !== "max_completion_tokens" && value.maxTokensField !== "max_tokens")
				return undefined;
			result.maxTokensField = value.maxTokensField;
		}
		if (value.thinkingFormat !== undefined) {
			if (
				!["openai", "openrouter", "deepseek", "zai", "qwen", "qwen-chat-template"].includes(
					value.thinkingFormat as string,
				)
			)
				return undefined;
			result.thinkingFormat = value.thinkingFormat as string;
		}
		if (value.cacheControlFormat !== undefined) {
			if (value.cacheControlFormat !== "anthropic") return undefined;
			result.cacheControlFormat = "anthropic";
		}
	} else if (api === "openai-responses") {
		allowed = ["sendSessionIdHeader", "supportsLongCacheRetention", "customProviderProfile"];
		for (const key of ["sendSessionIdHeader", "supportsLongCacheRetention"] as const)
			if (value[key] !== undefined) {
				if (typeof value[key] !== "boolean") return undefined;
				result[key] = value[key] as boolean;
			}
	} else if (api === "anthropic-messages") {
		allowed = [
			"supportsEagerToolInputStreaming",
			"supportsLongCacheRetention",
			"reasoningReplayFormat",
			"customProviderProfile",
		];
		for (const key of ["supportsEagerToolInputStreaming", "supportsLongCacheRetention"] as const)
			if (value[key] !== undefined) {
				if (typeof value[key] !== "boolean") return undefined;
				result[key] = value[key] as boolean;
			}
		if (value.reasoningReplayFormat !== undefined) {
			if (
				value.reasoningReplayFormat !== "anthropic-signature" &&
				value.reasoningReplayFormat !== "deepseek-reasoning-content"
			)
				return undefined;
			result.reasoningReplayFormat = value.reasoningReplayFormat;
		}
	} else return undefined;
	if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
	if (value.customProviderProfile !== undefined) {
		if (typeof value.customProviderProfile !== "string" || value.customProviderProfile.length > 64) return undefined;
		const profiles =
			api === "openai-completions"
				? [
						"standard",
						"local-basic",
						"deepseek-mimo",
						"mimo",
						"openrouter",
						"qwen",
						"qwen-chat-template",
						"zai",
						"custom",
					]
				: api === "openai-responses"
					? ["standard", "generic-gateway", "custom"]
					: ["standard", "mimo-deepseek", "legacy-compatible", "custom"];
		if (!profiles.includes(value.customProviderProfile)) return undefined;
		result.customProviderProfile = value.customProviderProfile;
	}
	return Object.freeze(result) as OpenAICompletionsCompat | OpenAIResponsesCompat | AnthropicMessagesCompat;
}

function cloneThinkingLevelMap(value: unknown): Model<Api>["thinkingLevelMap"] | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	const allowed = ["off", "minimal", "low", "medium", "high", "xhigh"];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
	const result: Record<string, string | null> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== null && (typeof item !== "string" || item.length > 256)) return undefined;
		result[key] = item;
	}
	return Object.freeze(result);
}
