import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { DiagnosticClient, DiagnosticData } from "./diagnostic-client.js";
import { summarizeProviderPayload } from "./diagnostic-client.js";

type ModelStreamFn = (
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type DiagnosticTraceContext = {
	sessionId?: string;
	traceId?: string;
	parentSpanId?: string;
};

export type DiagnosticStreamLoggingConfig = {
	rawProviderLoggingEnabled?: boolean;
	rawProviderLogMaxChars?: number;
	promptSnapshotLoggingEnabled?: boolean;
	promptSnapshotMaxChars?: number;
	modelOutputSnapshotLoggingEnabled?: boolean;
	modelOutputSnapshotMaxChars?: number;
};

type NormalizedDiagnosticStreamLoggingConfig = {
	rawProviderLoggingEnabled: boolean;
	rawProviderLogMaxChars: number;
	promptSnapshotLoggingEnabled: boolean;
	promptSnapshotMaxChars: number;
	modelOutputSnapshotLoggingEnabled: boolean;
	modelOutputSnapshotMaxChars: number;
};

const DEFAULT_RAW_PROVIDER_LOG_MAX_CHARS = 12000;
const DEFAULT_PROMPT_SNAPSHOT_MAX_CHARS = 20000;
const DEFAULT_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS = 20000;
const SNAPSHOT_CHUNK_SIZE = 1800;
const MAX_SNAPSHOT_MESSAGES = 80;
const MAX_SNAPSHOT_TOOLS = 80;
const SENSITIVE_KEY_PATTERN =
	/(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

export function createLoggedStreamFn(
	streamFn: ModelStreamFn,
	client: DiagnosticClient,
	getTraceContext: () => DiagnosticTraceContext = () => ({}),
	getLoggingConfig: () => DiagnosticStreamLoggingConfig = () => ({}),
): ModelStreamFn {
	return async (model, context, options) => {
		const startedAt = Date.now();
		const traceContext = getTraceContext();
		const loggingConfig = normalizeLoggingConfig(getLoggingConfig());
		const rawChunkState: RawStreamState = { usedChars: 0, truncatedNoticeWritten: false };
		let inputSnapshot: DiagnosticData | undefined;
		const requestId = createDiagnosticId();
		const spanId = requestId;
		const traceId = traceContext.traceId ?? traceContext.sessionId ?? requestId;
		const baseData = modelDiagnosticData(model, context);
		client.write({
			level: "info",
			category: "provider",
			eventType: "provider.request.start",
			sessionId: traceContext.sessionId,
			traceId,
			spanId,
			parentSpanId: traceContext.parentSpanId,
			requestId,
			provider: model.provider,
			model: model.id,
			data: baseData,
		});
		if (loggingConfig.promptSnapshotLoggingEnabled) {
			const snapshot = snapshotContext(context, loggingConfig.promptSnapshotMaxChars);
			inputSnapshot = { source: "context", ...snapshot };
			writePromptSnapshot(client, model, traceContext, traceId, spanId, requestId, snapshot);
		}

		try {
			const stream = await streamFn(model, context, {
				...options,
				onPayload: async (payload, requestModel) => {
					const replacement = await options?.onPayload?.(payload, requestModel);
					const effectivePayload = replacement ?? payload;
					client.write({
						level: "debug",
						category: "provider",
						eventType: "provider.payload",
						sessionId: traceContext.sessionId,
						traceId,
						spanId,
						parentSpanId: traceContext.parentSpanId,
						requestId,
						provider: requestModel.provider,
						model: requestModel.id,
						data: summarizeProviderPayload(effectivePayload),
					});
					if (loggingConfig.promptSnapshotLoggingEnabled) {
						const snapshot = snapshotProviderPayload(effectivePayload, loggingConfig.promptSnapshotMaxChars);
						inputSnapshot = { source: "provider.payload", ...snapshot };
						writeProviderPayloadSnapshot(
							client,
							requestModel,
							traceContext,
							traceId,
							spanId,
							requestId,
							snapshot,
						);
					}
					return replacement;
				},
				onChunk: async (chunk, chunkModel) => {
					await options?.onChunk?.(chunk, chunkModel);
					writeProviderRawChunk(
						client,
						chunkModel,
						chunk,
						traceContext,
						traceId,
						spanId,
						requestId,
						loggingConfig,
						rawChunkState,
					);
				},
				onResponse: async (response, responseModel) => {
					await options?.onResponse?.(response, responseModel);
					client.write({
						level: response.status >= 400 ? "error" : "info",
						category: "provider",
						eventType: "provider.response",
						sessionId: traceContext.sessionId,
						traceId,
						spanId,
						parentSpanId: traceContext.parentSpanId,
						requestId,
						provider: responseModel.provider,
						model: responseModel.id,
						data: {
							status: response.status,
							headers: summarizeHeaders(response.headers),
						},
					});
				},
			});
			return observeStream(stream, {
				client,
				model,
				traceContext,
				traceId,
				spanId,
				requestId,
				startedAt,
				loggingConfig,
				rawStreamState: { usedChars: 0, truncatedNoticeWritten: false },
				inputSnapshot,
			});
		} catch (error) {
			const message = errorMessage(error);
			client.write({
				level: "error",
				category: "provider",
				eventType: "provider.request.error",
				sessionId: traceContext.sessionId,
				traceId,
				spanId,
				parentSpanId: traceContext.parentSpanId,
				requestId,
				provider: model.provider,
				model: model.id,
				durationMs: Date.now() - startedAt,
				data: { message },
			});
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "error", reason: "error", error: createErrorAssistantMessage(model, message) });
			});
			return stream;
		}
	};
}

