import type { RetryClassification } from "./retry-policy.js";
import { RetryPolicy } from "./retry-policy.js";
import type { JsonObject, RuntimeRunRecord } from "./types.js";

export interface RunRetryControllerDiagnostics {
	writeEvents(input: { events: JsonObject[] }): unknown;
}

export interface RunRetryControllerOptions {
	policy?: RetryPolicy;
	diagnostics?: RunRetryControllerDiagnostics;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onRetryEvent?: (event: RunRetryControllerEvent) => Promise<void> | void;
}

export interface RunRetryExecutionInput {
	run: RuntimeRunRecord;
	signal?: AbortSignal;
	action: () => Promise<void>;
}

export interface RunRetryControllerEvent {
	eventType: "retry_scheduled" | "retry_exhausted";
	run: RuntimeRunRecord;
	attempt: number;
	maxAttempts: number;
	reasonCode: RetryClassification["reasonCode"];
	message: string;
	delayMs?: number;
}

export class RunRetryController {
	private readonly policy: RetryPolicy;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

	constructor(private readonly options: RunRetryControllerOptions = {}) {
		this.policy = options.policy ?? new RetryPolicy();
		this.sleep = options.sleep ?? sleep;
	}

	async execute(input: RunRetryExecutionInput): Promise<void> {
		let attempt = 0;
		for (;;) {
			try {
				await input.action();
				return;
			} catch (error) {
				if (input.signal?.aborted) {
					throw error;
				}
				const classification = this.policy.classify(error);
				attempt += 1;
				if (!classification.retryable || !this.policy.shouldRetry(attempt + 1)) {
					await this.writeRetryEvent(
						"retry_exhausted",
						input.run,
						attempt,
						classification.reasonCode,
						classification.message,
					);
					throw error;
				}
				const delayMs = this.policy.delayMs(attempt);
				await this.writeRetryEvent(
					"retry_scheduled",
					input.run,
					attempt,
					classification.reasonCode,
					classification.message,
					delayMs,
				);
				await this.sleep(delayMs, input.signal);
			}
		}
	}

	private async writeRetryEvent(
		eventType: "retry_scheduled" | "retry_exhausted",
		run: RuntimeRunRecord,
		attempt: number,
		reasonCode: RetryClassification["reasonCode"],
		message: string,
		delayMs?: number,
	): Promise<void> {
		await this.options.onRetryEvent?.({
			eventType,
			run,
			attempt,
			maxAttempts: this.policy.maxAttempts,
			reasonCode,
			message,
			delayMs,
		});
		this.options.diagnostics?.writeEvents({
			events: [
				{
					eventType: `agent.${eventType}`,
					level: eventType === "retry_exhausted" ? "error" : "warn",
					category: "agent",
					sessionId: run.sessionId,
					traceId: run.sessionId,
					data: {
						clientId: run.clientId,
						runId: run.runId,
						attempt,
						maxAttempts: this.policy.maxAttempts,
						reasonCode,
						message,
						delayMs,
					},
				},
			],
		});
	}
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Retry cancelled"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Retry cancelled"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
