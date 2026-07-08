import { describe, expect, it } from "vitest";
import { buildAgentV2ContextPacket } from "../src/agent-v2-context-packet.js";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2ArtifactRecord, AgentV2DocumentRecord } from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "../src/agent-v2-types.js";

describe("agent v2 context packet", () => {
	it("builds deterministic context from v2 records only", () => {
		const run = runSnapshot();
		const tasks = [
			task({ taskId: "capability", status: "succeeded" }),
			task({
				taskId: "spec",
				status: "running",
				dependsOn: ["capability"],
				acceptanceCriteria: ["Spec describes static preview scope."],
			}),
		];
		const packet = buildAgentV2ContextPacket({
			run,
			tasks,
			documents: [
				document({ documentId: "plan", kind: "plan", contentMarkdown: "# Plan\nBuild static app." }),
				document({ documentId: "spec", kind: "spec", contentMarkdown: "# Spec\nStatic dashboard." }),
				document({
					documentId: "capability_decision",
					kind: "capability_decision",
					contentMarkdown: "# Capability\nstatic_app",
				}),
				document({ documentId: "tasks", kind: "tasks", contentMarkdown: "# Tasks\nspec" }),
			],
			artifacts: [
				artifact({ artifactId: "spec-md", sourceTaskId: "spec", path: "agent-v2/spec.md" }),
				artifact({ artifactId: "plan-md", sourceTaskId: "plan", path: "agent-v2/plan.md" }),
			],
			diagnostics: [],
		});

		expect(packet.run.runId).toBe("run-v2");
		expect(packet.taskSelection).toEqual({
			task: expect.objectContaining({ taskId: "spec" }),
			reason: "running",
			blockedTaskIds: [],
			failedDependencyTaskIds: [],
		});
		expect(packet.documents).toEqual({
			capabilityDecision: expect.objectContaining({ documentId: "capability_decision" }),
			spec: expect.objectContaining({ documentId: "spec" }),
			plan: expect.objectContaining({ documentId: "plan" }),
			tasks: expect.objectContaining({ documentId: "tasks" }),
		});
		expect(packet.activeTaskArtifacts.map((item) => item.artifactId)).toEqual(["spec-md"]);
		expect(packet.requiredRereads).toEqual([
			{ kind: "document", id: "spec", reason: "active task context" },
			{ kind: "artifact", id: "spec-md", path: "agent-v2/spec.md", reason: "active task artifact" },
		]);
		expect(packet.markdown).toContain("## Active Task\n- `spec` running");
		expect(packet.markdown).toContain("## Required Rereads\n- document `spec`: active task context");
	});

	it("extracts open problems from failed tasks and warn/error diagnostics", () => {
		const packet = buildAgentV2ContextPacket({
			run: runSnapshot(),
			documents: [],
			artifacts: [],
			tasks: [
				task({
					taskId: "validate",
					status: "failed",
					error: { code: "VALIDATION_FAILED", message: "Build failed", retryable: true },
				}),
			],
			diagnostics: [
				diagnostic({ diagnosticId: "debug", severity: "debug", code: "IGNORED", message: "ignored" }),
				diagnostic({
					diagnosticId: "warn",
					severity: "warn",
					code: "MISSING_ARTIFACT",
					message: "Artifact missing",
					taskId: "validate",
				}),
				diagnostic({
					diagnosticId: "error",
					severity: "error",
					code: "BUILD_FAILED",
					message: "Build failed",
					taskId: "validate",
					artifactId: "app",
				}),
			],
		});

		expect(packet.openProblems).toEqual([
			{
				source: "task",
				severity: "error",
				code: "VALIDATION_FAILED",
				message: "Build failed",
				taskId: "validate",
			},
			{
				source: "diagnostic",
				severity: "warn",
				code: "MISSING_ARTIFACT",
				message: "Artifact missing",
				taskId: "validate",
			},
			{
				source: "diagnostic",
				severity: "error",
				code: "BUILD_FAILED",
				message: "Build failed",
				taskId: "validate",
				artifactId: "app",
			},
		]);
	});

	it("adds rereads for active artifact tasks and keeps the packet markdown populated", () => {
		const packet = buildAgentV2ContextPacket({
			run: runSnapshot(),
			documents: [
				document({ documentId: "spec", kind: "spec", contentMarkdown: "# Spec\nStatic dashboard." }),
				document({ documentId: "plan", kind: "plan", contentMarkdown: "# Plan\nBuild static app." }),
			],
			artifacts: [
				artifact({
					artifactId: "artifact-task-md",
					sourceTaskId: "artifact-task",
					path: "agent-v2/artifact-task.md",
				}),
			],
			tasks: [
				task({
					taskId: "artifact-task",
					kind: "artifact",
					status: "running",
					dependsOn: ["plan"],
					acceptanceCriteria: ["Artifact task produces indexed output."],
				}),
			],
			diagnostics: [],
		});

		expect(packet.activeTask).toEqual(expect.objectContaining({ taskId: "artifact-task", kind: "artifact" }));
		expect(packet.requiredRereads).toEqual([
			{ kind: "document", id: "plan", reason: "active task context" },
			{
				kind: "artifact",
				id: "artifact-task-md",
				path: "agent-v2/artifact-task.md",
				reason: "active task artifact",
			},
		]);
		expect(packet.markdown).toContain("## Active Task\n- `artifact-task` running");
		expect(packet.markdown).toContain("## Required Rereads");
		expect(packet.markdown).toContain("document `plan`: active task context");
		expect(packet.markdown).toContain(
			"artifact `artifact-task-md` (agent-v2/artifact-task.md): active task artifact",
		);
	});

	it("includes the task selection reason in markdown when no task is active", () => {
		const packet = buildAgentV2ContextPacket({
			run: runSnapshot(),
			documents: [],
			artifacts: [],
			tasks: [
				task({ taskId: "capability", status: "succeeded" }),
				task({ taskId: "spec", status: "succeeded", dependsOn: ["capability"] }),
			],
			diagnostics: [],
		});

		expect(packet.taskSelection.reason).toBe("complete");
		expect(packet.activeTask).toBeUndefined();
		expect(packet.markdown).toContain("## Active Task\n- none (complete)");
	});
});

