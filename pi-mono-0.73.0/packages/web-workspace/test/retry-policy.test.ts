import { describe, expect, it } from "vitest";
import { RetryPolicy } from "../src/retry-policy.js";
import { RunRetryController } from "../src/run-retry-controller.js";
import type { JsonObject, RuntimeRunRecord } from "../src/types.js";

const run = {
	runId: "run-1",
	sessionId: "session-1",
	clientId: "client-a",
	status: "running",
	model: {},
	thinkingLevel: "high",
	updatedAt: "2026-06-16T00:00:00.000Z",
} satisfies RuntimeRunRecord;

describe("RetryPolicy", () => {
	it("classifies transient provider and network errors as retryable", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });

		expect(policy.classify(new Error("provider returned 429 rate limit")).retryable).toBe(true);
		expect(policy.classify(new Error("503 service unavailable")).retryable).toBe(true);
		expect(policy.classify(new Error("provider returned 520")).retryable).toBe(true);
		expect(policy.classify(new Error("501 upstream error")).retryable).toBe(true);
		expect(policy.classify(new Error("fetch failed: socket hang up")).retryable).toBe(true);
		expect(policy.classify(new Error("network disconnect")).retryable).toBe(true);
		expect(policy.classify(new Error("disconnected from provider")).retryable).toBe(true);
		expect(policy.classify(new Error("request timeout")).retryable).toBe(true);
	});

	it("does not retry cancellation, auth, validation, or context overflow", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });

		expect(policy.classify(new Error("Request aborted by user")).retryable).toBe(false);
		expect(policy.classify(new Error("401 unauthorized")).retryable).toBe(false);
		expect(policy.classify(new Error("invalid request payload")).retryable).toBe(false);
		expect(policy.classify(new Error("context window exceeded")).retryable).toBe(false);
	});

	it("classifies structured transient error codes as retryable", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const error = Object.assign(new Error("provider failed"), { code: "ECONNRESET" });
		const abortedTimeout = Object.assign(new Error("timeout"), { code: "ECONNABORTED" });

		expect(policy.classify(error).retryable).toBe(true);
		expect(policy.classify(abortedTimeout).retryable).toBe(true);
	});

	it("does not retry explicit user and abort cancellations", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const abortError = Object.assign(new Error("cancelled"), { name: "AbortError" });

		expect(policy.classify(new Error("Request aborted by user")).retryable).toBe(false);
		expect(policy.classify(abortError).retryable).toBe(false);
	});

	it("bounds long classification messages", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const classification = policy.classify(new Error("x".repeat(10000)));

		expect(classification.message.length).toBeLessThanOrEqual(2100);
		expect(classification.message).toContain("...[truncated]");
	});

	it("classifies structured 5xx status codes as retryable", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const error = Object.assign(new Error("provider failed"), { statusCode: 503 });
		const stringStatus = Object.assign(new Error("provider failed"), { status: "503" });

		expect(policy.classify(error).retryable).toBe(true);
		expect(policy.classify(stringStatus).retryable).toBe(true);
	});

	it("classifies nested transient causes as retryable", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const cause = Object.assign(new Error("socket"), { code: "ETIMEDOUT" });
		const error = Object.assign(new Error("provider failed"), { cause });

		expect(policy.classify(error).retryable).toBe(true);
	});

	it("does not retry structured client status codes", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const badRequest = Object.assign(new Error("provider failed"), { status: 400 });
		const unauthorized = Object.assign(new Error("provider failed"), { statusCode: "401" });

		expect(policy.classify(badRequest).retryable).toBe(false);
		expect(policy.classify(unauthorized).retryable).toBe(false);
	});

	it("does not retry explicit non-retryable structured markers", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });
		const retryableFalse = Object.assign(new Error("503 service unavailable"), { retryable: false });
		const nonRetryableCode = Object.assign(new Error("503 service unavailable"), { code: "PI_NON_RETRYABLE" });

		expect(policy.classify(retryableFalse)).toMatchObject({
			retryable: false,
			reasonCode: "not_retryable",
		});
		expect(policy.classify(nonRetryableCode)).toMatchObject({
			retryable: false,
			reasonCode: "not_retryable",
		});
	});

	it("caps attempts at five and calculates deterministic exponential delay without jitter", () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, jitterRatio: 0 });

		expect(policy.shouldRetry(0)).toBe(false);
		expect(policy.shouldRetry(1)).toBe(true);
		expect(policy.shouldRetry(5)).toBe(true);
		expect(policy.shouldRetry(6)).toBe(false);
		expect(policy.delayMs(1)).toBe(1000);
		expect(policy.delayMs(2)).toBe(2000);
		expect(policy.delayMs(5)).toBe(10000);
	});

	it("limits retryable controller execution to the policy max attempts", async () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 });
		const events: JsonObject[] = [];
		const controller = new RunRetryController({
			policy,
			diagnostics: { writeEvents: ({ events: writtenEvents }) => events.push(...writtenEvents) },
			sleep: async () => {},
		});
		let attempts = 0;
		const error = new Error("provider returned 429 rate limit");

		await expect(
			controller.execute({
				run,
				action: async () => {
					attempts += 1;
					throw error;
				},
			}),
		).rejects.toBe(error);

		expect(attempts).toBe(5);
		expect(events.map((event) => event.eventType)).toEqual([
			"agent.retry_scheduled",
			"agent.retry_scheduled",
			"agent.retry_scheduled",
			"agent.retry_scheduled",
			"agent.retry_exhausted",
		]);
		expect(events.map((event) => (event.data as JsonObject).attempt)).toEqual([1, 2, 3, 4, 5]);
		expect(events.map((event) => (event.data as JsonObject).reasonCode)).toEqual([
			"transient_provider_error",
			"transient_provider_error",
			"transient_provider_error",
			"transient_provider_error",
			"transient_provider_error",
		]);
	});

	it("schedules one retry when controller execution succeeds after one retryable failure", async () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 });
		const events: JsonObject[] = [];
		const controller = new RunRetryController({
			policy,
			diagnostics: { writeEvents: ({ events: writtenEvents }) => events.push(...writtenEvents) },
			sleep: async () => {},
		});
		let attempts = 0;

		await controller.execute({
			run,
			action: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("provider returned 429 rate limit");
			},
		});

		expect(attempts).toBe(2);
		expect(events.map((event) => event.eventType)).toEqual(["agent.retry_scheduled"]);
		expect(events.map((event) => (event.data as JsonObject).attempt)).toEqual([1]);
		expect(events[0]?.data).toMatchObject({
			maxAttempts: 5,
			message: "Error provider returned 429 rate limit",
			delayMs: 1,
		});
	});

	it("does not schedule a retry for non-retryable controller execution errors", async () => {
		const policy = new RetryPolicy({ maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 });
		const events: JsonObject[] = [];
		const controller = new RunRetryController({
			policy,
			diagnostics: { writeEvents: ({ events: writtenEvents }) => events.push(...writtenEvents) },
			sleep: async () => {},
		});
		const error = new Error("401 unauthorized");
		let attempts = 0;

		await expect(
			controller.execute({
				run,
				action: async () => {
					attempts += 1;
					throw error;
				},
			}),
		).rejects.toBe(error);

		expect(attempts).toBe(1);
		expect(events.map((event) => event.eventType)).toEqual(["agent.retry_exhausted"]);
		expect(events.map((event) => (event.data as JsonObject).attempt)).toEqual([1]);
	});
});