type ObserveOptions = {
	client: DiagnosticClient;
	model: Model<Api>;
	traceContext: DiagnosticTraceContext;
	traceId: string;
	spanId: string;
	requestId: string;
	startedAt: number;
	loggingConfig: NormalizedDiagnosticStreamLoggingConfig;
	rawStreamState: RawStreamState;
	inputSnapshot?: DiagnosticData;
};

type RawStreamState = {
	usedChars: number;
	truncatedNoticeWritten: boolean;
};

type StreamSummary = {
	eventCount: number;
	textDeltaCount: number;
	textChars: number;
	thinkingDeltaCount: number;
	thinkingChars: number;
	toolCallCount: number;
	stopReason?: string;
	errorMessage?: string;
};

type OutputSnapshotState = {
	remainingChars: number;
	text: string;
	thinking: string;
	toolCalls: DiagnosticData[];
	truncated: boolean;
};

function observeStream(source: AssistantMessageEventStream, options: ObserveOptions): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	options.rawStreamState = { usedChars: 0, truncatedNoticeWritten: false };
	const outputSnapshot = options.loggingConfig.modelOutputSnapshotLoggingEnabled
		? createOutputSnapshotState(options.loggingConfig.modelOutputSnapshotMaxChars)
		: undefined;
	const summary: StreamSummary = {
		eventCount: 0,
		textDeltaCount: 0,
		textChars: 0,
		thinkingDeltaCount: 0,
		thinkingChars: 0,
		toolCallCount: 0,
	};
	void pumpStream(source, output, options, summary, outputSnapshot);
	return output;
}

async function pumpStream(
	source: AssistantMessageEventStream,
	output: AssistantMessageEventStream,
	options: ObserveOptions,
	summary: StreamSummary,
	outputSnapshot: OutputSnapshotState | undefined,
): Promise<void> {
	try {
		for await (const event of source) {
			updateSummary(summary, event);
			updateOutputSnapshot(outputSnapshot, event);
			writeRawStreamEvent(options, event);
			output.push(event);
			if (event.type === "done" || event.type === "error") {
				writeStreamSummary(options, summary, event.type === "error" ? "error" : "info", outputSnapshot);
			}
		}
	} catch (error) {
		const message = errorMessage(error);
		summary.errorMessage = message;
		writeStreamSummary(options, summary, "error", outputSnapshot);
		output.push({
			type: "error",
			reason: "error",
			error: createErrorAssistantMessage(options.model, message),
		});
	}
}

