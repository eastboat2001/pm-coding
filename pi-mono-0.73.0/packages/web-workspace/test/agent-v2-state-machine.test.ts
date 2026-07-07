import { describe, expect, it } from "vitest";
import {
	advanceAgentV2Phase,
	assertAgentV2RunTransition,
	createAgentV2RunSnapshot,
	getReadyAgentV2TaskIds,
	transitionAgentV2RunSnapshot,
} from "../src/agent-v2-state-machine.js";
import type { AgentV2TaskNode } from "../src/agent-v2-types.js";

const createdAt = "2026-07-07T00:00:00.000Z";

function task(taskId: string, status: AgentV2TaskNode["status"], dependsOn: string[]): AgentV2TaskNode {
	return {
		taskId,
		kind: "implementation",
		title: taskId,
		status,
		dependsOn,
		input: {},
		output: {},
		createdAt,
		updatedAt: createdAt,
	};
}

describe("Agent v2 state machine", () => {
	it("creates an initial queued run snapshot", () => {
		const snapshot = createAgentV2RunSnapshot({
			clientId: "client-a",
			runId: "run-1",
			input: { prompt: "Build the preview" },
			model: { provider: "openai", id: "gpt-5" },
			createdAt,
		});

		expect(snapshot).toMatchObject({
			clientId: "client-a",
			runId: "run-1",
			status: "queued",
			phase: "intake",
			attempt: 1,
			input: { prompt: "Build the preview" },
			model: { provider: "openai", id: "gpt-5" },
			createdAt,
			updatedAt: createdAt,
		});
		expect(snapshot.startedAt).toBeUndefined();
		expect(snapshot.endedAt).toBeUndefined();
		expect(snapshot.workerId).toBeUndefined();
		expect(snapshot.error).toBeUndefined();
	});

	it("allows legal run transitions", () => {
		expect(() => assertAgentV2RunTransition("queued", "running")).not.toThrow();
		expect(() => assertAgentV2RunTransition("queued", "cancelled")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "failed")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "cancelled")).not.toThrow();
	});

	it("does not allow terminal runs to restart", () => {
		expect(() => assertAgentV2RunTransition("failed", "running")).toThrow("failed -> running");
		expect(() => assertAgentV2RunTransition("succeeded", "running")).toThrow("succeeded -> running");
	});

	it.each([
		["queued", "succeeded"],
		["running", "queued"],
		["cancelled", "running"],
	] as const)("rejects illegal run transition %s -> %s", (from, to) => {
		expect(() => assertAgentV2RunTransition(from, to)).toThrow(`Invalid Agent v2 run transition: ${from} -> ${to}`);
	});

	it("progresses phases in order", () => {
		expect(advanceAgentV2Phase("intake")).toBe("planning");
		expect(advanceAgentV2Phase("planning")).toBe("execution");
		expect(advanceAgentV2Phase("execution")).toBe("validation");
		expect(advanceAgentV2Phase("validation")).toBe("repair");
		expect(advanceAgentV2Phase("repair")).toBe("finalizing");
		expect(advanceAgentV2Phase("finalizing")).toBe("finalizing");
	});

	it("keeps terminal runs immutable", () => {
		const terminalRun = transitionAgentV2RunSnapshot(
			createAgentV2RunSnapshot({
				clientId: "client-a",
				runId: "run-1",
				input: { prompt: "Build the preview" },
				model: { provider: "openai", id: "gpt-5" },
				createdAt,
			}),
			"running",
			{ workerId: "worker-1", startedAt: createdAt, updatedAt: createdAt },
		);

		const completedRun = transitionAgentV2RunSnapshot(terminalRun, "succeeded", {
			endedAt: createdAt,
			updatedAt: createdAt,
		});

		expect(completedRun.status).toBe("succeeded");
		expect(completedRun.startedAt).toBe(createdAt);
		expect(completedRun.endedAt).toBe(createdAt);
		expect(() =>
			transitionAgentV2RunSnapshot(completedRun, "running", {
				updatedAt: "2026-07-07T01:00:00.000Z",
			}),
		).toThrow("succeeded -> running");
	});

	it("marks only dependency-satisfied tasks as ready", () => {
		const ready = getReadyAgentV2TaskIds([
			task("requirements", "succeeded", []),
			task("implementation", "pending", ["requirements"]),
			task("validation", "pending", ["implementation"]),
		]);

		expect(ready).toEqual(["implementation"]);
	});
});
