import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isObject } from "./json.js";
import type { DiagnosticLogCategory, DiagnosticLogLevel, JsonObject, StorageConfig } from "./types.js";

const OTEL_TRACES_PATH = "/api/public/otel/v1/traces";
const MAX_METADATA_STRING_LENGTH = 4000;
const MAX_METADATA_ARRAY_ITEMS = 100;
const MAX_METADATA_OBJECT_KEYS = 200;
const MAX_METADATA_DEPTH = 8;
const MAX_QUEUE_BATCHES = 100;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN =
	/(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;
const CONTENT_KEY_PATTERN =
	/(^|[-_.])(prompt|payload|messages?|content|completion|output|input|raw|chunk|chunks)([-_.]|$)/i;
const PROMPT_SNAPSHOT_EVENTS = new Set(["model.prompt.snapshot", "provider.payload.snapshot"]);
const RAW_STREAM_EVENTS = new Set([
	"provider.raw_chunk",
	"provider.raw_chunk.truncated",
	"model.stream.raw_event",
	"model.stream.raw_event.truncated",
]);

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type LangfuseDiagnosticEvent = {
	timestamp: string;
	clientId?: string;
	level: DiagnosticLogLevel;
	category: DiagnosticLogCategory;
	eventType: string;
	sessionId?: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	requestId?: string;
	provider?: string;
	model?: string;
	durationMs?: number;
	data: JsonObject;
};

export interface LangfuseExporterStatus extends JsonObject {
	langfuseEnabled: boolean;
	langfuseConfigured: boolean;
	langfuseHost: string;
	langfuseOtelEndpoint: string;
	langfuseQueuedEvents: number;
	langfuseLastFlushAt?: string;
	langfuseLastError?: string;
	langfuseExportPromptSnapshots: boolean;
	langfuseExportModelOutputSnapshots: boolean;
	langfuseExportRawChunks: boolean;
	otelServiceName: string;
	otelDeploymentEnvironment: string;
}

type OtlpValue =
	| { stringValue: string }
	| { boolValue: boolean }
	| { intValue: string }
	| { doubleValue: number }
	| { arrayValue: { values: OtlpValue[] } };

type OtlpAttribute = {
	key: string;
	value: OtlpValue;
};

type OtlpSpan = {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: OtlpAttribute[];
	status?: {
		code: number;
		message?: string;
	};
};

type OtlpTraceBatch = {
	spans: OtlpSpan[];
};

type OtlpResponse = {
	partialSuccess?: {
		rejectedSpans?: string | number;
		errorMessage?: string;
	};
};

export class LangfuseDiagnosticExporter {
	private flushTimer: NodeJS.Timeout | undefined;
	private flushPromise: Promise<void> | undefined;
	private lastFlushAt: string | undefined;
	private lastError: string | undefined;
	private queue: OtlpTraceBatch[] = [];
	private readonly fetchImpl: FetchLike | undefined;

	constructor(
		private readonly config: StorageConfig,
		options: { fetch?: FetchLike } = {},
	) {
		this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
	}

	status(): LangfuseExporterStatus {
		return {
			langfuseEnabled: this.config.langfuseEnabled,
			langfuseConfigured: this.isConfigured(),
			langfuseHost: this.config.langfuseHost,
			langfuseOtelEndpoint: this.otelEndpoint(),
			langfuseQueuedEvents: this.queue.reduce((total, batch) => total + batch.spans.length, 0),
			...(this.lastFlushAt ? { langfuseLastFlushAt: this.lastFlushAt } : {}),
			...(this.lastError ? { langfuseLastError: this.lastError } : {}),
			langfuseExportPromptSnapshots: this.config.langfuseExportPromptSnapshots,
			langfuseExportModelOutputSnapshots: this.config.langfuseExportModelOutputSnapshots,
			langfuseExportRawChunks: this.config.langfuseExportRawChunks,
			otelServiceName: this.config.otelServiceName,
			otelDeploymentEnvironment: this.config.otelDeploymentEnvironment,
		};
	}

	enqueue(events: LangfuseDiagnosticEvent[]): void {
		if (!this.config.langfuseEnabled) return;
		const batches = toOtlpTraceBatches(events, this.config);
		if (batches.length === 0) return;
		this.queue.push(...batches);
		this.capQueue();
		this.scheduleFlush();
	}

	async flush(signal: AbortSignal = new AbortController().signal): Promise<void> {
		this.clearTimer();
		if (this.flushPromise) return await this.flushPromise;
		if (!this.config.langfuseEnabled || this.queue.length === 0) return;
		const fetchImpl = this.fetchImpl;
		if (!this.isConfigured() || !fetchImpl) {
			this.lastError = "agent_v2.langfuse_not_configured";
			return;
		}

		const batches = this.queue.splice(0, this.config.langfuseBatchSize);
		const operation = this.flushQueuedBatches(batches, fetchImpl, signal);
		this.flushPromise = operation;
		try {
			await operation;
		} finally {
			if (this.flushPromise === operation) this.flushPromise = undefined;
		}
	}

	async deliver(events: LangfuseDiagnosticEvent[], signal: AbortSignal): Promise<void> {
		if (!this.config.langfuseEnabled) return;
		const fetchImpl = this.fetchImpl;
		if (!this.isConfigured() || !fetchImpl) {
			this.lastError = "agent_v2.langfuse_not_configured";
			throw new Error("agent_v2.langfuse_delivery_failed");
		}
		const batches = toOtlpTraceBatches(events, this.config);
		if (batches.length === 0) return;
		try {
			await this.sendBatches(batches, fetchImpl, signal);
		} catch {
			this.lastError = "agent_v2.langfuse_delivery_failed";
			throw new Error("agent_v2.langfuse_delivery_failed");
		}
	}

	private async flushQueuedBatches(
		batches: OtlpTraceBatch[],
		fetchImpl: FetchLike,
		signal: AbortSignal,
	): Promise<void> {
		try {
			await this.sendBatches(batches, fetchImpl, signal);
		} catch {
			this.queue.unshift(...batches);
			this.capQueue();
			this.lastError = "agent_v2.langfuse_delivery_failed";
		} finally {
			if (this.queue.length > 0) this.scheduleFlush();
		}
	}

	private async sendBatches(batches: OtlpTraceBatch[], fetchImpl: FetchLike, signal: AbortSignal): Promise<void> {
		const response = await fetchImpl(this.otelEndpoint(), {
			method: "POST",
			headers: {
				Authorization: `Basic ${Buffer.from(
					`${this.config.langfusePublicKey}:${this.config.langfuseSecretKey}`,
				).toString("base64")}`,
				"Content-Type": "application/json",
				"x-langfuse-ingestion-version": "4",
			},
			body: JSON.stringify(toOtlpExportRequest(batches, this.config)),
			signal,
		});
		const body = await readResponseBody(response);
		if (!response.ok || otlpPartialSuccessSummary(body.json)) throw new Error("agent_v2.langfuse_delivery_failed");
		this.lastFlushAt = new Date().toISOString();
		this.lastError = undefined;
	}

	private isConfigured(): boolean {
		return Boolean(
			this.config.langfuseEnabled &&
				(this.config.langfuseOtelEndpoint || this.config.langfuseHost) &&
				this.config.langfusePublicKey &&
				this.config.langfuseSecretKey,
		);
	}

	private otelEndpoint(): string {
		if (this.config.langfuseOtelEndpoint) return this.config.langfuseOtelEndpoint;
		return this.config.langfuseHost ? `${this.config.langfuseHost}${OTEL_TRACES_PATH}` : "";
	}

	private scheduleFlush(): void {
		if (this.flushTimer || !this.isConfigured() || this.config.langfuseFlushIntervalMs <= 0) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, this.config.langfuseFlushIntervalMs);
		this.flushTimer.unref?.();
	}

	private clearTimer(): void {
		if (!this.flushTimer) return;
		clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
	}

	private capQueue(): void {
		const maxQueueBatches = Math.max(this.config.langfuseBatchSize * MAX_QUEUE_BATCHES, 1000);
		if (this.queue.length <= maxQueueBatches) return;
		const dropped = this.queue.length - maxQueueBatches;
		this.queue.splice(0, dropped);
		this.lastError = `Dropped ${dropped} queued Langfuse OTEL trace batch(es) because the in-memory exporter queue is full.`;
	}
}

