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
			parentRunId: "run-interrupted",
			resumedSessions,
			runStatus: "interrupted",
			sessionId: "session-1",
			startRemoteContinuation,
			reportError,
		});

		expect(started).toBe(true);
		expect(resumedSessions.has("session-1:run-interrupted")).toBe(true);
		expect(startRemoteContinuation).toHaveBeenCalledWith("run-interrupted");
		await startRemoteContinuation.mock.results[0]?.value;
		expect(reportError).not.toHaveBeenCalled();
	});

	it("does not resume tool result sessions when the run status is unknown", () => {
		const resumedSessions = new Set<string>();
		const startRemoteContinuation = vi.fn(async () => {});
		const reportError = vi.fn();

		const started = resumeInterruptedToolResultSession({
			activeRunId: undefined,
			isStreaming: false,
			messages: [{ role: "toolResult", content: "done" }],
			parentRunId: "run-unknown-status",
			resumedSessions,
			sessionId: "session-unknown-status",
			startRemoteContinuation,
			reportError,
		});

		expect(started).toBe(false);
		expect(resumedSessions.has("session-unknown-status")).toBe(false);
		expect(startRemoteContinuation).not.toHaveBeenCalled();
		expect(reportError).not.toHaveBeenCalled();
	});

	it("does not resume interrupted tool result sessions without a parent run id", () => {
		const resumedSessions = new Set<string>();
		const startRemoteContinuation = vi.fn(async () => {});
		const reportError = vi.fn();

		const started = resumeInterruptedToolResultSession({
			activeRunId: undefined,
			isStreaming: false,
			messages: [{ role: "toolResult", content: "done" }],
			resumedSessions,
			runStatus: "interrupted",
			sessionId: "session-no-parent-run",
			startRemoteContinuation,
			reportError,
		});

		expect(started).toBe(false);
		expect(resumedSessions.has("session-no-parent-run")).toBe(false);
		expect(startRemoteContinuation).not.toHaveBeenCalled();
		expect(reportError).not.toHaveBeenCalled();
	});

	it("does not resume manually cancelled tool result sessions", () => {
		const resumedSessions = new Set<string>();
		const startRemoteContinuation = vi.fn(async () => {});
		const reportError = vi.fn();

		const started = resumeInterruptedToolResultSession({
			activeRunId: undefined,
			isStreaming: false,
			messages: [{ role: "toolResult", content: "done" }],
			parentRunId: "run-cancelled",
			resumedSessions,
			runStatus: "cancelled",
			sessionId: "session-cancelled",
			startRemoteContinuation,
			reportError,
		});

		expect(started).toBe(false);
		expect(resumedSessions.has("session-cancelled")).toBe(false);
		expect(startRemoteContinuation).not.toHaveBeenCalled();
		expect(reportError).not.toHaveBeenCalled();
	});

});
