import { describe, expect, it } from "vitest";
import { routeAgentV2Capabilities } from "../src/agent-v2-capability-router.js";

describe("Agent v2 capability router", () => {
	it("accepts normal static app requests without simulation", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build a responsive portfolio website with projects and contact form mock data.",
		});

		expect(decision.deliveryMode).toBe("static_app");
		expect(decision.requiresSimulation).toBe(false);
		expect(decision.unsupportedCapabilities).toEqual([]);
	});

	it("routes database or auth requests to explicit static simulation instead of silent downgrade", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build a CRM with PostgreSQL database, login auth, API routes, and user roles.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.unsupportedCapabilities).toEqual(
			expect.arrayContaining(["database_runtime", "server_auth", "backend_server"]),
		);
		expect(decision.userVisibleContract).toContain("static simulation");
	});

	it("requires clarification for empty or underspecified objectives", () => {
		const decision = routeAgentV2Capabilities({ objective: "make an app" });

		expect(decision.deliveryMode).toBe("needs_clarification");
		expect(decision.requiresClarification).toBe(true);
	});
});