function writePromptSnapshot(
	client: DiagnosticClient,
	model: Model<Api>,
	traceContext: DiagnosticTraceContext,
	traceId: string,
	spanId: string,
	requestId: string,
	snapshot: DiagnosticData,
): void {
	client.write({
		level: "debug",
		category: "model",
		eventType: "model.prompt.snapshot",
		sessionId: traceContext.sessionId,
		traceId,
		spanId,
		parentSpanId: traceContext.parentSpanId,
		requestId,
		provider: model.provider,
		model: model.id,
		data: snapshot,
	});
}

function writeProviderPayloadSnapshot(
	client: DiagnosticClient,
	model: Model<Api>,
	traceContext: DiagnosticTraceContext,
	traceId: string,
	spanId: string,
	requestId: string,
	snapshot: DiagnosticData,
): void {
	client.write({
		level: "debug",
		category: "provider",
		eventType: "provider.payload.snapshot",
		sessionId: traceContext.sessionId,
		traceId,
		spanId,
		parentSpanId: traceContext.parentSpanId,
		requestId,
		provider: model.provider,
		model: model.id,
		data: snapshot,
	});
}

function writeProviderRawChunk(
	client: DiagnosticClient,
	model: Model<Api>,
	chunk: unknown,
	traceContext: DiagnosticTraceContext,
	traceId: string,
	spanId: string,
	requestId: string,
	config: NormalizedDiagnosticStreamLoggingConfig,
	state: RawStreamState,
): void {
	if (!config.rawProviderLoggingEnabled) return;
	const remaining = config.rawProviderLogMaxChars - state.usedChars;
	if (remaining <= 0) {
		writeProviderRawChunkTruncatedNotice(client, model, traceContext, traceId, spanId, requestId, config, state);
		return;
	}
	const snapshot = snapshotUnknown(chunk, remaining);
	state.usedChars += snapshot.loggedChars;
	client.write({
		level: "debug",
		category: "provider",
		eventType: "provider.raw_chunk",
		sessionId: traceContext.sessionId,
		traceId,
		spanId,
		parentSpanId: traceContext.parentSpanId,
		requestId,
		provider: model.provider,
		model: model.id,
		data: {
			chunkChars: snapshot.originalChars,
			chunkChunks: snapshot.chunks,
			truncated: snapshot.truncated,
		},
	});
	if (snapshot.truncated)
		writeProviderRawChunkTruncatedNotice(client, model, traceContext, traceId, spanId, requestId, config, state);
}

function writeProviderRawChunkTruncatedNotice(
	client: DiagnosticClient,
	model: Model<Api>,
	traceContext: DiagnosticTraceContext,
	traceId: string,
	spanId: string,
	requestId: string,
	config: NormalizedDiagnosticStreamLoggingConfig,
	state: RawStreamState,
): void {
	if (state.truncatedNoticeWritten) return;
	state.truncatedNoticeWritten = true;
	client.write({
		level: "debug",
		category: "provider",
		eventType: "provider.raw_chunk.truncated",
		sessionId: traceContext.sessionId,
		traceId,
		spanId,
		parentSpanId: traceContext.parentSpanId,
		requestId,
		provider: model.provider,
		model: model.id,
		data: {
			usedChars: state.usedChars,
			maxChars: config.rawProviderLogMaxChars,
		},
	});
}

