import { describe, expect, it, vi } from "vitest";
import { resumeInterruptedToolResultSession } from "../src/runtime/remote-resume.js";

describe("remote interrupted resume", () => {
	it("starts a remote continuation for interrupted tool result sessions", async () => {
		const resumedSessions = new Set<string>();
		const startRemoteContinuation = vi.fn(async () => {});
		const reportError = vi.fn();

		const started = resumeInterruptedToolResultSession({
			activeRunId: undefined,
			isStreaming: false,
			messages: [{ role: "toolResult", content: "done" }],
			resumedSessions,
			runStatus: "interrupted",
			sessionId: "session-1",
			startRemoteContinuation,
			reportError,
		});

		expect(started).toBe(true);
		expect(resumedSessions.has("session-1")).toBe(true);
		expect(startRemoteContinuation).toHaveBeenCalledTimes(1);
		await startRemoteContinuation.mock.results[0]?.value;
		expect(reportError).not.toHaveBeenCalled();
	});
});
