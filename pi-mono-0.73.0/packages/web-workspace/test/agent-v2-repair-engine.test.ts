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

	it("reruns validation when a retryable failure has no target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", path: undefined })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.script_error:run",
				taskId: "validate",
				type: "rerun_validation",
				retryable: true,
				reason: "Client script errors must be fixed before delivery.",
				targetPath: undefined,
				validationCode: "static.script_error",
			},
		]);
	});

	it("blocks non-retryable failures and normalizes the public target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.preview_build_required", retryable: false, path: ".//dist\\\\//index.html" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:static.preview_build_required:block",
				taskId: "validate",
				type: "block_task",
				retryable: false,
				reason: "static.preview_build_required",
				targetPath: "dist/index.html",
				validationCode: "static.preview_build_required",
			},
		]);
	});

	it("normalizes retryable target paths before deriving action identity", () => {
		const [normalized] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "./src\\\\//main.ts" })],
			attempt: 1,
			maxAttempts: 3,
		});
		const [canonical] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "src/main.ts" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(normalized).toEqual(canonical);
		expect(normalized).toMatchObject({
			actionId: "repair:validate:static.loading_visible:src/main.ts",
			targetPath: "src/main.ts",
		});
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