function writeRawStreamEvent(options: ObserveOptions, event: AssistantMessageEvent): void {
	if (!options.loggingConfig.rawProviderLoggingEnabled) return;
	const remaining = options.loggingConfig.rawProviderLogMaxChars - options.rawStreamState.usedChars;
	if (remaining <= 0) {
		writeRawStreamTruncatedNotice(options);
		return;
	}
	const data = summarizeRawStreamEvent(event, remaining);
	options.rawStreamState.usedChars += data.loggedChars;
	options.client.write({
		level: "debug",
		category: "model",
		eventType: "model.stream.raw_event",
		sessionId: options.traceContext.sessionId,
		traceId: options.traceId,
		spanId: options.spanId,
		parentSpanId: options.traceContext.parentSpanId,
		requestId: options.requestId,
		provider: options.model.provider,
		model: options.model.id,
		data,
	});
	if (data.truncated) writeRawStreamTruncatedNotice(options);
}

function writeRawStreamTruncatedNotice(options: ObserveOptions): void {
	if (options.rawStreamState.truncatedNoticeWritten) return;
	options.rawStreamState.truncatedNoticeWritten = true;
	options.client.write({
		level: "debug",
		category: "model",
		eventType: "model.stream.raw_event.truncated",
		sessionId: options.traceContext.sessionId,
		traceId: options.traceId,
		spanId: options.spanId,
		parentSpanId: options.traceContext.parentSpanId,
		requestId: options.requestId,
		provider: options.model.provider,
		model: options.model.id,
		data: {
			usedChars: options.rawStreamState.usedChars,
			maxChars: options.loggingConfig.rawProviderLogMaxChars,
		},
	});
}

function summarizeRawStreamEvent(
	event: AssistantMessageEvent,
	maxChars: number,
): DiagnosticData & { loggedChars: number; truncated: boolean } {
	const base: DiagnosticData = { type: event.type };
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return withClippedText(base, "delta", event.delta, maxChars, { contentIndex: event.contentIndex });
		case "text_end":
			return withClippedText(base, "content", event.content, maxChars, { contentIndex: event.contentIndex });
		case "thinking_end":
			return withClippedText(base, "content", event.content, maxChars, { contentIndex: event.contentIndex });
		case "toolcall_end": {
			const args = stableStringify(event.toolCall.arguments);
			return withClippedText(base, "arguments", args, maxChars, {
				contentIndex: event.contentIndex,
				toolCallId: event.toolCall.id,
				toolName: event.toolCall.name,
			});
		}
		case "done":
			return {
				...base,
				reason: event.reason,
				contentCount: event.message.content.length,
				loggedChars: 0,
				truncated: false,
			};
		case "error":
			return withClippedText(base, "errorMessage", event.error.errorMessage ?? "", maxChars, {
				reason: event.reason,
				contentCount: event.error.content.length,
			});
		case "start":
		case "text_start":
		case "thinking_start":
		case "toolcall_start":
			return {
				...base,
				...("contentIndex" in event ? { contentIndex: event.contentIndex } : {}),
				loggedChars: 0,
				truncated: false,
			};
	}
}

function withClippedText(
	base: DiagnosticData,
	field: string,
	value: string,
	maxChars: number,
	extra: DiagnosticData = {},
): DiagnosticData & { loggedChars: number; truncated: boolean } {
	const clipped = clipText(value, maxChars);
	return {
		...base,
		...extra,
		[`${field}Chars`]: value.length,
		[`${field}Chunks`]: clipped.chunks,
		loggedChars: clipped.loggedChars,
		truncated: clipped.truncated,
	};
}

function updateSummary(summary: StreamSummary, event: AssistantMessageEvent): void {
	summary.eventCount += 1;
	switch (event.type) {
		case "text_delta":
			summary.textDeltaCount += 1;
			summary.textChars += event.delta.length;
			break;
		case "thinking_delta":
			summary.thinkingDeltaCount += 1;
			summary.thinkingChars += event.delta.length;
			break;
		case "toolcall_end":
			summary.toolCallCount += 1;
			break;
		case "done":
			summary.stopReason = event.reason;
			break;
		case "error":
			summary.stopReason = event.reason;
			summary.errorMessage = event.error.errorMessage;
			break;
	}
}

