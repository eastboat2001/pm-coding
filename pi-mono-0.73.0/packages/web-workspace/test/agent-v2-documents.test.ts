import { describe, expect, it } from "vitest";
import { routeAgentV2Capabilities } from "../src/agent-v2-capability-router.js";
import {
	buildAgentV2PlanDocument,
	buildAgentV2SpecDocument,
	buildAgentV2TaskGraph,
	renderAgentV2DocumentMarkdown,
} from "../src/agent-v2-documents.js";
import type { AgentV2PlatformContract } from "../src/agent-v2-types.js";

const FIXED_NOW = () => "2026-07-07T00:00:00.000Z";
const CUSTOM_PLATFORM: AgentV2PlatformContract = {
	runtime: "static_browser_app",
	framework: "solid-js",
	deliveryMode: "build_static_frontend",
	entrypoints: ["index.html", "src/entry-client.tsx", "src/routes.tsx"],
	deliverables: ["solid frontend bundle", "storybook preview", "preview-ready assets"],
	constraints: ["No backend runtime is available.", "Use static assets only."],
	supportedDeliveryModes: ["build_static_frontend", "static_simulation"],
	unsupportedCapabilities: ["backend_server"],
	userVisibleContract: "Ship a Solid frontend bundle with explicit static-only behavior.",
	metadata: {
		contractId: "solid-static",
	},
};

