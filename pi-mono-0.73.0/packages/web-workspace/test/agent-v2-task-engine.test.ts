import { describe, expect, it } from "vitest";
import {
	assertAgentV2TaskTransition,
	selectNextAgentV2Task,
	transitionAgentV2Task,
} from "../src/agent-v2-task-engine.js";
import type { AgentV2TaskNode } from "../src/agent-v2-types.js";

const CREATED_AT = "2026-07-08T00:00:00.000Z";
const UPDATED_AT = "2026-07-08T00:00:00.000Z";

describe("agent v2 task engine", () => {
	it("selects an already running task before starting another task", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "running", dependsOn: ["capability"], startedAt: "2026-07-08T00:01:00.000Z" }),
			task({ taskId: "plan", status: "ready", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "running",
			blockedTaskIds: ["plan"],
			failedDependencyTaskIds: [],
		});
	});

	it("returns running task and still reports full blocked diagnostics", () => {
		const tasks = [
			task({ taskId: "running", status: "running" }),
			task({ taskId: "blocked-root", status: "blocked" }),
			task({ taskId: "blocked-downstream", status: "pending", dependsOn: ["blocked-root"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "running" }),
			reason: "running",
			blockedTaskIds: ["blocked-root", "blocked-downstream"],
			failedDependencyTaskIds: [],
		});
	});

	it("selects the first pending or ready task whose dependencies succeeded", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "ready", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "ready",
			blockedTaskIds: ["plan"],
			failedDependencyTaskIds: [],
		});
	});

	it("reports dependency blocking without selecting a task", () => {
		const tasks = [
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "blocked_by_dependencies",
			blockedTaskIds: ["spec", "plan"],
			failedDependencyTaskIds: [],
		});
	});

	it("treats blocked dependency as blocked-by-dependency instead of hard failure", () => {
		const tasks = [
			task({ taskId: "spec", status: "blocked" }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
			task({ taskId: "deliver", status: "pending", dependsOn: ["plan"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "blocked_by_dependencies",
			blockedTaskIds: ["spec", "plan", "deliver"],
			failedDependencyTaskIds: [],
		});
	});

	it("reports failed dependencies before dependency blocking", () => {
		const tasks = [
			task({ taskId: "capability", status: "failed" }),
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: [],
			failedDependencyTaskIds: ["capability", "spec", "plan"],
		});
	});

	it("treats cancelled as failed dependency", () => {
		const tasks = [
			task({ taskId: "capability", status: "cancelled" }),
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: [],
			failedDependencyTaskIds: ["capability", "spec", "plan"],
		});
	});

	it("reports complete only when every task succeeded", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({ taskId: "spec", status: "succeeded", dependsOn: ["capability"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "complete",
			blockedTaskIds: [],
			failedDependencyTaskIds: [],
		});
	});

	it("does not treat terminal failures as a complete graph", () => {
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({
				taskId: "validate",
				status: "failed",
				dependsOn: ["capability"],
				error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
			}),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: [],
			failedDependencyTaskIds: ["validate"],
		});
	});

	it("stamps running and terminal transitions without mutating the original task", () => {
		const original = task({ taskId: "spec", status: "ready" });

		const running = transitionAgentV2Task({
			task: original,
			status: "running",
			now: "2026-07-08T00:02:00.000Z",
		});
		const succeeded = transitionAgentV2Task({
			task: running,
			status: "succeeded",
			now: "2026-07-08T00:03:00.000Z",
			output: { filesChanged: ["src/App.tsx"] },
		});

		expect(original.status).toBe("ready");
		expect(running).toMatchObject({
			status: "running",
			startedAt: "2026-07-08T00:02:00.000Z",
			updatedAt: "2026-07-08T00:02:00.000Z",
		});
		expect(succeeded).toMatchObject({
			status: "succeeded",
			output: { filesChanged: ["src/App.tsx"] },
			startedAt: "2026-07-08T00:02:00.000Z",
			endedAt: "2026-07-08T00:03:00.000Z",
			updatedAt: "2026-07-08T00:03:00.000Z",
		});
	});

	it("requires an error for failed transitions", () => {
		expect(() =>
			transitionAgentV2Task({
				task: task({ taskId: "validate", status: "running" }),
				status: "failed",
				now: "2026-07-08T00:04:00.000Z",
			}),
		).toThrow("Agent v2 blocked and failed task transitions require an error");
	});

	it("rejects invalid task transitions through the centralized matrix", () => {
		expect(() => assertAgentV2TaskTransition("succeeded", "running")).toThrow("succeeded -> running");
		expect(() =>
			transitionAgentV2Task({
				task: task({ taskId: "done", status: "succeeded" }),
				status: "running",
				now: "2026-07-08T00:04:00.000Z",
			}),
		).toThrow("succeeded -> running");
	});

	it("requires an error for blocked transitions", () => {
		expect(() =>
			transitionAgentV2Task({
				task: task({ taskId: "validate", status: "running" }),
				status: "blocked",
				now: "2026-07-08T00:04:00.000Z",
			}),
		).toThrow("Agent v2 blocked and failed task transitions require an error");
	});

	it("persists structured error for blocked transitions", () => {
		const blocked = transitionAgentV2Task({
			task: task({ taskId: "validate", status: "running", startedAt: "2026-07-08T00:02:00.000Z" }),
			status: "blocked",
			now: "2026-07-08T00:04:00.000Z",
			error: { code: "WAITING_ON_HUMAN", message: "Need approval", retryable: true },
		});

		expect(blocked).toMatchObject({
			status: "blocked",
			startedAt: "2026-07-08T00:02:00.000Z",
			endedAt: "2026-07-08T00:04:00.000Z",
			error: { code: "WAITING_ON_HUMAN", message: "Need approval", retryable: true },
		});
	});

	it("clears endedAt/output/error when restarting from failed task", () => {
		const failed = transitionAgentV2Task({
			task: transitionAgentV2Task({
				task: task({ taskId: "spec", status: "ready" }),
				status: "running",
				now: "2026-07-08T00:02:00.000Z",
			}),
			status: "failed",
			now: "2026-07-08T00:03:00.000Z",
			error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
			output: { filesChanged: ["src/App.tsx"] },
		});
		const retried = transitionAgentV2Task({
			task: failed,
			status: "running",
			now: "2026-07-08T00:04:00.000Z",
		});
		const reset = transitionAgentV2Task({
			task: failed,
			status: "ready",
			now: "2026-07-08T00:05:00.000Z",
		});

		expect(failed).toMatchObject({
			status: "failed",
			endedAt: "2026-07-08T00:03:00.000Z",
			error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
		});
		expect(retried).toMatchObject({
			status: "running",
			endedAt: undefined,
			output: {},
			error: undefined,
		});
		expect(reset).toMatchObject({
			status: "ready",
			startedAt: undefined,
			endedAt: undefined,
			output: {},
			error: undefined,
		});
	});

	it("resets startedAt when retrying from failed through ready back to running", () => {
		const failed = transitionAgentV2Task({
			task: {
				...task({ taskId: "spec", status: "running", startedAt: "2026-07-08T00:02:00.000Z" }),
				output: { filesChanged: ["src/App.tsx"] },
			},
			status: "failed",
			now: "2026-07-08T00:03:00.000Z",
			error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
		});
		const reset = transitionAgentV2Task({
			task: failed,
			status: "ready",
			now: "2026-07-08T00:04:00.000Z",
		});
		const rerun = transitionAgentV2Task({
			task: reset,
			status: "running",
			now: "2026-07-08T00:05:00.000Z",
		});

		expect(reset.startedAt).toBeUndefined();
		expect(rerun).toMatchObject({
			status: "running",
			startedAt: "2026-07-08T00:05:00.000Z",
			endedAt: undefined,
			error: undefined,
		});
	});

	it("uses retry now when going directly from failed back to running", () => {
		const failed = transitionAgentV2Task({
			task: task({ taskId: "spec", status: "running", startedAt: "2026-07-08T00:02:00.000Z" }),
			status: "failed",
			now: "2026-07-08T00:03:00.000Z",
			error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
		});

		const retried = transitionAgentV2Task({
			task: failed,
			status: "running",
			now: "2026-07-08T00:04:00.000Z",
		});

		expect(retried).toMatchObject({
			status: "running",
			startedAt: "2026-07-08T00:04:00.000Z",
			endedAt: undefined,
		});
	});

	it("returns a ready task while preserving full blocked diagnostics", () => {
		const tasks = [
			task({ taskId: "ready-unrelated", status: "ready", dependsOn: [] }),
			task({ taskId: "blocked-root", status: "blocked" }),
			task({ taskId: "blocked-downstream", status: "pending", dependsOn: ["blocked-root"] }),
			task({ taskId: "blocked-more", status: "pending", dependsOn: ["blocked-downstream"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "ready-unrelated" }),
			reason: "ready",
			blockedTaskIds: ["blocked-root", "blocked-downstream", "blocked-more"],
			failedDependencyTaskIds: [],
		});
	});

	it("returns a ready task while preserving full failed dependency diagnostics", () => {
		const tasks = [
			task({ taskId: "ready-unrelated", status: "ready", dependsOn: [] }),
			task({
				taskId: "failed-root",
				status: "failed",
				error: { code: "FAILED", message: "Boom", retryable: false },
			}),
			task({ taskId: "failed-downstream", status: "pending", dependsOn: ["failed-root"] }),
			task({ taskId: "failed-running", status: "pending", dependsOn: ["failed-downstream"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			task: expect.objectContaining({ taskId: "ready-unrelated" }),
			reason: "ready",
			blockedTaskIds: [],
			failedDependencyTaskIds: ["failed-root", "failed-downstream", "failed-running"],
		});
	});
});

function task(input: Partial<AgentV2TaskNode> & { taskId: string }): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		parentTaskId: input.parentTaskId,
		kind: input.kind ?? "implementation",
		title: input.title ?? input.taskId,
		status: input.status ?? "pending",
		dependsOn: input.dependsOn ?? [],
		acceptanceCriteria: input.acceptanceCriteria ?? [],
		input: input.input ?? {},
		output: input.output ?? {},
		createdAt: input.createdAt ?? CREATED_AT,
		updatedAt: input.updatedAt ?? UPDATED_AT,
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		error: input.error,
	};
}