function writeStreamSummary(
	options: ObserveOptions,
	summary: StreamSummary,
	level: "info" | "error",
	outputSnapshot: OutputSnapshotState | undefined,
): void {
	options.client.write({
		level,
		category: "model",
		eventType: "model.stream.summary",
		sessionId: options.traceContext.sessionId,
		traceId: options.traceId,
		spanId: options.spanId,
		parentSpanId: options.traceContext.parentSpanId,
		requestId: options.requestId,
		provider: options.model.provider,
		model: options.model.id,
		durationMs: Date.now() - options.startedAt,
		data: {
			...summary,
			...(options.inputSnapshot ? { inputSnapshot: options.inputSnapshot } : {}),
			...(outputSnapshot ? { outputSnapshot: finalizeOutputSnapshot(outputSnapshot) } : {}),
			api: options.model.api,
		},
	});
}

function createOutputSnapshotState(maxChars: number): OutputSnapshotState {
	return {
		remainingChars: Math.max(0, Math.round(maxChars)),
		text: "",
		thinking: "",
		toolCalls: [],
		truncated: false,
	};
}

function updateOutputSnapshot(state: OutputSnapshotState | undefined, event: AssistantMessageEvent): void {
	if (!state) return;
	switch (event.type) {
		case "text_delta":
			appendOutputText(state, "text", event.delta);
			break;
		case "thinking_delta":
			appendOutputText(state, "thinking", event.delta);
			break;
		case "toolcall_end":
			appendOutputToolCall(state, event.toolCall);
			break;
	}
}

function appendOutputText(state: OutputSnapshotState, field: "text" | "thinking", value: string): void {
	if (state.remainingChars <= 0) {
		if (value.length > 0) state.truncated = true;
		return;
	}
	const clipped = value.slice(0, state.remainingChars);
	state[field] += clipped;
	state.remainingChars -= clipped.length;
	if (clipped.length < value.length) state.truncated = true;
}

function appendOutputToolCall(
	state: OutputSnapshotState,
	toolCall: { id: string; name: string; arguments: unknown },
): void {
	const args = snapshotUnknown(toolCall.arguments, state.remainingChars);
	state.remainingChars -= args.loggedChars;
	if (args.truncated) state.truncated = true;
	state.toolCalls.push({
		id: toolCall.id,
		name: toolCall.name,
		argumentsChars: args.originalChars,
		argumentsChunks: args.chunks,
		truncated: args.truncated,
	});
}

function finalizeOutputSnapshot(state: OutputSnapshotState): DiagnosticData {
	return {
		textChunks: chunkText(state.text),
		thinkingChunks: chunkText(state.thinking),
		toolCalls: state.toolCalls,
		truncated: state.truncated,
	};
}

function modelDiagnosticData(model: Model<Api>, context: Context): DiagnosticData {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		baseUrlHost: hostFromUrl(model.baseUrl),
		messageCount: context.messages.length,
		toolCount: context.tools?.length ?? 0,
	};
}

function snapshotContext(context: Context, maxChars: number): DiagnosticData {
	const budget = createSnapshotBudget(maxChars);
	const systemPrompt = snapshotString(context.systemPrompt ?? "", budget);
	const messages = context.messages.slice(0, MAX_SNAPSHOT_MESSAGES).map((message, index) => ({
		index,
		role: message.role,
		content: snapshotUnknown(message.content, budget),
	}));
	return {
		systemPrompt,
		messageCount: context.messages.length,
		messages,
		toolCount: context.tools?.length ?? 0,
		toolNames: context.tools?.slice(0, MAX_SNAPSHOT_TOOLS).map((tool) => tool.name) ?? [],
		truncated: budget.truncated || context.messages.length > MAX_SNAPSHOT_MESSAGES,
	};
}

function snapshotProviderPayload(payload: unknown, maxChars: number): DiagnosticData {
	const snapshot = snapshotUnknown(payload, maxChars);
	return {
		payloadChars: snapshot.originalChars,
		payloadChunks: snapshot.chunks,
		truncated: snapshot.truncated,
	};
}

