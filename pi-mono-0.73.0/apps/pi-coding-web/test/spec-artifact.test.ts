import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { planCapabilities } from "../src/runtime/capability-planner.js";
import {
	buildSpecArtifact,
	completedSpecExecutionReadsFromMessages,
	formatSpecArtifactForPrompt,
	parseSpecArtifactProjectFiles,
} from "../src/runtime/spec-artifact.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";

describe("spec artifact", () => {
	it("turns a full-stack dashboard prompt into static-preview acceptance criteria", () => {
		const messages = [
			userMessage(
				"Build a full-stack quality dashboard with backend APIs, PostgreSQL persistence, auth, KPI cards, charts, and CSV export.",
			),
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const spec = buildSpecArtifact({
			messages,
			capabilityPlan,
			platform: STATIC_PREVIEW_CONTRACT,
		});

		expect(spec.objective).toContain("full-stack quality dashboard");
		expect(spec.deliveryMode).toBe("static_simulation");
		expect(spec.requirements.map((item) => item.text).join("\n")).toContain("KPI cards, charts, and CSV export");
		expect(spec.requirements.map((item) => item.text).join("\n")).toContain("deterministic first-screen data");
		expect(spec.platformLimitations.join("\n")).toContain("backend_server");
		expect(spec.platformLimitations.join("\n")).toContain("database_runtime");
		expect(spec.acceptanceCriteria.join("\n")).toContain("must not claim a real backend");
		expect(spec.acceptanceCriteria.join("\n")).toContain("without persistent loading placeholders");
		expect(spec.qualityGates).toEqual(
			expect.arrayContaining(["project_task validate", "static_preview_quality_gate", "static_preview_smoke_gate"]),
		);
	});

	it("renders a stable prompt section that can survive context compaction", () => {
		const messages = [userMessage("Create a static KPI dashboard with filters and export.")];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const spec = buildSpecArtifact({ messages, capabilityPlan, platform: STATIC_PREVIEW_CONTRACT });

		const rendered = formatSpecArtifactForPrompt(spec);

		expect(rendered).toContain("<spec_artifact>");
		expect(rendered).toContain("schema_version: 1");
		expect(rendered).toContain("objective: Create a static KPI dashboard with filters and export.");
		expect(rendered).toContain("acceptance_criteria:");
		expect(rendered).toContain("quality_gates:");
		expect(rendered).toContain("</spec_artifact>");
	});

	it("extracts a clean implementation spec from a PM handoff wrapper", () => {
		const messages = [
			{
				...userMessage(`You are a senior full-stack engineer responsible for implementing a delivered PM handoff.

Session title: QDM Finished Lot Yield Dashboard

Read these files fully before writing code:
1. docs/Requirements Document-20260611-022831-597996.md
2. docs/Design Document-20260611-022850-817700.md

Execution rules:
1. Do not summarize the documents.
2. Run validation before final response.`),
				attachments: [
					{
						type: "document",
						fileName: "Requirements Document-20260611-022831-597996.md",
						projectFilePath: "docs/Requirements Document-20260611-022831-597996.md",
						extractedText: "# Requirements\nBuild a QDM finished lot yield dashboard with KPI cards and charts.",
					},
					{
						type: "document",
						fileName: "Design Document-20260611-022850-817700.md",
						projectFilePath: "docs/Design Document-20260611-022850-817700.md",
						extractedText: "# Design\nUse a production dashboard layout.",
					},
				],
			} as AgentMessage,
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const spec = buildSpecArtifact({
			messages,
			capabilityPlan,
			platform: STATIC_PREVIEW_CONTRACT,
		});

		const requirementText = spec.requirements.map((item) => item.text).join("\n");
		expect(spec.objective).toBe("QDM Finished Lot Yield Dashboard");
		expect(spec.sourceDocuments).toEqual([
			"docs/Requirements Document-20260611-022831-597996.md",
			"docs/Design Document-20260611-022850-817700.md",
		]);
		expect(requirementText).toContain("QDM Finished Lot Yield Dashboard");
		expect(requirementText).not.toContain("You are a senior full-stack engineer");
		expect(requirementText).not.toContain("Read these files fully");
		expect(requirementText).not.toContain("Execution rules");
		expect(requirementText).not.toContain("md 2");
	});

	it("uses PM handoff session title and filters document metadata from source requirements", () => {
		const messages = [
			{
				...userMessage(`You are a senior full-stack engineer responsible for implementing a runnable project strictly from the provided documents.

Read these files fully before writing code:
1. PRD document: Requirements Document-20260611-022831-597996.md
2. System design document: Design Document-20260611-022850-817700.md

Project context:
- Session ID: cfa5ca09-c4f0-4878-8fc1-f371b446741e
- Session title: QDM Finished Lot Yield Dashboard...

Implementation requirements:
1. Before coding, extract a concrete implementation checklist.`),
				attachments: [
					{
						type: "document",
						fileName: "Requirements Document-20260611-022831-597996.md",
						projectFilePath: "docs/Requirements Document-20260611-022831-597996.md",
						extractedText: `# D.CHQ.QDM Finish Yield Dashboard Requirement

## 1. Basic Document Information

| Field | Value |
| --- | --- |
| Template name | QDM Finished Lot Yield Dashboard Requirement Template |
| Document name | D.CHQ.QDM Finish Yield Dashboard Requirement |

## 2. Background and Objectives

The dashboard provides a high-level view of key yield metrics for various products.

### 2.2 Objectives
* **Improve Yield:** Visualize trends to drive a steeper improvement curve.
* **Cost Reduction:** Lower production costs by identifying and mitigating loss.

## 3. Page / Function Presentation

### 3.1 Finished Lot Performance Overview Trend
* **Purpose:** Display finished yield trends and latest-week KPIs (Output, Yield, NSQM Loss).`,
					},
					{
						type: "document",
						fileName: "Design Document-20260611-022850-817700.md",
						projectFilePath: "docs/Design Document-20260611-022850-817700.md",
						extractedText: `# System Design Document

> This design draft is assembled from the structured requirement model first, then refined by the LLM.
> Missing or unconfirmed information is explicitly marked as TBD.

## 1. Scope and Objectives

- **Project Name:** D.CHQ.QDM Finished Lot Yield Dashboard
- **Requirement Name:** Finished Lot Performance Overview and Defect Loss Ratio Dashboard
- **Objective:** Drive yield improvement, reduce production costs, and increase output by exposing overall yield trends.`,
					},
				],
			} as AgentMessage,
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		const spec = buildSpecArtifact({ messages, capabilityPlan, platform: STATIC_PREVIEW_CONTRACT });

		const requirementText = spec.requirements.map((item) => item.text).join("\n");
		expect(spec.objective).toBe("QDM Finished Lot Yield Dashboard");
		expect(requirementText).toContain("D.CHQ.QDM Finish Yield Dashboard Requirement");
		expect(requirementText).toContain("Display finished yield trends and latest-week KPIs");
		expect(requirementText).not.toContain("PRD document");
		expect(requirementText).not.toContain("Basic Document Information");
		expect(requirementText).not.toContain("System Design Document");
		expect(requirementText).not.toContain("This design draft is assembled");
	});

	it("restores completed spec execution reads from prior successful project_file get results", () => {
		const messages = [
			assistantToolCall("read-spec", "docs/spec.md"),
			toolResult("read-spec", false),
			assistantToolCall("read-plan", "docs/plan.md"),
			toolResult("read-plan", false),
			assistantToolCall("read-tasks", "docs/tasks.md"),
			toolResult("read-tasks", true),
		];

		const completed = completedSpecExecutionReadsFromMessages(messages, {
			readCommand: "project_file get",
			requiredBeforeImplementation: true,
			requiredReads: ["docs/spec.md", "docs/plan.md", "docs/tasks.md"],
		});

		expect(completed).toEqual(["docs/spec.md", "docs/plan.md"]);
	});

	it("reconstructs a generated spec artifact from seeded project files", () => {
		const fallbackMessages = [
			userMessage(`Read these files fully before writing code:
1. PRD document: Requirements Document-20260611-022831-597996.md
2. System design document: Design Document-20260611-022850-817700.md`),
		];
		const fallbackCapabilityPlan = planCapabilities({
			messages: fallbackMessages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const fallback = buildSpecArtifact({
			messages: fallbackMessages,
			capabilityPlan: fallbackCapabilityPlan,
			platform: STATIC_PREVIEW_CONTRACT,
		});

		const spec = parseSpecArtifactProjectFiles(
			[
				{
					filename: "docs/spec.md",
					content: `# Specification

Objective: QDM Finished Lot Yield Dashboard
Delivery mode: static_simulation

## Source Documents

- docs/Requirements Document-20260611-022831-597996.md
- docs/Design Document-20260611-022850-817700.md

## Requirements

- REQ-001 [data] Render the QDM finished lot yield dashboard with KPI cards and charts.
- REQ-002 [quality] Keep first-screen metrics deterministic and populated.

## Platform Limitations

- Current adapter static-preview can serve static browser assets and static build output only.

## Acceptance Criteria

- First preview must render meaningful first-screen data without persistent loading placeholders or \`--\` KPI values.

## Quality Gates

- project_task validate
- static_preview_quality_gate
- static_preview_smoke_gate

## Non Goals

- Do not implement database_runtime as a claimed real runtime.
`,
				},
				{
					filename: "docs/plan.md",
					content: `# Implementation Plan

Objective: QDM Finished Lot Yield Dashboard
Delivery mode: static_simulation

## Plan

- Read source documents before implementation.
- Run and satisfy quality gates in order.
`,
				},
				{
					filename: "docs/tasks.md",
					content: `# Tasks

- [ ] Read \`docs/spec.md\`, \`docs/plan.md\`, and \`docs/tasks.md\`.
- [ ] Confirm first preview renders meaningful data.
`,
				},
			],
			fallback,
		);

		expect(spec.objective).toBe("QDM Finished Lot Yield Dashboard");
		expect(spec.objective).not.toContain("PRD document");
		expect(spec.sourceDocuments).toEqual([
			"docs/Requirements Document-20260611-022831-597996.md",
			"docs/Design Document-20260611-022850-817700.md",
		]);
		expect(spec.requirements).toEqual([
			{
				id: "REQ-001",
				kind: "data",
				text: "Render the QDM finished lot yield dashboard with KPI cards and charts.",
			},
			{
				id: "REQ-002",
				kind: "quality",
				text: "Keep first-screen metrics deterministic and populated.",
			},
		]);
		expect(spec.implementationPlan).toEqual([
			"Read source documents before implementation.",
			"Run and satisfy quality gates in order.",
		]);
		expect(spec.taskChecklist).toEqual([
			"Read `docs/spec.md`, `docs/plan.md`, and `docs/tasks.md`.",
			"Confirm first preview renders meaningful data.",
		]);
		expect(spec.deliveryMode).toBe("static_simulation");
	});
});

function userMessage(content: string): AgentMessage {
	return {
		role: "user",
		content,
		timestamp: 1,
	} as AgentMessage;
}

function assistantToolCall(id: string, filename: string): AgentMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "project_file",
				arguments: { command: "get", filename },
			},
		],
		stopReason: "toolUse",
		timestamp: 1,
	} as AgentMessage;
}

function toolResult(toolCallId: string, isError: boolean): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text: "ok" }],
		toolCallId,
		toolName: "project_file",
		isError,
		timestamp: 1,
	} as AgentMessage;
}
