export interface RetryPolicyOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
	jitterRatio?: number;
	random?: () => number;
}

export interface RetryClassification {
	retryable: boolean;
	reasonCode: "transient_provider_error" | "not_retryable";
	message: string;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_JITTER_RATIO = 0.2;
const MAX_ATTEMPTS_CAP = 5;
const MAX_ERROR_SIGNAL_LENGTH = 2000;
const TRUNCATED_SIGNAL_SUFFIX = "...[truncated]";

const NOT_RETRYABLE_PATTERN =
	/AbortError|request.?aborted.?by.?user|aborted.?by.?(?:user|caller)|(?:user|caller).?aborted|cancelled|canceled|unauthorized|forbidden|401|403|invalid.?request|bad.?request|400|context.?window|context.?length|prompt.?too.?long|request.?too.?large/i;

const TRANSIENT_PATTERN =
	/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|5\d\d|service.?unavailable|server.?error|internal.?error|network.?error|disconnect(?:ed|ion)?|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay|ECONNRESET|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i;

const MAX_CAUSE_DEPTH = 3;

export class RetryPolicy {
	private readonly baseDelayMs: number;
	private readonly maxDelayMs: number;
	private readonly jitterRatio: number;
	private readonly random: () => number;
	private readonly attempts: number;

	constructor(options: RetryPolicyOptions = {}) {
		this.attempts = Math.min(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, MAX_ATTEMPTS_CAP);
		this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
		this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
		this.jitterRatio = options.jitterRatio ?? DEFAULT_JITTER_RATIO;
		this.random = options.random ?? Math.random;
	}

	get maxAttempts(): number {
		return this.attempts;
	}

	classify(error: unknown): RetryClassification {
		const message = errorMessage(error);
		if (isExplicitlyNonRetryable(error)) {
			return { retryable: false, reasonCode: "not_retryable", message };
		}
		if (NOT_RETRYABLE_PATTERN.test(message)) {
			return { retryable: false, reasonCode: "not_retryable", message };
		}
		if (TRANSIENT_PATTERN.test(message)) {
			return { retryable: true, reasonCode: "transient_provider_error", message };
		}
		return { retryable: false, reasonCode: "not_retryable", message };
	}

	shouldRetry(attempt: number): boolean {
		return attempt >= 1 && attempt <= this.attempts;
	}

	delayMs(attempt: number): number {
		const exponentialDelayMs = Math.min(this.baseDelayMs * 2 ** Math.max(0, attempt - 1), this.maxDelayMs);
		if (this.jitterRatio <= 0) return exponentialDelayMs;
		const jitterRangeMs = exponentialDelayMs * this.jitterRatio;
		const jitterOffsetMs = (this.random() * 2 - 1) * jitterRangeMs;
		return Math.max(0, Math.round(exponentialDelayMs + jitterOffsetMs));
	}
}

function errorMessage(error: unknown, depth = 0): string {
	const signals: string[] = [];
	const seenSignals = new Set<string>();
	if (error instanceof Error) {
		pushSignal(signals, seenSignals, error.name);
		pushSignal(signals, seenSignals, error.message);
	}
	if (isRecord(error)) {
		pushField(signals, seenSignals, error, "message");
		pushField(signals, seenSignals, error, "name");
		pushField(signals, seenSignals, error, "code");
		pushField(signals, seenSignals, error, "status");
		pushField(signals, seenSignals, error, "statusCode");
		if (depth < MAX_CAUSE_DEPTH && "cause" in error) {
			pushSignal(signals, seenSignals, errorMessage(error.cause, depth + 1));
		}
	}
	if (signals.length === 0) {
		pushSignal(signals, seenSignals, String(error));
	}
	return truncateSignal(signals.join(" "));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isExplicitlyNonRetryable(error: unknown): boolean {
	if (!isRecord(error)) return false;
	return error.retryable === false || error.code === "PI_NON_RETRYABLE";
}

function pushField(signals: string[], seenSignals: Set<string>, record: Record<string, unknown>, key: string): void {
	const value = record[key];
	if (typeof value === "string" || typeof value === "number") {
		pushSignal(signals, seenSignals, String(value));
	}
}

function pushSignal(signals: string[], seenSignals: Set<string>, value: string): void {
	if (!value || seenSignals.has(value)) return;
	seenSignals.add(value);
	signals.push(value);
}

function truncateSignal(message: string): string {
	if (message.length <= MAX_ERROR_SIGNAL_LENGTH) return message;
	return `${message.slice(0, MAX_ERROR_SIGNAL_LENGTH - TRUNCATED_SIGNAL_SUFFIX.length)}${TRUNCATED_SIGNAL_SUFFIX}`;
}