function toOtlpTraceBatches(events: LangfuseDiagnosticEvent[], config: StorageConfig): OtlpTraceBatch[] {
	const groups = new Map<string, LangfuseDiagnosticEvent[]>();
	for (const event of events) {
		if (!shouldExportEvent(event, config)) continue;
		const traceId = traceIdFor(event);
		groups.set(traceId, [...(groups.get(traceId) ?? []), event]);
	}

	return Array.from(groups.entries()).map(([traceId, traceEvents]) => {
		const rootSpan = rootOtlpSpan(traceId, traceEvents, config);
		return {
			spans: [rootSpan, ...traceEvents.map((event) => eventOtlpSpan(event, traceId, rootSpan.spanId, config))],
		};
	});
}

function toOtlpExportRequest(batches: OtlpTraceBatch[], config: StorageConfig): JsonObject {
	return {
		resourceSpans: [
			{
				resource: {
					attributes: compactAttributes([
						attribute("service.name", config.otelServiceName),
						attribute("telemetry.sdk.name", "pi-diagnostic-logger"),
						attribute("telemetry.sdk.language", "nodejs"),
						attribute("telemetry.sdk.version", "0.73.0"),
						attribute("deployment.environment.name", config.otelDeploymentEnvironment || undefined),
						attribute("langfuse.environment", config.otelDeploymentEnvironment || undefined),
					]),
				},
				scopeSpans: [
					{
						scope: {
							name: "pi-diagnostic-logger",
							version: "0.73.0",
						},
						spans: batches.flatMap((batch) => batch.spans),
					},
				],
			},
		],
	};
}