describe("Agent v2 document builders", () => {
	it("builds a spec with objective, scope, non-goals, assumptions, and acceptance criteria", () => {
		const objective = "Build a sales dashboard with charts and mock revenue data.";
		const decision = routeAgentV2Capabilities({ objective });

		const spec = buildAgentV2SpecDocument({ runId: "run-1", objective, decision, now: FIXED_NOW });

		expect(spec.kind).toBe("spec");
		expect(spec.objective).toContain("sales dashboard");
		expect(spec.scope.length).toBeGreaterThan(1);
		expect(spec.nonGoals.length).toBeGreaterThan(1);
		expect(spec.assumptions.length).toBeGreaterThan(1);
		expect(spec.acceptanceCriteria.length).toBeGreaterThan(3);
		expect(spec.platformContract.deliveryMode).toBe("static_app");
	});

	it("builds a plan with technical approach, file structure, data model, interaction flow, and validation strategy", () => {
		const objective = "Build a SaaS app with login auth and PostgreSQL database.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-plan", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-plan", spec, decision, now: FIXED_NOW });

		expect(plan.technicalApproach).toEqual(
			expect.arrayContaining([
				expect.stringContaining("deterministic"),
				expect.stringContaining(decision.deliveryMode),
			]),
		);
		expect(plan.fileStructure).toEqual(expect.arrayContaining(spec.platformContract.entrypoints));
		expect(plan.dataModel).toEqual(
			expect.arrayContaining([
				expect.stringContaining("spec"),
				expect.stringContaining("plan"),
				expect.stringContaining("task"),
			]),
		);
		expect(plan.interactionFlow).toEqual(
			expect.arrayContaining([expect.stringContaining("capability"), expect.stringContaining("validate")]),
		);
		expect(plan.validationStrategy).toEqual(
			expect.arrayContaining([
				expect.stringContaining("acceptance criteria"),
				expect.stringContaining("simulation"),
			]),
		);
		expect(plan.risks.join(" ")).toContain("backend");
	});

	it("records static simulation limits directly in spec and plan", () => {
		const objective = "Build a SaaS app with login auth and PostgreSQL database.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-2", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-2", spec, decision, now: FIXED_NOW });

		expect(spec.capabilityBoundaries.join(" ")).toContain("static simulation");
		expect(plan.risks.join(" ")).toContain("backend");
	});

	it("creates a dependency ordered task graph consumed by later execution and repair flows", () => {
		const objective = "Build a static analytics dashboard.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-3", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-3", spec, decision, now: FIXED_NOW });
		const graph = buildAgentV2TaskGraph({ runId: "run-3", spec, plan, decision, now: FIXED_NOW });

		const implementTask = graph.tasks.find((task) => task.taskId === "implement");
		const validateTask = graph.tasks.find((task) => task.taskId === "validate");

		expect(graph.tasks.map((task) => task.taskId)).toEqual([
			"capability",
			"spec",
			"plan",
			"implement",
			"validate",
			"deliver",
		]);
		expect(implementTask?.dependsOn).toEqual(["plan"]);
		expect(implementTask?.acceptanceCriteria).toEqual(
			expect.arrayContaining([expect.stringContaining("objective"), expect.stringContaining("platform contract")]),
		);
		expect(validateTask?.acceptanceCriteria).toEqual(expect.arrayContaining(spec.acceptanceCriteria));
		expect(implementTask?.output).toEqual(
			expect.objectContaining({
				artifactIds: [],
				changedFiles: [],
				validationIds: [],
				failureReason: null,
				repairActions: [],
			}),
		);
		expect(graph.tasks.every((task) => Object.keys(task.output).length > 0)).toBe(true);
	});

	it("preserves the routed platform contract instead of reconstructing it from metadata defaults", () => {
		const objective = "Build a React analytics frontend with reusable charts.";
		const decision = routeAgentV2Capabilities({ objective, platform: CUSTOM_PLATFORM });
		const spec = buildAgentV2SpecDocument({ runId: "run-4", objective, decision, now: FIXED_NOW });

		expect(decision.platformContract).toEqual({
			...CUSTOM_PLATFORM,
			deliveryMode: "build_static_frontend",
		});
		expect(spec.platformContract.entrypoints).toEqual(CUSTOM_PLATFORM.entrypoints);
		expect(spec.platformContract.deliverables).toEqual(CUSTOM_PLATFORM.deliverables);
		expect(spec.platformContract.constraints).toEqual(CUSTOM_PLATFORM.constraints);
		expect(spec.platformContract.supportedDeliveryModes).toEqual(CUSTOM_PLATFORM.supportedDeliveryModes);
		expect(spec.platformContract.unsupportedCapabilities).toEqual(CUSTOM_PLATFORM.unsupportedCapabilities);
		expect(spec.platformContract.userVisibleContract).toBe(CUSTOM_PLATFORM.userVisibleContract);
		expect(spec.platformContract.metadata).toEqual(CUSTOM_PLATFORM.metadata);
	});

	it("renders deterministic markdown for capability decisions, specs, plans, and task graphs", () => {
		const objective = "Build a SaaS app with login auth and PostgreSQL database.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-5", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-5", spec, decision, now: FIXED_NOW });
		const graph = buildAgentV2TaskGraph({ runId: "run-5", spec, plan, decision, now: FIXED_NOW });
		const capabilityMarkdown = renderAgentV2DocumentMarkdown(decision);
		const specMarkdown = renderAgentV2DocumentMarkdown(spec);
		const planMarkdown = renderAgentV2DocumentMarkdown(plan);
		const taskMarkdown = renderAgentV2DocumentMarkdown(graph);

		expect(capabilityMarkdown).toContain("## Rationale");
		expect(capabilityMarkdown).toContain("## Evidence");
		expect(capabilityMarkdown).toContain("## Alternatives");
		expect(capabilityMarkdown).toContain("Unsupported Capabilities");
		expect(capabilityMarkdown).toContain("static simulation");

		expect(specMarkdown).toContain("## Goals");
		expect(specMarkdown).toContain("## Requirements");
		expect(specMarkdown).toContain("## Capability Boundaries");
		expect(specMarkdown).toContain("## Platform Contract");
		expect(specMarkdown).toContain("supportedDeliveryModes");

		expect(planMarkdown).toContain("## Technical Approach");
		expect(planMarkdown).toContain("## File Structure");
		expect(planMarkdown).toContain("## Data Model");
		expect(planMarkdown).toContain("## Interaction Flow");
		expect(planMarkdown).toContain("## Validation Strategy");

		expect(taskMarkdown).toContain("Status: ready");
		expect(taskMarkdown).toContain("Dependencies: plan");
		expect(taskMarkdown).toContain("Acceptance Criteria");
		expect(taskMarkdown).toContain("artifactIds");
		expect(taskMarkdown).toContain("failureReason");
	});
});
