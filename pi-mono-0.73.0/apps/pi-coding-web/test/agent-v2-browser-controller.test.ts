import type {
	AgentV2Error,
	AgentV2RunEventRecord,
	AgentV2RunSnapshot,
	AgentV2RunStatus,
} from "@mariozechner/pi-web-workspace";
import { describe, expect, it, vi } from "vitest";
import {
	AgentV2BrowserController,
	type AgentV2BrowserRunSink,
	agentV2OutputToAssistantMessage,
	settleAgentV2BrowserTerminalSnapshot,
} from "../src/runtime/agent-v2-browser-controller.js";

describe("AgentV2BrowserController", () => {
	it("starts exactly one run and rejects events for another run", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);

		controller.start(createRun());

		expect(sink.beginRun).toHaveBeenCalledWith("run-1", NOW);
		expect(sink.setPhase).toHaveBeenCalledWith("intake", "queued", NOW);
		expect(() => controller.start(createRun({ runId: "run-2" }))).toThrow("run-1 is already active");
		expect(() =>
			controller.apply(
				event(1, {
					type: "agent_v2.phase_changed",
					phase: "implementation",
					at: NOW,
				}, "run-2"),
			),
		).toThrow("run-2 does not match active run run-1");
		expect(controller.lastSeq).toBe(0);
	});

	it("strictly projects v2 event payloads without treating them as provider events", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun());

		const task = {
			type: "agent_v2.task_updated",
			taskId: "task-1",
			kind: "implementation",
			status: "running",
			phase: "implementation",
			at: NOW,
		} as const;
		const artifact = {
			type: "agent_v2.artifact_indexed",
			artifactId: "artifact-1",
			path: "index.html",
			validationStatus: "pending",
			revision: "rev-1",
			checksum: `sha256:${"b".repeat(64)}`,
			action: "created",
			sourceTaskId: "task-1",
			at: NOW,
		} as const;
		const validation = {
			type: "agent_v2.validation_recorded",
			validationId: "validation-1",
			taskId: "task-1",
			attempt: 1,
			status: "passed",
			summary: "Static validation passed.",
			at: NOW,
		} as const;
		const diagnostic = {
			type: "agent_v2.diagnostic_recorded",
			diagnosticId: "diagnostic-1",
			severity: "warn",
			code: "agent_v2.validation_warning",
			message: "One optional check was skipped.",
			at: NOW,
		} as const;
		const output = {
			type: "agent_v2.output_recorded",
			taskId: "task-1",
			summary: "Application generated successfully.",
			provider: "openai",
			model: "gpt-test",
			usage: { input: 12, output: 34, totalTokens: 46, costTotal: 0.01 },
			at: NOW,
		} as const;
		const skill = {
			type: "agent_v2.skill_applied",
			name: "ui-polish",
			location: "skill://ui-polish/SKILL.md",
			at: NOW,
		} as const;
		const resource = {
			type: "agent_v2.skill_resource_loaded",
			name: "ui-polish",
			path: "references/colors.md",
			checksum: `sha256:${"a".repeat(64)}`,
			at: NOW,
		} as const;
		const report = {
			type: "agent_v2.delivery_reported",
			taskId: "deliver",
			completedSummary: "Created a static application.",
			appliedSkills: ["ui-polish"],
			createdFiles: ["index.html"],
			updatedFiles: [],
			validationStatus: "passed",
			buildStatus: "not_required",
			previewStatus: "running",
			previewReadiness: { verified: true, ready: true, reasonCode: "ready" },
			previewUrl: "http://localhost/preview/app/",
			projectId: "app",
			usageInstructions: "Open the preview URL.",
			at: NOW,
		} as const;

		controller.apply(
			event(1, {
				type: "agent_v2.run_created",
				status: "queued",
				phase: "intake",
				attempt: 0,
				at: NOW,
			}),
		);
		controller.apply(event(2, { type: "agent_v2.planning_ready", phase: "spec_draft", at: NOW }));
		controller.apply(
			event(3, { type: "agent_v2.phase_changed", phase: "implementation", status: "running", at: NOW }),
		);
		controller.apply(event(4, task));
		controller.apply(event(5, artifact));
		controller.apply(event(6, validation));
		controller.apply(event(7, diagnostic));
		controller.apply(event(8, output));
		controller.apply(event(9, skill));
		controller.apply(event(10, resource));
		controller.apply(event(11, report));

		expect(sink.setPhase.mock.calls).toEqual([
			["intake", "queued", NOW],
			["intake", "queued", NOW],
			["spec_draft", "queued", NOW],
			["implementation", "running", NOW],
		]);
		expect(sink.setTask).toHaveBeenCalledWith(task);
		expect(sink.setArtifact).toHaveBeenCalledWith(artifact);
		expect(sink.setValidation).toHaveBeenCalledWith(validation);
		expect(sink.appendDiagnostic).toHaveBeenCalledWith(diagnostic);
		expect(sink.appendOutput).toHaveBeenCalledWith(output);
		expect(sink.setSkill).toHaveBeenCalledWith(skill);
		expect(sink.setSkillResource).toHaveBeenCalledWith(resource);
		expect(sink.setDeliveryReport).toHaveBeenCalledWith(report);
		expect(controller.lastSeq).toBe(11);
	});

	it("accepts a durable diagnostic reference without mistaking it for a projected browser event", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running", phase: "validation" }));

		controller.apply({
			clientId: "client-1",
			runId: "run-1",
			seq: 1,
			type: "diagnostic",
			payload: { diagnosticId: "agent_v2.worker_cancel_poll_timeout:run-1" },
			createdAt: NOW,
		});
		controller.apply(event(2, phasePayload("validation")));

		expect(controller.lastSeq).toBe(2);
		expect(sink.appendDiagnostic).not.toHaveBeenCalled();
		expect(sink.setPhase).toHaveBeenLastCalledWith("validation", "running", NOW);
	});

	it("rejects malformed durable diagnostic references without advancing the checkpoint", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running", phase: "validation" }));

		expect(() =>
			controller.apply({
				clientId: "client-1",
				runId: "run-1",
				seq: 1,
				type: "diagnostic",
				payload: { diagnosticId: "diagnostic-1", message: "unexpected duplicate payload" },
				createdAt: NOW,
			}),
		).toThrow("Invalid diagnostic payload fields");
		expect(controller.lastSeq).toBe(0);
	});

	it("sorts hydration input, de-duplicates records, and resumes from a durable checkpoint", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running", phase: "implementation" }));
		const first = event(1, phasePayload("spec_draft"));
		const second = event(2, phasePayload("implementation"));

		controller.hydrate([second, first, second], 7);
		controller.apply(event(7, phasePayload("repair")));
		controller.apply(event(8, phasePayload("validation")));

		expect(sink.setPhase.mock.calls).toEqual([
			["implementation", "running", NOW],
			["spec_draft", "running", NOW],
			["implementation", "running", NOW],
			["validation", "running", NOW],
		]);
		expect(controller.lastSeq).toBe(8);
	});

	it("does not advance its checkpoint when payload validation or a sink projection fails", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun());

		expect(() =>
			controller.apply(
				event(1, {
					type: "agent_v2.task_updated",
					taskId: "task-1",
					kind: "implementation",
					status: "not-a-status",
					phase: "implementation",
					at: NOW,
				}),
			),
		).toThrow("Invalid agent_v2.task_updated.status");
		expect(controller.lastSeq).toBe(0);

		sink.setPhase.mockImplementationOnce(() => {
			throw new Error("projection storage unavailable");
		});
		expect(() => controller.apply(event(1, phasePayload("implementation")))).toThrow(
			"projection storage unavailable",
		);
		expect(controller.lastSeq).toBe(0);
	});

	it("rejects an outer event type that does not exactly match the narrowed payload type", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun());
		const mismatched = event(1, phasePayload("implementation"));
		mismatched.type = "agent_v2.output_recorded";

		expect(() => controller.apply(mismatched)).toThrow("does not match payload type");
		expect(controller.lastSeq).toBe(0);
	});

	it("settles terminal state through the v2 sink without synthesizing provider lifecycle events", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		const failure: AgentV2Error = { code: "agent_v2.failed", message: "Validation failed.", retryable: false };
		controller.start(createRun({ status: "running", phase: "validation" }));

		controller.settle("failed", NOW, failure);

		expect(sink.settle).toHaveBeenCalledWith("failed", NOW, failure);
		expect(controller.activeRunId).toBeUndefined();
		expect(controller.lastSeq).toBe(0);
		expect(JSON.stringify(sink.calls)).not.toMatch(/agent_start|message_end|agent_end/);
	});

	it("keeps the run active when terminal sink settlement fails", () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running" }));
		sink.settle.mockImplementationOnce(() => {
			throw new Error("terminal projection failed");
		});

		expect(() => controller.settle("succeeded", NOW)).toThrow("terminal projection failed");
		expect(controller.activeRunId).toBe("run-1");
	});

	it("retries a terminal snapshot after event projection fails without closing or duplicating projected events", async () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running", phase: "implementation" }));
		const task = event(1, {
			type: "agent_v2.task_updated",
			taskId: "task-1",
			kind: "implementation",
			status: "succeeded",
			phase: "implementation",
			at: NOW,
		});
		const output = event(2, {
			type: "agent_v2.output_recorded",
			taskId: "task-1",
			summary: "Application generated successfully.",
			provider: "openai",
			model: "gpt-test",
			at: NOW,
		});
		let successfulOutputProjections = 0;
		sink.appendOutput
			.mockImplementationOnce(() => {
				throw new Error("projection storage unavailable");
			})
			.mockImplementation(() => {
				successfulOutputProjections += 1;
			});
		const drain = vi.fn(async () => {
			const afterSeq = controller.lastSeq;
			try {
				controller.hydrate(
					[task, output].filter((record) => record.seq > afterSeq),
					afterSeq,
				);
				return { ok: true as const, afterSeq: controller.lastSeq };
			} catch (error) {
				return { ok: false as const, afterSeq, error };
			}
		});
		const onSettled = vi.fn();

		const first = await settleAgentV2BrowserTerminalSnapshot({
			controller,
			runId: "run-1",
			status: "succeeded",
			at: NOW,
			drain,
			onSettled,
		});

		expect(first.status).toBe("retry");
		expect(controller.activeRunId).toBe("run-1");
		expect(controller.lastSeq).toBe(1);
		expect(sink.setTask).toHaveBeenCalledTimes(1);
		expect(sink.settle).not.toHaveBeenCalled();
		expect(onSettled).not.toHaveBeenCalled();

		const second = await settleAgentV2BrowserTerminalSnapshot({
			controller,
			runId: "run-1",
			status: "succeeded",
			at: NOW,
			drain,
			onSettled,
		});
		const duplicate = await settleAgentV2BrowserTerminalSnapshot({
			controller,
			runId: "run-1",
			status: "succeeded",
			at: NOW,
			drain,
			onSettled,
		});

		expect(second.status).toBe("settled");
		expect(duplicate.status).toBe("inactive");
		expect(drain).toHaveBeenCalledTimes(2);
		expect(sink.setTask).toHaveBeenCalledTimes(1);
		expect(successfulOutputProjections).toBe(1);
		expect(sink.settle).toHaveBeenCalledTimes(1);
		expect(onSettled).toHaveBeenCalledTimes(1);
		expect(controller.activeRunId).toBeUndefined();
	});

	it("does not close a terminal run when terminal sink settlement fails", async () => {
		const sink = createSink();
		const controller = new AgentV2BrowserController(sink);
		controller.start(createRun({ status: "running" }));
		sink.settle.mockImplementationOnce(() => {
			throw new Error("terminal projection failed");
		});
		const onSettled = vi.fn();

		await expect(
			settleAgentV2BrowserTerminalSnapshot({
				controller,
				runId: "run-1",
				status: "succeeded",
				at: NOW,
				drain: async () => ({ ok: true, afterSeq: 0 }),
				onSettled,
			}),
		).rejects.toThrow("terminal projection failed");

		expect(controller.activeRunId).toBe("run-1");
		expect(onSettled).not.toHaveBeenCalled();
	});

	it("maps output DTOs to local assistant display records with the trusted v2 model summary", () => {
		const message = agentV2OutputToAssistantMessage({
			type: "agent_v2.output_recorded",
			taskId: "task-1",
			summary: "Generated application is ready.",
			provider: "openai",
			model: "gpt-test",
			usage: { input: 12, output: 34, totalTokens: 46, costTotal: 0.25 },
			at: NOW,
		});

		expect(message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Generated application is ready." }],
			api: "agent-v2",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 12,
				output: 34,
				totalTokens: 46,
				cost: { total: 0.25 },
			},
			stopReason: "stop",
			timestamp: Date.parse(NOW),
		});
		expect(JSON.stringify(message)).not.toMatch(/agent_start|message_end|agent_end/);
	});
});