function rootOtlpSpan(traceId: string, events: LangfuseDiagnosticEvent[], config: StorageConfig): OtlpSpan {
	const startTime = minNano(events.map(eventStartTimeUnixNano));
	const endTime = maxNano(events.map(eventEndTimeUnixNano));
	const firstEvent = events[0];
	const lastEvent = events[events.length - 1];
	const name = traceName(firstEvent);
	return {
		traceId,
		spanId: spanIdFor(`root:${traceId}`),
		name,
		kind: 1,
		startTimeUnixNano: startTime,
		endTimeUnixNano: greaterNano(endTime, startTime) ? endTime : addMillis(startTime, 1),
		attributes: sharedTraceAttributes(firstEvent, name, config).concat(
			compactAttributes([
				attribute("pi.source", "pi-diagnostics"),
				attribute("pi.first_event_type", firstEvent.eventType),
				attribute("pi.last_event_type", lastEvent.eventType),
				attribute("langfuse.observation.type", "span"),
				attribute("langfuse.observation.level", highestLangfuseLevel(events)),
			]),
		),
		status: statusFor(events),
	};
}

function eventOtlpSpan(
	event: LangfuseDiagnosticEvent,
	traceId: string,
	rootSpanId: string,
	config: StorageConfig,
): OtlpSpan {
	const isGeneration = isGenerationEvent(event);
	const includeContent = shouldIncludeContent(event, config);
	const startTime = eventStartTimeUnixNano(event);
	const endTime = eventEndTimeUnixNano(event);
	return {
		traceId,
		spanId: spanIdFor(
			`event:${traceId}:${event.eventType}:${event.timestamp}:${event.spanId ?? event.requestId ?? ""}`,
		),
		parentSpanId: rootSpanId,
		name: isGeneration ? generationName(event) : event.eventType,
		kind: 1,
		startTimeUnixNano: startTime,
		endTimeUnixNano: greaterNano(endTime, startTime) ? endTime : addMillis(startTime, 1),
		attributes: sharedTraceAttributes(event, traceName(event), config).concat(
			compactAttributes([
				attribute("langfuse.observation.type", isGeneration ? "generation" : "event"),
				attribute("langfuse.observation.level", langfuseLevel(event.level)),
				attribute("langfuse.observation.status_message", statusMessageFor(event)),
				attribute("langfuse.observation.model.name", isGeneration ? event.model : undefined),
				attribute(
					"langfuse.observation.input",
					isGeneration ? JSON.stringify(requestInput(event, config)) : eventInput(event, includeContent),
				),
				attribute(
					"langfuse.observation.output",
					isGeneration ? JSON.stringify(output(event, config) ?? {}) : eventOutput(event, includeContent),
				),
				attribute("gen_ai.system", event.provider),
				attribute("gen_ai.request.model", isGeneration ? event.model : undefined),
				attribute("gen_ai.response.model", isGeneration ? event.model : undefined),
				attribute("pi.category", event.category),
				attribute("pi.event_type", event.eventType),
				attribute("pi.level", event.level),
				attribute("pi.provider", event.provider),
				attribute("pi.model", event.model),
				attribute("pi.duration_ms", event.durationMs),
				attribute("pi.request_id", event.requestId),
				attribute("pi.span_id", event.spanId),
				attribute("pi.parent_span_id", event.parentSpanId),
				attribute("langfuse.observation.metadata.category", event.category),
				attribute("langfuse.observation.metadata.event_type", event.eventType),
				attribute("langfuse.observation.metadata.request_id", event.requestId),
				attribute(
					"langfuse.observation.metadata.data",
					JSON.stringify(sanitizeJsonObject(event.data, includeContent)),
				),
			]),
		),
		status: statusFor([event]),
	};
}

