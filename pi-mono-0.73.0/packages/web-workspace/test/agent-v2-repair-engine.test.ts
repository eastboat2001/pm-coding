import { describe, expect, it } from "vitest";
import { planAgentV2RepairActions } from "../src/agent-v2-repair-engine.js";
import type { AgentV2ValidationFailure } from "../src/agent-v2-validation-gate.js";
import { classifyAgentV2ValidationPolicy } from "../src/agent-v2-validation-policy.js";

describe("agent v2 repair engine", () => {
	it("plans task-scoped repair actions for repairable static failures", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "index.html", source: "static_smoke" })],
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
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("blocks when max repair attempts are exhausted", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.script_error", source: "static_smoke" })],
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

	it("reruns validation only for a transient failure with no target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "build.timeout", path: undefined, source: "static_validate" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toEqual([
			{
				actionId: "repair:validate:build.timeout:run",
				taskId: "validate",
				type: "rerun_validation",
				retryable: true,
				reason: "build.timeout",
				targetPath: undefined,
				validationCode: "build.timeout",
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("uses full application regeneration for pathless structural failures that require new files", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.workspace_empty", path: undefined, source: "static_validate" })],
			attempt: 1,
			maxAttempts: 5,
		});

		expect(action).toMatchObject({ type: "regenerate_app", targetPath: undefined, retryable: true });
	});

	it("provides a focused repair instruction for unbounded responsive charts", () => {
		const [action] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.canvas_layout_unbounded", path: "index.html", source: "static_smoke" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(action).toMatchObject({
			type: "file_patch",
			targetPath: "index.html",
			reason:
				"Responsive charts must use dedicated position:relative containers with bounded heights before delivery.",
		});
	});

	it("blocks non-retryable failures and normalizes the public target path", () => {
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({ code: "static.preview_build_required", retryable: false, path: ".//dist\\\\//index.html" }),
			],
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
				validationFingerprint: expect.stringMatching(/^sha256:/),
			},
		]);
	});

	it("normalizes retryable target paths before deriving action identity", () => {
		const [normalized] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [
				failure({ code: "static.loading_visible", path: "./src\\\\//main.ts", source: "static_smoke" }),
			],
			attempt: 1,
			maxAttempts: 3,
		});
		const [canonical] = planAgentV2RepairActions({
			taskId: "validate",
			failures: [failure({ code: "static.loading_visible", path: "src/main.ts", source: "static_smoke" })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(normalized).toEqual(canonical);
		expect(normalized).toMatchObject({
			actionId: "repair:validate:static.loading_visible:src/main.ts",
			targetPath: "src/main.ts",
		});
	});

	it("ignores non-blocking findings and deduplicates identical blocking fingerprints", () => {
		const blocking = failure({ code: "static.loading_visible", path: "index.html", source: "static_smoke" });
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [blocking, blocking, failure({ code: "static.selector_missing", blocking: false })],
			attempt: 1,
			maxAttempts: 3,
		});

		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({ validationFingerprint: blocking.fingerprint, retryable: true });
	});

	it("blocks a repeated identical finding when its fingerprint budget is exhausted", () => {
		const repeated = failure({ code: "static.loading_visible", path: "index.html", source: "static_smoke" });
		const actions = planAgentV2RepairActions({
			taskId: "validate",
			failures: [repeated],
			attempt: 2,
			maxAttempts: 3,
			previousFingerprintAttempts: { [repeated.fingerprint]: 3 },
		});

		expect(actions).toEqual([
			expect.objectContaining({
				type: "block_task",
				retryable: false,
				validationFingerprint: repeated.fingerprint,
				reason: expect.stringContaining("Repair budget exhausted"),
			}),
		]);
	});
});

function failure(input: Partial<AgentV2ValidationFailure> & { code: string }): AgentV2ValidationFailure {
	const source = input.source ?? "static_quality";
	const retryable = input.retryable ?? true;
	const policy = classifyAgentV2ValidationPolicy({
		code: input.code,
		source,
		retryable,
		path: input.path,
		data: input.data,
		blocking: input.blocking,
	});
	return {
		code: input.code,
		message: input.message ?? input.code,
		retryable,
		taskId: input.taskId ?? "validate",
		path: input.path,
		data: input.data ?? {},
		source,
		...policy,
	};
}
