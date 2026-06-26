export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticLogCategory =
	| "agent"
	| "handoff"
	| "model"
	| "project"
	| "provider"
	| "skill"
	| "storage"
	| "system"
	| "tool";

export type DiagnosticData = Record<string, unknown>;

export type DiagnosticEvent = {
	timestamp?: string;
	level?: DiagnosticLogLevel;
	category?: DiagnosticLogCategory;
	eventType: string;
	sessionId?: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	requestId?: string;
	provider?: string;
	model?: string;
	durationMs?: number;
	data?: DiagnosticData;
};

export type DiagnosticClient = {
	write(event: DiagnosticEvent): void;
	writeMany(events: DiagnosticEvent[]): void;
	flush(): Promise<void>;
};

export type DiagnosticClientOptions = {
	endpoint?: string;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	headers?: () => Record<string, string>;
	maxBatchSize?: number;
};

const DEFAULT_ENDPOINT = "/api/pi-logs/events";
const DEFAULT_BATCH_SIZE = 25;
const MAX_STRING_LENGTH = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const SENSITIVE_KEY_PATTERN =
	/(^|[-_.])(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|cookie|password|secret|credential|bearer)([-_.]|$)/i;

export function createDiagnosticClient(options: DiagnosticClientOptions = {}): DiagnosticClient {
	return new QueuedDiagnosticClient(options);
}

export function summarizeProviderPayload(payload: unknown): DiagnosticData {
	if (!isRecord(payload)) return { payloadType: typeof payload };
	const summary: DiagnosticData = {};
	for (const [key, value] of Object.entries(payload).slice(0, MAX_OBJECT_KEYS)) {
		if (key === "messages" && Array.isArray(value)) {
			summary.messageCount = value.length;
			summary.messages = value.slice(0, MAX_ARRAY_ITEMS).map(summarizeMessage);
			continue;
		}
		if (key === "tools" && Array.isArray(value)) {
			summary.toolCount = value.length;
			summary.toolNames = value
				.slice(0, MAX_ARRAY_ITEMS)
				.map(toolName)
				.filter((name) => name.length > 0);
			continue;
		}
		summary[key] = sanitizeDiagnosticValue(value, key, 0);
	}
	return summary;
}

export function sanitizeDiagnosticData(data: DiagnosticData): DiagnosticData {
	const sanitized = sanitizeDiagnosticValue(data, "", 0);
	return isRecord(sanitized) ? sanitized : {};
}

class QueuedDiagnosticClient implements DiagnosticClient {
	private readonly endpoint: string;
	private readonly fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly headers: () => Record<string, string>;
	private readonly maxBatchSize: number;
	private queue: DiagnosticEvent[] = [];
	private flushTimer: ReturnType<typeof setTimeout> | undefined;
	private flushing: Promise<void> | undefined;

	constructor(options: DiagnosticClientOptions) {
		this.endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
		this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
		this.headers = options.headers ?? (() => ({}));
		this.maxBatchSize = options.maxBatchSize ?? DEFAULT_BATCH_SIZE;
	}

	write(event: DiagnosticEvent): void {
		this.writeMany([event]);
	}

	writeMany(events: DiagnosticEvent[]): void {
		if (events.length === 0) return;
		this.queue.push(
			...events.map((event) => ({ ...event, data: event.data ? sanitizeDiagnosticData(event.data) : {} })),
		);
		this.scheduleFlush();
	}

	async flush(): Promise<void> {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		if (this.flushing) {
			await this.flushing;
		}
		if (this.queue.length === 0) return;
		const batch = this.queue.splice(0, this.maxBatchSize);
		this.flushing = this.postBatch(batch).finally(() => {
			this.flushing = undefined;
		});
		await this.flushing;
		if (this.queue.length > 0) await this.flush();
	}

	private scheduleFlush(): void {
		if (this.flushTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, 100);
	}

	private async postBatch(events: DiagnosticEvent[]): Promise<void> {
		try {
			await this.fetchFn(this.endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...this.headers() },
				body: JSON.stringify({ events }),
			});
		} catch {
			// Diagnostics must never break the main PI interaction.
		}
	}
}

function summarizeMessage(value: unknown): DiagnosticData {
	if (!isRecord(value)) return { role: "unknown", contentSummary: typeof value };
	const role = typeof value.role === "string" ? value.role : "unknown";
	return {
		role,
		contentSummary: summarizeContent(value.content),
	};
}

function summarizeContent(content: unknown): string {
	if (typeof content === "string") return `string:${content.length}`;
	if (Array.isArray(content)) return `array:${content.length}`;
	if (isRecord(content)) return `object:${Object.keys(content).length}`;
	if (content === undefined || content === null) return "empty";
	return typeof content;
}

function toolName(value: unknown): string {
	return isRecord(value) && typeof value.name === "string" ? value.name : "";
}

function sanitizeDiagnosticValue(value: unknown, key: string, depth: number): unknown {
	if (SENSITIVE_KEY_PATTERN.test(key)) return "[redacted]";
	if (depth > 8) return "[max-depth]";
	if (typeof value === "string") return truncate(value);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) {
		return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeDiagnosticValue(item, "", depth + 1));
	}
	if (isRecord(value)) {
		const result: DiagnosticData = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
			result[childKey] = sanitizeDiagnosticValue(childValue, childKey, depth + 1);
		}
		return result;
	}
	if (value === undefined) return undefined;
	return String(value);
}

function truncate(value: string): string {
	if (value.length <= MAX_STRING_LENGTH) return value;
	return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated ${value.length - MAX_STRING_LENGTH} chars]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