function sharedTraceAttributes(
	event: LangfuseDiagnosticEvent,
	traceNameValue: string,
	config: StorageConfig,
): OtlpAttribute[] {
	return compactAttributes([
		attribute("langfuse.trace.name", traceNameValue),
		attribute("langfuse.session.id", event.sessionId),
		attribute("session.id", event.sessionId),
		attribute("langfuse.environment", config.otelDeploymentEnvironment || undefined),
		attribute("deployment.environment.name", config.otelDeploymentEnvironment || undefined),
		attribute("langfuse.trace.metadata.pi_trace_id", event.traceId),
		attribute("langfuse.trace.metadata.pi_request_id", event.requestId),
		attribute("langfuse.trace.metadata.pi_client_id", event.clientId),
		attribute("langfuse.trace.metadata.provider", event.provider),
		attribute("langfuse.trace.metadata.model", event.model),
		attribute("pi.client_id", event.clientId),
		attribute("pi.trace_id", event.traceId),
	]);
}

function shouldExportEvent(event: LangfuseDiagnosticEvent, config: StorageConfig): boolean {
	if (PROMPT_SNAPSHOT_EVENTS.has(event.eventType)) return config.langfuseExportPromptSnapshots;
	if (RAW_STREAM_EVENTS.has(event.eventType)) return config.langfuseExportRawChunks;
	return true;
}

function shouldIncludeContent(event: LangfuseDiagnosticEvent, config: StorageConfig): boolean {
	if (PROMPT_SNAPSHOT_EVENTS.has(event.eventType)) return config.langfuseExportPromptSnapshots;
	if (RAW_STREAM_EVENTS.has(event.eventType)) return config.langfuseExportRawChunks;
	return false;
}

function isGenerationEvent(event: LangfuseDiagnosticEvent): boolean {
	return (
		event.eventType === "model.stream.summary" ||
		event.eventType === "provider.response" ||
		event.eventType === "provider.request.error" ||
		event.eventType === "model.stream.error"
	);
}

function traceName(event: LangfuseDiagnosticEvent): string {
	if (event.provider || event.model)
		return `PI model request: ${[event.provider, event.model].filter(Boolean).join(" / ")}`;
	return "PI diagnostic trace";
}

function generationName(event: LangfuseDiagnosticEvent): string {
	if (event.provider || event.model) return [event.provider, event.model].filter(Boolean).join(" / ");
	return "PI model generation";
}

function traceIdFor(event: LangfuseDiagnosticEvent): string {
	return hexFor(`trace:${event.traceId ?? event.sessionId ?? event.requestId ?? event.spanId ?? event.timestamp}`, 16);
}

function spanIdFor(seed: string): string {
	return hexFor(seed, 8);
}

function requestInput(event: LangfuseDiagnosticEvent, config: StorageConfig): JsonObject {
	if (config.langfuseExportPromptSnapshots) {
		const snapshot = snapshotObject(event.data.inputSnapshot);
		if (snapshot) return compactJsonObject({ snapshotType: snapshot.source, ...readableInputSnapshot(snapshot) });
	}
	return requestInputSummary(event);
}

function requestInputSummary(event: LangfuseDiagnosticEvent): JsonObject {
	const data = sanitizeJsonObject(event.data, false);
	return compactJsonObject({
		provider: event.provider,
		model: event.model,
		messageCount: numericValue(data.messageCount),
		toolCount: numericValue(data.toolCount),
		requestId: event.requestId,
	});
}

function output(event: LangfuseDiagnosticEvent, config: StorageConfig): JsonObject | undefined {
	if (config.langfuseExportModelOutputSnapshots) {
		const snapshot = snapshotObject(event.data.outputSnapshot);
		if (snapshot) return readableOutputSnapshot(snapshot, event);
	}
	return outputSummary(event);
}

