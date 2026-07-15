import { describe, expect, it } from "vitest";
import {
	advanceAgentV2Phase,
	assertAgentV2RunTransition,
	createAgentV2RunSnapshot,
	phaseForAgentV2Task,
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
		acceptanceCriteria: [],
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
		expect(() => assertAgentV2RunTransition("running", "cancelling")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "interrupted")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "succeeded")).not.toThrow();
		expect(() => assertAgentV2RunTransition("running", "failed")).not.toThrow();
		expect(() => assertAgentV2RunTransition("cancelling", "cancelled")).not.toThrow();
		expect(() => assertAgentV2RunTransition("cancelling", "interrupted")).not.toThrow();
	});

	it("does not allow terminal runs to restart", () => {
		expect(() => assertAgentV2RunTransition("failed", "running")).toThrow("failed -> running");
		expect(() => assertAgentV2RunTransition("succeeded", "running")).toThrow("succeeded -> running");
	});

	it.each([
		["queued", "succeeded"],
		["running", "queued"],
		["cancelling", "running"],
		["cancelling", "failed"],
		["cancelling", "succeeded"],
		["cancelled", "running"],
		["interrupted", "running"],
	] as const)("rejects illegal run transition %s -> %s", (from, to) => {
		expect(() => assertAgentV2RunTransition(from, to)).toThrow(`Invalid Agent v2 run transition: ${from} -> ${to}`);
	});

	it("advances through the expanded v2 planning phases before implementation", () => {
		expect(advanceAgentV2Phase("intake")).toBe("capability_routing");
		expect(advanceAgentV2Phase("capability_routing")).toBe("spec_draft");
		expect(advanceAgentV2Phase("spec_draft")).toBe("spec_review");
		expect(advanceAgentV2Phase("spec_review")).toBe("plan_draft");
		expect(advanceAgentV2Phase("plan_draft")).toBe("task_generation");
		expect(advanceAgentV2Phase("task_generation")).toBe("implementation");
	});

	it("does not advance terminal v2 phases", () => {
		expect(advanceAgentV2Phase("delivery")).toBe("delivery");
		expect(advanceAgentV2Phase("blocked")).toBe("blocked");
		expect(advanceAgentV2Phase("failed")).toBe("failed");
		expect(advanceAgentV2Phase("cancelled")).toBe("cancelled");
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

	it("projects implementation outcomes through one authoritative task phase mapping", () => {
		const implementation = task("implementation", "ready", []);
		expect(phaseForAgentV2Task(implementation, "succeeded")).toBe("validation");
		expect(phaseForAgentV2Task(implementation, "failed")).toBe("failed");
		expect(phaseForAgentV2Task(implementation, "blocked")).toBe("blocked");
		expect(phaseForAgentV2Task(implementation, "cancelled")).toBe("cancelled");
	});
});