const NOW = "2026-07-15T00:00:00.000Z";

function createRun(overrides: Partial<AgentV2RunSnapshot> = {}): AgentV2RunSnapshot {
	return {
		clientId: "client-1",
		runId: "run-1",
		status: "queued",
		phase: "intake",
		attempt: 0,
		input: {},
		model: {},
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function event(seq: number, payload: Record<string, unknown>, runId = "run-1"): AgentV2RunEventRecord {
	return {
		clientId: "client-1",
		runId,
		seq,
		type: String(payload.type),
		payload,
		createdAt: NOW,
	};
}

function phasePayload(phase: string): Record<string, unknown> {
	return { type: "agent_v2.phase_changed", phase, status: "running", at: NOW };
}

function createSink() {
	const calls: string[] = [];
	const record = (name: string) => {
		calls.push(name);
	};
	return {
		calls,
		beginRun: vi.fn(() => record("beginRun")),
		setPhase: vi.fn(() => record("setPhase")),
		setTask: vi.fn(() => record("setTask")),
		setArtifact: vi.fn(() => record("setArtifact")),
		setValidation: vi.fn(() => record("setValidation")),
		appendOutput: vi.fn(() => record("appendOutput")),
		appendDiagnostic: vi.fn(() => record("appendDiagnostic")),
		setSkill: vi.fn(() => record("setSkill")),
		setSkillResource: vi.fn(() => record("setSkillResource")),
		setDeliveryReport: vi.fn(() => record("setDeliveryReport")),
		settle: vi.fn((_status: AgentV2RunStatus, _at: string, _error?: AgentV2Error) => record("settle")),
	} satisfies AgentV2BrowserRunSink;
}