function outputSummary(event: LangfuseDiagnosticEvent): JsonObject | undefined {
	if (event.eventType !== "model.stream.summary") return undefined;
	const data = sanitizeJsonObject(event.data, false);
	return compactJsonObject({
		textChars: numericValue(data.textChars),
		thinkingChars: numericValue(data.thinkingChars),
		chunkCount: numericValue(data.chunkCount),
		stopReason: stringValue(data.stopReason),
		durationMs: event.durationMs,
	});
}

function eventInput(event: LangfuseDiagnosticEvent, includeContent: boolean): string | undefined {
	if (!includeContent) return undefined;
	if (event.eventType === "model.prompt.snapshot" || event.eventType === "provider.payload.snapshot") {
		return JSON.stringify(readableInputSnapshot(event.data));
	}
	return undefined;
}

function eventOutput(event: LangfuseDiagnosticEvent, includeContent: boolean): string | undefined {
	if (!includeContent) return undefined;
	if (RAW_STREAM_EVENTS.has(event.eventType)) return JSON.stringify(sanitizeJsonObject(event.data, true));
	return undefined;
}

function snapshotObject(value: unknown): JsonObject | undefined {
	return isObject(value) ? value : undefined;
}

function readableInputSnapshot(snapshot: JsonObject): JsonObject {
	return compactJsonObject({
		systemPrompt: snapshotText(snapshot.systemPrompt),
		messages: Array.isArray(snapshot.messages)
			? snapshot.messages.map((message) => (isObject(message) ? readableMessageSnapshot(message) : message))
			: undefined,
		payload: joinChunks(snapshot.payloadChunks),
		toolNames: Array.isArray(snapshot.toolNames) ? snapshot.toolNames : undefined,
		messageCount: numericValue(snapshot.messageCount),
		toolCount: numericValue(snapshot.toolCount),
		truncated: snapshot.truncated,
	});
}

function readableMessageSnapshot(message: JsonObject): JsonObject {
	return compactJsonObject({
		index: numericValue(message.index),
		role: stringValue(message.role),
		content: isObject(message.content) ? snapshotText(message.content) : message.content,
	});
}

function readableOutputSnapshot(snapshot: JsonObject, event: LangfuseDiagnosticEvent): JsonObject {
	return compactJsonObject({
		text: joinChunks(snapshot.textChunks),
		thinking: joinChunks(snapshot.thinkingChunks),
		toolCalls: Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : undefined,
		truncated: snapshot.truncated,
		summary: outputSummary(event),
	});
}

function snapshotText(value: unknown): string | undefined {
	const object = snapshotObject(value);
	return object ? joinChunks(object.chunks) : undefined;
}

function joinChunks(value: unknown): string | undefined {
	if (!Array.isArray(value)) return undefined;
	const text = value.filter((item): item is string => typeof item === "string").join("");
	return text || undefined;
}

function statusMessageFor(event: LangfuseDiagnosticEvent): string | undefined {
	const data = event.data;
	return (
		stringValue(data.statusMessage) ??
		stringValue(data.message) ??
		stringValue(data.error) ??
		(event.level === "error" ? event.eventType : undefined)
	);
}

function langfuseLevel(level: DiagnosticLogLevel): string {
	if (level === "debug") return "DEBUG";
	if (level === "warn") return "WARNING";
	if (level === "error") return "ERROR";
	return "DEFAULT";
}

function highestLangfuseLevel(events: LangfuseDiagnosticEvent[]): string {
	if (events.some((event) => event.level === "error")) return "ERROR";
	if (events.some((event) => event.level === "warn")) return "WARNING";
	if (events.some((event) => event.level === "debug")) return "DEBUG";
	return "DEFAULT";
}

function statusFor(events: LangfuseDiagnosticEvent[]): OtlpSpan["status"] {
	const errorEvent = events.find((event) => event.level === "error");
	if (errorEvent)
		return { code: 2, ...(statusMessageFor(errorEvent) ? { message: statusMessageFor(errorEvent) } : {}) };
	return { code: 1 };
}

function eventStartTimeUnixNano(event: LangfuseDiagnosticEvent): string {
	const endTime = timestampToUnixNano(event.timestamp);
	if (isGenerationEvent(event) && event.durationMs && event.durationMs > 0)
		return addMillis(endTime, -event.durationMs);
	return endTime;
}

function eventEndTimeUnixNano(event: LangfuseDiagnosticEvent): string {
	return timestampToUnixNano(event.timestamp);
}

