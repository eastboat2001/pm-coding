import type { RunEventBus } from "./run-event-bus.js";
import type {
	AppendMessageInput,
	AppendRunEventInput,
	JsonObject,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
} from "./types.js";

const DEFAULT_CHECKPOINT_INTERVAL_MS = 400;
const DEFAULT_CHECKPOINT_MIN_CHARS = 256;
const DURABLE_RUN_EVENT_TYPES = new Set([
	"agent_start",
	"turn_start",
	"turn_end",
	"agent_retry_scheduled",
	"agent_end",
]);

export interface RunEventSinkAgentEvent extends JsonObject {
	type: string;
	message?: JsonObject | string;
	messages?: JsonObject[];
}

export interface RunEventSinkStore {
	appendRunEvent(input: AppendRunEventInput): unknown;
	appendMessage(input: AppendMessageInput): unknown;
}

export interface RunEventSinkOptions {
	store: RunEventSinkStore;
	bus: RunEventBus;
	checkpointIntervalMs?: number;
	checkpointMinChars?: number;
	now?: () => string;
}

type MessageCheckpoint = {
	createdAtMs: number;
	textLength: number;
};

export class RunEventSink {
	private readonly bus: RunEventBus;
	private readonly checkpointIntervalMs: number;
	private readonly checkpointMinChars: number;
	private readonly checkpointStateByRun = new Map<string, MessageCheckpoint>();
	private readonly messageEndKeysByRun = new Map<string, Set<string>>();
	private readonly nextSeqByRun = new Map<string, number>();
	private readonly now: () => string;
	private readonly store: RunEventSinkStore;

	constructor(options: RunEventSinkOptions) {
		this.store = options.store;
		this.bus = options.bus;
		this.checkpointIntervalMs = options.checkpointIntervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
		this.checkpointMinChars = options.checkpointMinChars ?? DEFAULT_CHECKPOINT_MIN_CHARS;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	async persistAgentEvent(run: RuntimeRunRecord, event: RunEventSinkAgentEvent): Promise<void> {
		const seq = this.nextSeq(run);
		const createdAt = this.now();
		const liveEvent: RuntimeRunEventRecord = {
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
		if (!this.shouldPersistRunEvent(run, event, createdAt)) return;

		await Promise.resolve(
			this.store.appendRunEvent({
				clientId: run.clientId,
				sessionId: run.sessionId,
				runId: run.runId,
				seq,
				type: event.type,
				payload: event,
				createdAt,
			}),
		);

		if (event.type !== "message_end") return;
		const sourceMessage = isJsonObject(event.message) ? event.message : undefined;
		const message = runtimeMessageFromEvent(run, sourceMessage);
		if (!message || !this.shouldAppendMessage(run, message, sourceMessage)) return;
		await Promise.resolve(
			this.store.appendMessage({
				clientId: run.clientId,
				sessionId: run.sessionId,
				role: message.role,
				payload: message.payload,
			}),
		);
	}

	private nextSeq(run: RuntimeRunRecord): number {
		const key = runKey(run);
		const seq = this.nextSeqByRun.get(key) ?? 1;
		this.nextSeqByRun.set(key, seq + 1);
		return seq;
	}

	private shouldPersistRunEvent(run: RuntimeRunRecord, event: RunEventSinkAgentEvent, createdAt: string): boolean {
		if (event.type === "message_update") return this.shouldCheckpointMessageUpdate(run, event, createdAt);
		if (event.type === "message_end") return true;
		if (event.type.startsWith("tool_execution_")) return true;
		return DURABLE_RUN_EVENT_TYPES.has(event.type);
	}

	private shouldCheckpointMessageUpdate(run: RuntimeRunRecord, event: RunEventSinkAgentEvent, createdAt: string): boolean {
		const key = runKey(run);
		const currentTextLength = messageTextLength(isJsonObject(event.message) ? event.message : undefined);
		const currentCreatedAtMs = timestampMs(createdAt);
		const previous = this.checkpointStateByRun.get(key);
		const shouldCheckpoint =
			previous === undefined ||
			currentCreatedAtMs - previous.createdAtMs >= this.checkpointIntervalMs ||
			currentTextLength - previous.textLength >= this.checkpointMinChars;

		if (shouldCheckpoint) {
			this.checkpointStateByRun.set(key, { createdAtMs: currentCreatedAtMs, textLength: currentTextLength });
		}
		return shouldCheckpoint;
	}

	private shouldAppendMessage(
		run: RuntimeRunRecord,
		message: RuntimeMessageRecord,
		sourceMessage: JsonObject | undefined,
	): boolean {
		if (isUserPromptRole(message.role)) return false;
		if (isAssistantFailureMarker(sourceMessage) || isAssistantFailureMarker(message.payload)) return false;
		const key = messageKey(message);
		const messageEndKeys = this.messageEndKeysForRun(run);
		if (messageEndKeys.has(key)) return false;
		messageEndKeys.add(key);
		return true;
	}

	private messageEndKeysForRun(run: RuntimeRunRecord): Set<string> {
		const key = runKey(run);
		let messageEndKeys = this.messageEndKeysByRun.get(key);
		if (messageEndKeys === undefined) {
			messageEndKeys = new Set();
			this.messageEndKeysByRun.set(key, messageEndKeys);
		}
		return messageEndKeys;
	}
}

function runKey(run: Pick<RuntimeRunRecord, "clientId" | "runId">): string {
	return `${run.clientId}\0${run.runId}`;
}

function runtimeMessageFromEvent(
	run: RuntimeRunRecord,
	message: JsonObject | undefined,
): RuntimeMessageRecord | undefined {
	if (!message) return undefined;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (!role) return undefined;
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

function isUserPromptRole(role: string): boolean {
	return role === "user" || role === "user-with-attachments";
}

function isAssistantFailureMarker(message: JsonObject | undefined): boolean {
	if (!message) return false;
	if (assistantErrorMessageFromMessage(message)) return true;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return stopReason === "error";
}

function assistantErrorMessageFromMessage(message: JsonObject | undefined): string | undefined {
	if (!message) return undefined;
	const role = typeof message.role === "string" ? message.role : undefined;
	if (role && role !== "assistant") return undefined;
	const errorMessage = message.errorMessage;
	if (typeof errorMessage === "string" && errorMessage.length > 0) return errorMessage;
	const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
	return stopReason === "error" ? "assistant stopped with error" : undefined;
}

function messageKey(message: RuntimeMessageRecord): string {
	return JSON.stringify([message.role, message.payload]);
}

function messageTextLength(message: JsonObject | undefined): number {
	if (!message) return 0;
	if (typeof message.content === "string" || Array.isArray(message.content)) return textLength(message.content);
	if (typeof message.text === "string") return message.text.length;
	if (isJsonObject(message.payload)) return messageTextLength(message.payload);
	return 0;
}

function textLength(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value)) {
		return value.reduce((total, item) => total + textLength(item), 0);
	}
	if (!isJsonObject(value)) return 0;
	let total = 0;
	for (const key of ["text", "thinking", "content"]) {
		total += textLength(value[key]);
	}
	return total;
}

function timestampMs(value: string): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
