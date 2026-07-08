import { describe, expect, it } from "vitest";
import { selectNextAgentV2Task, transitionAgentV2Task } from "../src/agent-v2-task-engine.js";
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
			blockedTaskIds: [],
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

	it("reports failed dependencies before dependency blocking", () => {
		const tasks = [
			task({ taskId: "capability", status: "failed" }),
			task({ taskId: "spec", status: "pending", dependsOn: ["capability"] }),
			task({ taskId: "plan", status: "pending", dependsOn: ["spec"] }),
		];

		expect(selectNextAgentV2Task(tasks)).toEqual({
			reason: "failed_dependency",
			blockedTaskIds: ["plan"],
			failedDependencyTaskIds: ["spec"],
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
		).toThrow("Agent v2 failed task transitions require an error");
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
