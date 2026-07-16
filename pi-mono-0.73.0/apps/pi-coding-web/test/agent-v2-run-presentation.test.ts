import type { AgentV2Phase, AgentV2RunStatus } from "@mariozechner/pi-web-workspace";
import { describe, expect, it } from "vitest";
import {
	agentV2StageForPhase,
	createAgentV2RunPresentationStore,
	reduceAgentV2RunPresentation,
	serializeAgentV2TerminalRunPresentation,
} from "../src/runtime/agent-v2-run-presentation.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("Agent v2 run presentation", () => {
	it("maps every protocol phase into exactly five user stages", () => {
		const expected: Record<AgentV2Phase, string> = {
			intake: "understanding",
			capability_routing: "understanding",
			spec_draft: "planning",
			spec_review: "planning",
			plan_draft: "planning",
			task_generation: "planning",
			implementation: "implementation",
			repair: "implementation",
			validation: "validation",
			preview: "validation",
			delivery: "delivery",
			blocked: "delivery",
			failed: "delivery",
			cancelled: "delivery",
		};

		expect(Object.entries(expected).map(([phase, stage]) => [phase, agentV2StageForPhase(phase as AgentV2Phase)])).toEqual(
			Object.entries(expected),
		);
		expect(new Set(Object.values(expected))).toEqual(
			new Set(["understanding", "planning", "implementation", "validation", "delivery"]),
		);
	});

	it("reconciles indexed records and de-duplicates append-only presentation data", () => {
		let store = reduceAgentV2RunPresentation(createAgentV2RunPresentationStore(), {
			type: "begin",
			runId: "run-1",
			phase: "implementation",
			status: "running",
			at: NOW,
		});
		store = reduceAgentV2RunPresentation(store, {
			type: "task",
			runId: "run-1",
			event: task("running"),
		});
		store = reduceAgentV2RunPresentation(store, {
			type: "task",
			runId: "run-1",
			event: task("succeeded"),
		});
		store = reduceAgentV2RunPresentation(store, {
			type: "artifact",
			runId: "run-1",
			event: artifact("created", "pending"),
		});
		store = reduceAgentV2RunPresentation(store, {
			type: "artifact",
			runId: "run-1",
			event: artifact("updated", "passed"),
		});
		for (const attempt of [validation(1, "failed"), validation(2, "passed"), validation(2, "warning")]) {
			store = reduceAgentV2RunPresentation(store, {
				type: "validation",
				runId: "run-1",
				event: attempt,
			});
		}
		const repeatedActions = [
			{
				type: "diagnostic" as const,
				event: {
					type: "agent_v2.diagnostic_recorded" as const,
					diagnosticId: "diagnostic-1",
					severity: "warn" as const,
					code: "warning",
					message: "Optional check skipped.",
					at: NOW,
				},
			},
			{
				type: "output" as const,
				event: {
					type: "agent_v2.output_recorded" as const,
					taskId: "task-1",
					summary: "Implemented the requested change.",
					provider: "openai",
					model: "gpt-test",
					at: NOW,
				},
			},
			{
				type: "skill" as const,
				event: {
					type: "agent_v2.skill_applied" as const,
					name: "ui-polish",
					location: "skill://ui-polish/SKILL.md",
					at: NOW,
				},
			},
			{
				type: "resource" as const,
				event: {
					type: "agent_v2.skill_resource_loaded" as const,
					name: "ui-polish",
					path: "references/colors.md",
					checksum: `sha256:${"a".repeat(64)}`,
					at: NOW,
				},
			},
		];
		for (const action of repeatedActions) {
			store = reduceAgentV2RunPresentation(store, { ...action, runId: "run-1" });
			store = reduceAgentV2RunPresentation(store, { ...action, runId: "run-1" });
		}

		const run = store.runs.get("run-1");
		expect(run?.tasks.get("task-1")?.status).toBe("succeeded");
		expect(run?.artifacts.get("artifact-1")).toMatchObject({ action: "updated", validationStatus: "passed" });
		expect(Array.from(run?.validations.get("validation-1")?.values() ?? [])).toMatchObject([
			{ attempt: 1, status: "failed" },
			{ attempt: 2, status: "warning" },
		]);
		expect(run?.diagnostics.size).toBe(1);
		expect(run?.outputs.size).toBe(1);
		expect(run?.skills.size).toBe(1);
		expect(run?.resources.size).toBe(1);
	});

	it.each<AgentV2RunStatus>(["succeeded", "failed", "cancelled", "interrupted"])(
		"settles %s runs and produces JSON-safe terminal output",
		(status) => {
			let store = reduceAgentV2RunPresentation(createAgentV2RunPresentationStore(), {
				type: "begin",
				runId: `run-${status}`,
				phase: "delivery",
				status: "running",
				at: NOW,
			});
			store = reduceAgentV2RunPresentation(store, {
				type: "settle",
				runId: `run-${status}`,
				status,
				at: NOW,
			});

			const terminal = serializeAgentV2TerminalRunPresentation(store, `run-${status}`);

			expect(terminal).toMatchObject({ runId: `run-${status}`, status, active: false });
			expect(containsMap(terminal)).toBe(false);
			expect(() => JSON.stringify(terminal)).not.toThrow();
		},
	);
});

function task(status: "running" | "succeeded") {
	return {
		type: "agent_v2.task_updated" as const,
		taskId: "task-1",
		kind: "implementation" as const,
		status,
		phase: "implementation" as const,
		at: NOW,
	};
}

function artifact(action: "created" | "updated", validationStatus: "pending" | "passed") {
	return {
		type: "agent_v2.artifact_indexed" as const,
		artifactId: "artifact-1",
		path: "index.html",
		validationStatus,
		revision: action === "created" ? "revision-1" : "revision-2",
		checksum: `sha256:${action === "created" ? "a".repeat(64) : "b".repeat(64)}`,
		action,
		sourceTaskId: "task-1",
		at: NOW,
	};
}

function validation(attempt: number, status: "failed" | "passed" | "warning") {
	return {
		type: "agent_v2.validation_recorded" as const,
		validationId: "validation-1",
		taskId: "task-1",
		attempt,
		status,
		summary: `${status} validation`,
		at: NOW,
	};
}

function containsMap(value: unknown): boolean {
	if (value instanceof Map) return true;
	if (Array.isArray(value)) return value.some(containsMap);
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(containsMap);
}
