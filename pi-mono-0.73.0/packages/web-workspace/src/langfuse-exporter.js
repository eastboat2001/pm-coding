import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isObject } from "./json.js";
const OTEL_TRACES_PATH = "/api/public/otel/v1/traces";
const MAX_METADATA_STRING_LENGTH = 4000;
const MAX_METADATA_ARRAY_ITEMS = 100;
const MAX_METADATA_OBJECT_KEYS = 200;
const MAX_METADATA_DEPTH = 8;
const MAX_QUEUE_BATCHES = 100;
const REDACTED = "[redacted]";
const SENSITIVE_KEY_PATTERN = /(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;
const CONTENT_KEY_PATTERN = /(^|[-_.])(prompt|payload|messages?|content|completion|output|input|raw|chunk|chunks)([-_.]|$)/i;
const PROMPT_SNAPSHOT_EVENTS = new Set(["model.prompt.snapshot", "provider.payload.snapshot"]);
const RAW_STREAM_EVENTS = new Set([
    "provider.raw_chunk",
    "provider.raw_chunk.truncated",
    "model.stream.raw_event",
    "model.stream.raw_event.truncated",
]);
export class LangfuseDiagnosticExporter {
    config;
    flushTimer;
    flushPromise;
    lastFlushAt;
    lastError;
    queue = [];
    fetchImpl;
    constructor(config, options = {}) {
        this.config = config;
        this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    }
    status() {
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
    enqueue(events) {
        if (!this.config.langfuseEnabled)
            return;
        const batches = toOtlpTraceBatches(events, this.config);
        if (batches.length === 0)
            return;
        this.queue.push(...batches);
        this.capQueue();
        this.scheduleFlush();
    }
    async flush(signal = new AbortController().signal) {
        this.clearTimer();
        if (this.flushPromise)
            return await this.flushPromise;
        if (!this.config.langfuseEnabled || this.queue.length === 0)
            return;
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
        }
        finally {
            if (this.flushPromise === operation)
                this.flushPromise = undefined;
        }
    }
    async deliver(events, signal) {
        if (!this.config.langfuseEnabled)
            return;
        const fetchImpl = this.fetchImpl;
        if (!this.isConfigured() || !fetchImpl) {
            this.lastError = "agent_v2.langfuse_not_configured";
            throw new Error("agent_v2.langfuse_delivery_failed");
        }
        const batches = toOtlpTraceBatches(events, this.config);
        if (batches.length === 0)
            return;
        try {
            await this.sendBatches(batches, fetchImpl, signal);
        }
        catch {
            this.lastError = "agent_v2.langfuse_delivery_failed";
            throw new Error("agent_v2.langfuse_delivery_failed");
        }
    }
    async flushQueuedBatches(batches, fetchImpl, signal) {
        try {
            await this.sendBatches(batches, fetchImpl, signal);
        }
        catch {
            this.queue.unshift(...batches);
            this.capQueue();
            this.lastError = "agent_v2.langfuse_delivery_failed";
        }
        finally {
            if (this.queue.length > 0)
                this.scheduleFlush();
        }
    }
    async sendBatches(batches, fetchImpl, signal) {
        const response = await fetchImpl(this.otelEndpoint(), {
            method: "POST",
            headers: {
                Authorization: `Basic ${Buffer.from(`${this.config.langfusePublicKey}:${this.config.langfuseSecretKey}`).toString("base64")}`,
                "Content-Type": "application/json",
                "x-langfuse-ingestion-version": "4",
            },
            body: JSON.stringify(toOtlpExportRequest(batches, this.config)),
            signal,
        });
        const body = await readResponseBody(response);
        if (!response.ok || otlpPartialSuccessSummary(body.json))
            throw new Error("agent_v2.langfuse_delivery_failed");
        this.lastFlushAt = new Date().toISOString();
        this.lastError = undefined;
    }
    isConfigured() {
        return Boolean(this.config.langfuseEnabled &&
            (this.config.langfuseOtelEndpoint || this.config.langfuseHost) &&
            this.config.langfusePublicKey &&
            this.config.langfuseSecretKey);
    }
    otelEndpoint() {
        if (this.config.langfuseOtelEndpoint)
            return this.config.langfuseOtelEndpoint;
        return this.config.langfuseHost ? `${this.config.langfuseHost}${OTEL_TRACES_PATH}` : "";
    }
    scheduleFlush() {
        if (this.flushTimer || !this.isConfigured() || this.config.langfuseFlushIntervalMs <= 0)
            return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            void this.flush();
        }, this.config.langfuseFlushIntervalMs);
        this.flushTimer.unref?.();
    }
    clearTimer() {
        if (!this.flushTimer)
            return;
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
    }
    capQueue() {
        const maxQueueBatches = Math.max(this.config.langfuseBatchSize * MAX_QUEUE_BATCHES, 1000);
        if (this.queue.length <= maxQueueBatches)
            return;
        const dropped = this.queue.length - maxQueueBatches;
        this.queue.splice(0, dropped);
        this.lastError = `Dropped ${dropped} queued Langfuse OTEL trace batch(es) because the in-memory exporter queue is full.`;
    }
}
function toOtlpTraceBatches(events, config) {
    const groups = new Map();
    for (const event of events) {
        if (!shouldExportEvent(event, config))
            continue;
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
function toOtlpExportRequest(batches, config) {
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
function rootOtlpSpan(traceId, events, config) {
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
        attributes: sharedTraceAttributes(firstEvent, name, config).concat(compactAttributes([
            attribute("pi.source", "pi-diagnostics"),
            attribute("pi.first_event_type", firstEvent.eventType),
            attribute("pi.last_event_type", lastEvent.eventType),
            attribute("langfuse.observation.type", "span"),
            attribute("langfuse.observation.level", highestLangfuseLevel(events)),
        ])),
        status: statusFor(events),
    };
}
function eventOtlpSpan(event, traceId, rootSpanId, config) {
    const isGeneration = isGenerationEvent(event);
    const includeContent = shouldIncludeContent(event, config);
    const startTime = eventStartTimeUnixNano(event);
    const endTime = eventEndTimeUnixNano(event);
    return {
        traceId,
        spanId: spanIdFor(`event:${traceId}:${event.eventType}:${event.timestamp}:${event.spanId ?? event.requestId ?? ""}`),
        parentSpanId: rootSpanId,
        name: isGeneration ? generationName(event) : event.eventType,
        kind: 1,
        startTimeUnixNano: startTime,
        endTimeUnixNano: greaterNano(endTime, startTime) ? endTime : addMillis(startTime, 1),
        attributes: sharedTraceAttributes(event, traceName(event), config).concat(compactAttributes([
            attribute("langfuse.observation.type", isGeneration ? "generation" : "event"),
            attribute("langfuse.observation.level", langfuseLevel(event.level)),
            attribute("langfuse.observation.status_message", statusMessageFor(event)),
            attribute("langfuse.observation.model.name", isGeneration ? event.model : undefined),
            attribute("langfuse.observation.input", isGeneration ? JSON.stringify(requestInput(event, config)) : eventInput(event, includeContent)),
            attribute("langfuse.observation.output", isGeneration ? JSON.stringify(output(event, config) ?? {}) : eventOutput(event, includeContent)),
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
            attribute("langfuse.observation.metadata.data", JSON.stringify(sanitizeJsonObject(event.data, includeContent))),
        ])),
        status: statusFor([event]),
    };
}
function sharedTraceAttributes(event, traceNameValue, config) {
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
function shouldExportEvent(event, config) {
    if (PROMPT_SNAPSHOT_EVENTS.has(event.eventType))
        return config.langfuseExportPromptSnapshots;
    if (RAW_STREAM_EVENTS.has(event.eventType))
        return config.langfuseExportRawChunks;
    return true;
}
function shouldIncludeContent(event, config) {
    if (PROMPT_SNAPSHOT_EVENTS.has(event.eventType))
        return config.langfuseExportPromptSnapshots;
    if (RAW_STREAM_EVENTS.has(event.eventType))
        return config.langfuseExportRawChunks;
    return false;
}
function isGenerationEvent(event) {
    return (event.eventType === "model.stream.summary" ||
        event.eventType === "provider.response" ||
        event.eventType === "provider.request.error" ||
        event.eventType === "model.stream.error");
}
function traceName(event) {
    if (event.provider || event.model)
        return `PI model request: ${[event.provider, event.model].filter(Boolean).join(" / ")}`;
    return "PI diagnostic trace";
}
function generationName(event) {
    if (event.provider || event.model)
        return [event.provider, event.model].filter(Boolean).join(" / ");
    return "PI model generation";
}
function traceIdFor(event) {
    return hexFor(`trace:${event.traceId ?? event.sessionId ?? event.requestId ?? event.spanId ?? event.timestamp}`, 16);
}
function spanIdFor(seed) {
    return hexFor(seed, 8);
}
function requestInput(event, config) {
    if (config.langfuseExportPromptSnapshots) {
        const snapshot = snapshotObject(event.data.inputSnapshot);
        if (snapshot)
            return compactJsonObject({ snapshotType: snapshot.source, ...readableInputSnapshot(snapshot) });
    }
    return requestInputSummary(event);
}
function requestInputSummary(event) {
    const data = sanitizeJsonObject(event.data, false);
    return compactJsonObject({
        provider: event.provider,
        model: event.model,
        messageCount: numericValue(data.messageCount),
        toolCount: numericValue(data.toolCount),
        requestId: event.requestId,
    });
}
function output(event, config) {
    if (config.langfuseExportModelOutputSnapshots) {
        const snapshot = snapshotObject(event.data.outputSnapshot);
        if (snapshot)
            return readableOutputSnapshot(snapshot, event);
    }
    return outputSummary(event);
}
function outputSummary(event) {
    if (event.eventType !== "model.stream.summary")
        return undefined;
    const data = sanitizeJsonObject(event.data, false);
    return compactJsonObject({
        textChars: numericValue(data.textChars),
        thinkingChars: numericValue(data.thinkingChars),
        chunkCount: numericValue(data.chunkCount),
        stopReason: stringValue(data.stopReason),
        durationMs: event.durationMs,
    });
}
function eventInput(event, includeContent) {
    if (!includeContent)
        return undefined;
    if (event.eventType === "model.prompt.snapshot" || event.eventType === "provider.payload.snapshot") {
        return JSON.stringify(readableInputSnapshot(event.data));
    }
    return undefined;
}
function eventOutput(event, includeContent) {
    if (!includeContent)
        return undefined;
    if (RAW_STREAM_EVENTS.has(event.eventType))
        return JSON.stringify(sanitizeJsonObject(event.data, true));
    return undefined;
}
function snapshotObject(value) {
    return isObject(value) ? value : undefined;
}
function readableInputSnapshot(snapshot) {
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
function readableMessageSnapshot(message) {
    return compactJsonObject({
        index: numericValue(message.index),
        role: stringValue(message.role),
        content: isObject(message.content) ? snapshotText(message.content) : message.content,
    });
}
function readableOutputSnapshot(snapshot, event) {
    return compactJsonObject({
        text: joinChunks(snapshot.textChunks),
        thinking: joinChunks(snapshot.thinkingChunks),
        toolCalls: Array.isArray(snapshot.toolCalls) ? snapshot.toolCalls : undefined,
        truncated: snapshot.truncated,
        summary: outputSummary(event),
    });
}
function snapshotText(value) {
    const object = snapshotObject(value);
    return object ? joinChunks(object.chunks) : undefined;
}
function joinChunks(value) {
    if (!Array.isArray(value))
        return undefined;
    const text = value.filter((item) => typeof item === "string").join("");
    return text || undefined;
}
function statusMessageFor(event) {
    const data = event.data;
    return (stringValue(data.statusMessage) ??
        stringValue(data.message) ??
        stringValue(data.error) ??
        (event.level === "error" ? event.eventType : undefined));
}
function langfuseLevel(level) {
    if (level === "debug")
        return "DEBUG";
    if (level === "warn")
        return "WARNING";
    if (level === "error")
        return "ERROR";
    return "DEFAULT";
}
function highestLangfuseLevel(events) {
    if (events.some((event) => event.level === "error"))
        return "ERROR";
    if (events.some((event) => event.level === "warn"))
        return "WARNING";
    if (events.some((event) => event.level === "debug"))
        return "DEBUG";
    return "DEFAULT";
}
function statusFor(events) {
    const errorEvent = events.find((event) => event.level === "error");
    if (errorEvent)
        return { code: 2, ...(statusMessageFor(errorEvent) ? { message: statusMessageFor(errorEvent) } : {}) };
    return { code: 1 };
}
function eventStartTimeUnixNano(event) {
    const endTime = timestampToUnixNano(event.timestamp);
    if (isGenerationEvent(event) && event.durationMs && event.durationMs > 0)
        return addMillis(endTime, -event.durationMs);
    return endTime;
}
function eventEndTimeUnixNano(event) {
    return timestampToUnixNano(event.timestamp);
}
function timestampToUnixNano(timestamp) {
    const millis = Date.parse(timestamp);
    const safeMillis = Number.isFinite(millis) ? millis : Date.now();
    return (BigInt(safeMillis) * 1000000n).toString();
}
function addMillis(nanoTime, millis) {
    return (BigInt(nanoTime) + BigInt(millis) * 1000000n).toString();
}
function minNano(values) {
    return values.reduce((min, value) => (BigInt(value) < BigInt(min) ? value : min));
}
function maxNano(values) {
    return values.reduce((max, value) => (BigInt(value) > BigInt(max) ? value : max));
}
function greaterNano(left, right) {
    return BigInt(left) > BigInt(right);
}
function attribute(key, value) {
    if (value === undefined || value === null || value === "")
        return undefined;
    if (typeof value === "string")
        return { key, value: { stringValue: value } };
    if (typeof value === "boolean")
        return { key, value: { boolValue: value } };
    if (typeof value === "number" && Number.isFinite(value)) {
        if (Number.isInteger(value))
            return { key, value: { intValue: String(value) } };
        return { key, value: { doubleValue: value } };
    }
    if (Array.isArray(value)) {
        const values = value
            .map((item) => primitiveOtlpValue(item))
            .filter((item) => item !== undefined);
        return values.length > 0 ? { key, value: { arrayValue: { values } } } : undefined;
    }
    return { key, value: { stringValue: JSON.stringify(value) } };
}
function primitiveOtlpValue(value) {
    if (typeof value === "string")
        return { stringValue: value };
    if (typeof value === "boolean")
        return { boolValue: value };
    if (typeof value === "number" && Number.isFinite(value)) {
        if (Number.isInteger(value))
            return { intValue: String(value) };
        return { doubleValue: value };
    }
    return undefined;
}
function compactAttributes(attributes) {
    return attributes.filter((item) => item !== undefined);
}
function sanitizeJsonObject(value, includeContent) {
    const sanitized = sanitizeJsonValue(value, 0, "", includeContent);
    return isObject(sanitized) ? sanitized : {};
}
function sanitizeJsonValue(value, depth, key, includeContent) {
    if (SENSITIVE_KEY_PATTERN.test(key))
        return REDACTED;
    if (!includeContent && CONTENT_KEY_PATTERN.test(key))
        return REDACTED;
    if (depth > MAX_METADATA_DEPTH)
        return "[max-depth]";
    if (typeof value === "string")
        return truncateString(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null)
        return value;
    if (Array.isArray(value)) {
        return value
            .slice(0, MAX_METADATA_ARRAY_ITEMS)
            .map((item) => sanitizeJsonValue(item, depth + 1, key, includeContent));
    }
    if (isObject(value)) {
        const result = {};
        for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_METADATA_OBJECT_KEYS)) {
            result[childKey] = sanitizeJsonValue(childValue, depth + 1, childKey, includeContent);
        }
        return result;
    }
    if (value === undefined)
        return undefined;
    return String(value);
}
function truncateString(value) {
    if (value.length <= MAX_METADATA_STRING_LENGTH)
        return value;
    return `${value.slice(0, MAX_METADATA_STRING_LENGTH)}...[truncated ${value.length - MAX_METADATA_STRING_LENGTH} chars]`;
}
function compactJsonObject(value) {
    const result = {};
    for (const [key, childValue] of Object.entries(value)) {
        if (childValue === undefined)
            continue;
        if (isObject(childValue) && Object.keys(childValue).length === 0)
            continue;
        result[key] = childValue;
    }
    return result;
}
function numericValue(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function hexFor(seed, bytes) {
    return createHash("sha256")
        .update(seed)
        .digest("hex")
        .slice(0, bytes * 2);
}
async function readResponseBody(response) {
    const rawText = await response.text().catch(() => "");
    if (!rawText.trim())
        return { json: undefined, rawText };
    try {
        return { json: JSON.parse(rawText), rawText };
    }
    catch {
        return { json: undefined, rawText };
    }
}
function otlpPartialSuccessSummary(value) {
    if (!isObject(value))
        return undefined;
    const response = value;
    if (!response.partialSuccess)
        return undefined;
    const rejectedSpans = Number(response.partialSuccess.rejectedSpans ?? 0);
    if (!Number.isFinite(rejectedSpans) || rejectedSpans <= 0)
        return undefined;
    return `Langfuse OTEL export partially rejected ${rejectedSpans} span(s): ${response.partialSuccess.errorMessage ?? ""}`.trim();
}
//# sourceMappingURL=langfuse-exporter.js.map