const DEFAULT_CHECKPOINT_INTERVAL_MS = 400;
const DEFAULT_CHECKPOINT_MIN_CHARS = 256;
const DURABLE_RUN_EVENT_TYPES = new Set([
    "agent_start",
    "turn_start",
    "turn_end",
    "agent_retry_scheduled",
    "agent_end",
]);
export class RunEventSink {
    bus;
    checkpointIntervalMs;
    checkpointMinChars;
    checkpointStateByRun = new Map();
    messageEndKeysByRun = new Map();
    nextSeqByRun = new Map();
    now;
    store;
    constructor(options) {
        this.store = options.store;
        this.bus = options.bus;
        this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
        this.checkpointMinChars = options.checkpointMinChars ?? DEFAULT_CHECKPOINT_MIN_CHARS;
        this.now = options.now ?? (() => new Date().toISOString());
    }
    async persistAgentEvent(run, event) {
        const seq = this.nextSeq(run);
        const createdAt = this.now();
        const liveEvent = {
            eventId: 0,
            clientId: run.clientId,
            sessionId: run.sessionId,
            runId: run.runId,
            seq,
            type: event.type,
            payload: event,
            createdAt,
        };
        await this.bus.publish(liveEvent);
        if (!this.shouldPersistRunEvent(run, event, createdAt))
            return;
        await Promise.resolve(this.store.appendRunEvent({
            clientId: run.clientId,
            sessionId: run.sessionId,
            runId: run.runId,
            seq,
            type: event.type,
            payload: event,
            createdAt,
        }));
        if (event.type !== "message_end")
            return;
        const sourceMessage = isJsonObject(event.message) ? event.message : undefined;
        const message = runtimeMessageFromEvent(run, sourceMessage);
        if (!message || !this.shouldAppendMessage(run, message, sourceMessage))
            return;
        await Promise.resolve(this.store.appendMessage({
            clientId: run.clientId,
            sessionId: run.sessionId,
            role: message.role,
            payload: message.payload,
        }));
    }
    nextSeq(run) {
        const key = runKey(run);
        const seq = this.nextSeqByRun.get(key) ?? 1;
        this.nextSeqByRun.set(key, seq + 1);
        return seq;
    }
    shouldPersistRunEvent(run, event, createdAt) {
        if (event.type === "message_update")
            return this.shouldCheckpointMessageUpdate(run, event, createdAt);
        if (event.type === "message_end")
            return true;
        if (event.type.startsWith("tool_execution_"))
            return true;
        if (event.type.startsWith("agent_v2."))
            return true;
        return DURABLE_RUN_EVENT_TYPES.has(event.type);
    }
    shouldCheckpointMessageUpdate(run, event, createdAt) {
        const key = runKey(run);
        const currentTextLength = messageTextLength(isJsonObject(event.message) ? event.message : undefined);
        const currentCreatedAtMs = timestampMs(createdAt);
        const previous = this.checkpointStateByRun.get(key);
        const shouldCheckpoint = previous === undefined ||
            currentCreatedAtMs - previous.createdAtMs >= this.checkpointIntervalMs ||
            currentTextLength - previous.textLength >= this.checkpointMinChars;
        if (shouldCheckpoint) {
            this.checkpointStateByRun.set(key, { createdAtMs: currentCreatedAtMs, textLength: currentTextLength });
        }
        return shouldCheckpoint;
    }
    shouldAppendMessage(run, message, sourceMessage) {
        if (isUserPromptRole(message.role))
            return false;
        if (isAssistantFailureMarker(sourceMessage) || isAssistantFailureMarker(message.payload))
            return false;
        const key = messageKey(message);
        const messageEndKeys = this.messageEndKeysForRun(run);
        if (messageEndKeys.has(key))
            return false;
        messageEndKeys.add(key);
        return true;
    }
    messageEndKeysForRun(run) {
        const key = runKey(run);
        let messageEndKeys = this.messageEndKeysByRun.get(key);
        if (messageEndKeys === undefined) {
            messageEndKeys = new Set();
            this.messageEndKeysByRun.set(key, messageEndKeys);
        }
        return messageEndKeys;
    }
}
function runKey(run) {
    return `${run.clientId}\0${run.runId}`;
}
function runtimeMessageFromEvent(run, message) {
    if (!message)
        return undefined;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (!role)
        return undefined;
    const payload = isJsonObject(message.payload) ? message.payload : message;
    return {
        messageId: typeof message.messageId === "number" ? message.messageId : 0,
        sessionId: run.sessionId,
        clientId: run.clientId,
        role,
        payload,
        createdAt: typeof message.createdAt === "string" ? message.createdAt : new Date().toISOString(),
    };
}
function isUserPromptRole(role) {
    return role === "user" || role === "user-with-attachments";
}
function isAssistantFailureMarker(message) {
    if (!message)
        return false;
    if (assistantErrorMessageFromMessage(message))
        return true;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    return stopReason === "error";
}
function assistantErrorMessageFromMessage(message) {
    if (!message)
        return undefined;
    const role = typeof message.role === "string" ? message.role : undefined;
    if (role && role !== "assistant")
        return undefined;
    const errorMessage = message.errorMessage;
    if (typeof errorMessage === "string" && errorMessage.length > 0)
        return errorMessage;
    const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
    return stopReason === "error" ? "assistant stopped with error" : undefined;
}
function messageKey(message) {
    return JSON.stringify([message.role, message.payload]);
}
function messageTextLength(message) {
    if (!message)
        return 0;
    if (typeof message.content === "string" || Array.isArray(message.content))
        return textLength(message.content);
    if (typeof message.text === "string")
        return message.text.length;
    if (isJsonObject(message.payload))
        return messageTextLength(message.payload);
    return 0;
}
function textLength(value) {
    if (typeof value === "string")
        return value.length;
    if (Array.isArray(value)) {
        return value.reduce((total, item) => total + textLength(item), 0);
    }
    if (!isJsonObject(value))
        return 0;
    let total = 0;
    for (const key of ["text", "thinking", "content"]) {
        total += textLength(value[key]);
    }
    return total;
}
function timestampMs(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : Date.now();
}
function isJsonObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=run-event-sink.js.map