function timestampToUnixNano(timestamp: string): string {
	const millis = Date.parse(timestamp);
	const safeMillis = Number.isFinite(millis) ? millis : Date.now();
	return (BigInt(safeMillis) * 1_000_000n).toString();
}

function addMillis(nanoTime: string, millis: number): string {
	return (BigInt(nanoTime) + BigInt(millis) * 1_000_000n).toString();
}

function minNano(values: string[]): string {
	return values.reduce((min, value) => (BigInt(value) < BigInt(min) ? value : min));
}

function maxNano(values: string[]): string {
	return values.reduce((max, value) => (BigInt(value) > BigInt(max) ? value : max));
}

function greaterNano(left: string, right: string): boolean {
	return BigInt(left) > BigInt(right);
}

function attribute(key: string, value: unknown): OtlpAttribute | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value === "string") return { key, value: { stringValue: value } };
	if (typeof value === "boolean") return { key, value: { boolValue: value } };
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value)) return { key, value: { intValue: String(value) } };
		return { key, value: { doubleValue: value } };
	}
	if (Array.isArray(value)) {
		const values = value
			.map((item) => primitiveOtlpValue(item))
			.filter((item): item is OtlpValue => item !== undefined);
		return values.length > 0 ? { key, value: { arrayValue: { values } } } : undefined;
	}
	return { key, value: { stringValue: JSON.stringify(value) } };
}

function primitiveOtlpValue(value: unknown): OtlpValue | undefined {
	if (typeof value === "string") return { stringValue: value };
	if (typeof value === "boolean") return { boolValue: value };
	if (typeof value === "number" && Number.isFinite(value)) {
		if (Number.isInteger(value)) return { intValue: String(value) };
		return { doubleValue: value };
	}
	return undefined;
}

function compactAttributes(attributes: (OtlpAttribute | undefined)[]): OtlpAttribute[] {
	return attributes.filter((item): item is OtlpAttribute => item !== undefined);
}

function sanitizeJsonObject(value: JsonObject, includeContent: boolean): JsonObject {
	const sanitized = sanitizeJsonValue(value, 0, "", includeContent);
	return isObject(sanitized) ? sanitized : {};
}

function sanitizeJsonValue(value: unknown, depth: number, key: string, includeContent: boolean): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return REDACTED;
	if (!includeContent && CONTENT_KEY_PATTERN.test(key)) return REDACTED;
	if (depth > MAX_METADATA_DEPTH) return "[max-depth]";
	if (typeof value === "string") return truncateString(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value
			.slice(0, MAX_METADATA_ARRAY_ITEMS)
			.map((item) => sanitizeJsonValue(item, depth + 1, key, includeContent));
	}
	if (isObject(value)) {
		const result: JsonObject = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_METADATA_OBJECT_KEYS)) {
			result[childKey] = sanitizeJsonValue(childValue, depth + 1, childKey, includeContent);
		}
		return result;
	}
	if (value === undefined) return undefined;
	return String(value);
}

function truncateString(value: string): string {
	if (value.length <= MAX_METADATA_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...[truncated ${value.length - MAX_METADATA_STRING_LENGTH} chars]`;
}

function compactJsonObject(value: Record<string, unknown>): JsonObject {
	const result: JsonObject = {};
	for (const [key, childValue] of Object.entries(value)) {
		if (childValue === undefined) continue;
		if (isObject(childValue) && Object.keys(childValue).length === 0) continue;
		result[key] = childValue;
	}
	return result;
}

function numericValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function hexFor(seed: string, bytes: number): string {
	return createHash("sha256")
		.update(seed)
		.digest("hex")
		.slice(0, bytes * 2);
}

async function readResponseBody(response: Response): Promise<{ json: unknown; rawText: string }> {
	const rawText = await response.text().catch(() => "");
	if (!rawText.trim()) return { json: undefined, rawText };
	try {
		return { json: JSON.parse(rawText) as unknown, rawText };
	} catch {
		return { json: undefined, rawText };
	}
}

function otlpPartialSuccessSummary(value: unknown): string | undefined {
	if (!isObject(value)) return undefined;
	const response = value as OtlpResponse;
	if (!response.partialSuccess) return undefined;
	const rejectedSpans = Number(response.partialSuccess.rejectedSpans ?? 0);
	if (!Number.isFinite(rejectedSpans) || rejectedSpans <= 0) return undefined;
	return `Langfuse OTEL export partially rejected ${rejectedSpans} span(s): ${response.partialSuccess.errorMessage ?? ""}`.trim();
}
