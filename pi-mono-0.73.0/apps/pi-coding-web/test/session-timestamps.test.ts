import { describe, expect, it } from "vitest";
import { formatSessionUpdatedAt, sessionLastMessageModifiedAt } from "../src/storage/session-timestamps.js";

describe("session timestamp helpers", () => {
	it("uses the latest message timestamp instead of the current save time", () => {
		const createdAt = "2026-06-01T01:00:00.000Z";
		const fallback = "2026-06-04T09:30:00.000Z";
		const updatedAt = new Date(2026, 5, 4, 15, 8, 0, 0).toISOString();

		expect(
			sessionLastMessageModifiedAt(
				[
					{ role: "user", content: "hello", timestamp: new Date(2026, 5, 4, 15, 7, 0, 0).getTime() },
					{
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: "demo",
						model: "demo-model",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: new Date(2026, 5, 4, 15, 8, 0, 0).getTime(),
					},
				],
				createdAt,
				fallback,
			),
		).toBe(updatedAt);
	});

	it("falls back to the created timestamp when a session has no messages", () => {
		expect(sessionLastMessageModifiedAt([], "2026-06-01T01:00:00.000Z", "2026-06-04T09:30:00.000Z")).toBe(
			"2026-06-01T01:00:00.000Z",
		);
	});

	it("formats recent session timestamps with the local time", () => {
		const now = new Date(2026, 5, 4, 18, 0, 0, 0);

		expect(formatSessionUpdatedAt(new Date(2026, 5, 4, 15, 8, 0, 0).toISOString(), now)).toBe("今天 15:08");
		expect(formatSessionUpdatedAt(new Date(2026, 5, 3, 9, 5, 0, 0).toISOString(), now)).toBe("昨天 09:05");
		expect(formatSessionUpdatedAt(new Date(2026, 4, 30, 21, 45, 0, 0).toISOString(), now)).toBe(
			"2026/05/30 21:45",
		);
	});
});