function runSnapshot(): AgentV2RunSnapshot {
	return {
		clientId: "client-a",
		runId: "run-v2",
		status: "running",
		phase: "implementation",
		attempt: 1,
		input: { prompt: "Build a static dashboard" },
		model: { provider: "test", model: "local" },
		createdAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:00.000Z",
	};
}

function task(input: Partial<AgentV2TaskNode> & { taskId: string }): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		kind: input.kind ?? "implementation",
		title: input.title ?? input.taskId,
		status: input.status ?? "pending",
		dependsOn: input.dependsOn ?? [],
		acceptanceCriteria: input.acceptanceCriteria ?? [],
		input: input.input ?? {},
		output: input.output ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
		startedAt: input.startedAt,
		endedAt: input.endedAt,
		error: input.error,
	};
}

function document(
	input: Partial<AgentV2DocumentRecord> & { documentId: string; kind: AgentV2DocumentRecord["kind"] },
): AgentV2DocumentRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		documentId: input.documentId,
		kind: input.kind,
		version: input.version ?? "1",
		contentMarkdown: input.contentMarkdown ?? "",
		contentJson: input.contentJson ?? ({ kind: input.kind } as AgentV2DocumentRecord["contentJson"]),
		sourceTaskId: input.sourceTaskId,
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}

function artifact(input: Partial<AgentV2ArtifactRecord> & { artifactId: string }): AgentV2ArtifactRecord {
	return {
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		artifactId: input.artifactId,
		kind: input.kind ?? "document",
		path: input.path ?? `agent-v2/${input.artifactId}.md`,
		mediaType: input.mediaType ?? "text/markdown",
		checksum: input.checksum ?? `sha256:${input.artifactId}`,
		version: input.version ?? "1",
		sourceTaskId: input.sourceTaskId,
		validationStatus: input.validationStatus ?? "accepted",
		metadataJson: input.metadataJson ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
		updatedAt: input.updatedAt ?? "2026-07-08T00:00:00.000Z",
	};
}

function diagnostic(
	input: Partial<AgentV2DiagnosticEvent> & {
		diagnosticId: string;
		severity: AgentV2DiagnosticEvent["severity"];
		code: string;
		message: string;
	},
): AgentV2DiagnosticEvent {
	return {
		diagnosticId: input.diagnosticId,
		clientId: input.clientId ?? "client-a",
		runId: input.runId ?? "run-v2",
		severity: input.severity,
		category: input.category ?? "task_graph",
		code: input.code,
		phase: input.phase,
		taskId: input.taskId,
		artifactId: input.artifactId,
		traceId: input.traceId,
		message: input.message,
		data: input.data ?? {},
		createdAt: input.createdAt ?? "2026-07-08T00:00:00.000Z",
	};
}
