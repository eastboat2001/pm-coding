import { describe, expect, it } from "vitest";
import { routeAgentV2Capabilities } from "../src/agent-v2-capability-router.js";
import {
	buildAgentV2PlanDocument,
	buildAgentV2SpecDocument,
	buildAgentV2TaskGraph,
	renderAgentV2DocumentMarkdown,
} from "../src/agent-v2-documents.js";

const FIXED_NOW = () => "2026-07-07T00:00:00.000Z";

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

	it("records static simulation limits directly in spec and plan", () => {
		const objective = "Build a SaaS app with login auth and PostgreSQL database.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-2", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-2", spec, decision, now: FIXED_NOW });

		expect(spec.capabilityBoundaries.join(" ")).toContain("static simulation");
		expect(plan.risks.join(" ")).toContain("backend");
	});

	it("creates a dependency ordered task graph consumed by later execution", () => {
		const objective = "Build a static analytics dashboard.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-3", objective, decision, now: FIXED_NOW });
		const plan = buildAgentV2PlanDocument({ runId: "run-3", spec, decision, now: FIXED_NOW });
		const graph = buildAgentV2TaskGraph({ runId: "run-3", spec, plan, decision, now: FIXED_NOW });

		expect(graph.tasks.map((task) => task.taskId)).toEqual(["capability", "spec", "plan", "implement", "validate", "deliver"]);
		expect(graph.tasks.find((task) => task.taskId === "implement")?.dependsOn).toEqual(["plan"]);
	});

	it("renders deterministic markdown for generated documents", () => {
		const objective = "Build a static analytics dashboard.";
		const decision = routeAgentV2Capabilities({ objective });
		const spec = buildAgentV2SpecDocument({ runId: "run-4", objective, decision, now: FIXED_NOW });

		expect(renderAgentV2DocumentMarkdown(spec)).toContain("# Spec:");
		expect(renderAgentV2DocumentMarkdown(spec)).toContain("Build a static analytics dashboard.");
	});
});