type SnapshotBudget = {
	remainingChars: number;
	truncated: boolean;
};

type SnapshotText = {
	originalChars: number;
	loggedChars: number;
	chunks: string[];
	truncated: boolean;
};

function createSnapshotBudget(maxChars: number): SnapshotBudget {
	return { remainingChars: Math.max(0, Math.round(maxChars)), truncated: false };
}

function snapshotUnknown(value: unknown, maxCharsOrBudget: number | SnapshotBudget): SnapshotText {
	const budget = typeof maxCharsOrBudget === "number" ? createSnapshotBudget(maxCharsOrBudget) : maxCharsOrBudget;
	return snapshotString(stableStringify(redactSnapshotValue(value)), budget);
}

function snapshotString(value: string, budget: SnapshotBudget): SnapshotText {
	const clipped = clipText(value, budget.remainingChars);
	budget.remainingChars -= clipped.loggedChars;
	if (clipped.truncated) budget.truncated = true;
	return clipped;
}

function clipText(value: string, maxChars: number): SnapshotText {
	const limit = Math.max(0, Math.round(maxChars));
	const clipped = value.slice(0, limit);
	return {
		originalChars: value.length,
		loggedChars: clipped.length,
		chunks: chunkText(clipped),
		truncated: value.length > clipped.length,
	};
}

function chunkText(value: string): string[] {
	const chunks: string[] = [];
	for (let index = 0; index < value.length; index += SNAPSHOT_CHUNK_SIZE) {
		chunks.push(value.slice(index, index + SNAPSHOT_CHUNK_SIZE));
	}
	return chunks;
}

function redactSnapshotValue(value: unknown, key = "", depth = 0): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
	if (depth > 8) return "[max-depth]";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)
		return value;
	if (Array.isArray(value)) return value.map((item) => redactSnapshotValue(item, "", depth + 1));
	if (isRecord(value)) {
		const result: DiagnosticData = {};
		for (const [childKey, childValue] of Object.entries(value)) {
			result[childKey] = redactSnapshotValue(childValue, childKey, depth + 1);
		}
		return result;
	}
	if (value === undefined) return undefined;
	return String(value);
}

function stableStringify(value: unknown): string {
	return (
		JSON.stringify(value, (_key, item) => {
			if (!isRecord(item)) return item;
			return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
		}) ?? ""
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLoggingConfig(config: DiagnosticStreamLoggingConfig): NormalizedDiagnosticStreamLoggingConfig {
	return {
		rawProviderLoggingEnabled: config.rawProviderLoggingEnabled === true,
		rawProviderLogMaxChars: positiveInteger(config.rawProviderLogMaxChars, DEFAULT_RAW_PROVIDER_LOG_MAX_CHARS),
		promptSnapshotLoggingEnabled: config.promptSnapshotLoggingEnabled === true,
		promptSnapshotMaxChars: positiveInteger(config.promptSnapshotMaxChars, DEFAULT_PROMPT_SNAPSHOT_MAX_CHARS),
		modelOutputSnapshotLoggingEnabled: config.modelOutputSnapshotLoggingEnabled === true,
		modelOutputSnapshotMaxChars: positiveInteger(
			config.modelOutputSnapshotMaxChars,
			DEFAULT_MODEL_OUTPUT_SNAPSHOT_MAX_CHARS,
		),
	};
}

function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

function summarizeHeaders(headers: Record<string, string>): DiagnosticData {
	const result: DiagnosticData = {};
	for (const [key, value] of Object.entries(headers)) {
		result[key] = /authorization|cookie|token|key|secret/i.test(key) ? "[redacted]" : value;
	}
	return result;
}

function hostFromUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		return new URL(value).host;
	} catch {
		return undefined;
	}
}

function createDiagnosticId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: EMPTY_USAGE,
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}
