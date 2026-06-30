import { describe, expect, it, vi } from "vitest";
import type { RuntimeRunEventRecord, RuntimeRunRecord, RuntimeSessionDetail } from "@mariozechner/pi-web-workspace";
import { resolveActiveRunRestore, resumeInterruptedToolResultSession } from "../src/runtime/remote-resume.js";

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

	it("uses active run restore detail instead of requiring a run event replay from seq 0", () => {
		const run = createRunRecord("run-1", "running");
		const checkpointEvent = createRunEventRecord(12, "run-1", {
			type: "message_update",
			message: { role: "assistant", content: "checkpoint" },
		});
		const detail = createRuntimeSessionDetail({
			runs: [run],
			activeRun: {
				run,
				checkpointEvent,
				afterSeq: 12,
			},
		});

		const restore = resolveActiveRunRestore(detail);

		expect(restore).toEqual({
			run,
			checkpointEvent,
			afterSeq: 12,
			legacy: false,
		});
	});

	it("does not restore or connect an active run when session detail has no activeRun restore", () => {
		const completed = createRunRecord("run-completed", "completed", "2026-06-29T00:00:00.000Z");
		const running = createRunRecord("run-running", "running", "2026-06-30T00:00:00.000Z");
		const detail = createRuntimeSessionDetail({ runs: [completed, running] });
		const connectToRunEvents = vi.fn();

		const restore = resolveActiveRunRestore(detail);
		if (restore) connectToRunEvents(restore.run, restore.afterSeq);

		expect(restore).toBeUndefined();
		expect(connectToRunEvents).not.toHaveBeenCalled();
	});

	it("does not fall back to a preferred active run when activeRun restore detail is missing or mismatched", () => {
		const preferred = createRunRecord("preferred-run", "running");
		const restored = createRunRecord("restored-run", "running");

		expect(resolveActiveRunRestore(createRuntimeSessionDetail({ runs: [preferred] }), "preferred-run")).toBeUndefined();
		expect(
			resolveActiveRunRestore(
				createRuntimeSessionDetail({
					runs: [preferred, restored],
					activeRun: {
						run: restored,
						afterSeq: 8,
					},
				}),
				"preferred-run",
			),
		).toBeUndefined();
	});
});

function createRuntimeSessionDetail(
	overrides: Partial<RuntimeSessionDetail> = {},
): RuntimeSessionDetail {
	return {
		session: {
			clientId: "client-1",
			sessionId: "session-1",
			title: "Runtime session",
			model: {},
			thinkingLevel: "high",
			createdAt: "2026-06-30T00:00:00.000Z",
			updatedAt: "2026-06-30T00:00:00.000Z",
		},
		messages: [],
		runs: [],
		...overrides,
	};
}

function createRunRecord(
	runId: string,
	status: RuntimeRunRecord["status"],
	updatedAt = "2026-06-30T00:00:00.000Z",
): RuntimeRunRecord {
	return {
		runId,
		sessionId: "session-1",
		clientId: "client-1",
		status,
		model: {},
		thinkingLevel: "high",
		updatedAt,
	};
}

function createRunEventRecord(
	seq: number,
	runId: string,
	payload: Record<string, unknown>,
): RuntimeRunEventRecord {
	return {
		eventId: seq,
		runId,
		sessionId: "session-1",
		clientId: "client-1",
		seq,
		type: String(payload.type || "agent"),
		payload,
		createdAt: "2026-06-30T00:00:00.000Z",
	};
}
