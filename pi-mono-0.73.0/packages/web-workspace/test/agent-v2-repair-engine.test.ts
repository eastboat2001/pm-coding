import { describe, expect, it } from "vitest";
import { planAgentV2RepairActions } from "../src/agent-v2-repair-engine.js";
import type { AgentV2ValidationFailure } from "../src/agent-v2-validation-gate.js";

describe("agent v2 repair engine", () => {
	it("plans task-scoped repair actions for repairable static failures", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "index.html" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.loading_visible:index.html",
				taskId: "validate",
				type: "file_patch",
				retryable: true,
				reason: "Visible loading state must be hidden or resolved before delivery.",
				targetPath: "index.html",
				validationCode: "static.loading_visible",
			},
		]);
	});

	it("blocks when max repair attempts are exhausted", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error" })],
			attempt: 3,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			expect.objectContaining({
				type: "block_task",
				retryable: false,
				validationCode: "repair.max_attempts_exceeded",
			}),
		]);
	});
});

function failure(input: Partial<AgentV2ValidationFailure> & { code: string }): AgentV2ValidationFailure {
	return {
		code: input.code,
		message: input.message ?? input.code,
		retryable: input.retryable ?? true,
		taskId: input.taskId ?? "validate",
		path: input.path,
		data: input.data ?? {},
		source: input.source ?? "static_quality",
	};
}
