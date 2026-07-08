import { describe, expect, it } from "vitest";
import { routeAgentV2Capabilities } from "../src/agent-v2-capability-router.js";
import type { AgentV2PlatformContract } from "../src/agent-v2-types.js";

describe("Agent v2 capability router", () => {
	it("preserves a custom platform contract on the routed decision", () => {
		const platform: AgentV2PlatformContract = {
			runtime: "static_browser_app",
			framework: "solid-js",
			deliveryMode: "build_static_frontend",
			entrypoints: ["index.html", "src/entry-client.tsx"],
			deliverables: ["solid frontend bundle", "preview-ready assets"],
			constraints: ["No backend runtime is available."],
			supportedDeliveryModes: ["build_static_frontend", "static_simulation"],
			unsupportedCapabilities: ["backend_server"],
			userVisibleContract: "Ship a Solid frontend bundle with static-only behavior.",
			metadata: { contractId: "solid-static" },
		};

		const decision = routeAgentV2Capabilities({
			objective: "Build a React analytics frontend with reusable charts.",
			platform,
		});

		expect(decision.deliveryMode).toBe("build_static_frontend");
		expect(decision.platformContract).toEqual(platform);
	});

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

	it("routes upload, scheduled job, and integration requests to explicit static simulation", () => {
		const decision = routeAgentV2Capabilities({
			objective:
				"Build an app where users upload files, run cron jobs, and receive webhook events from third-party integrations.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.unsupportedCapabilities).toEqual(
			expect.arrayContaining(["file_upload_runtime", "scheduled_jobs", "external_integration_runtime"]),
		);
	});

	it("routes full-stack requests to explicit static simulation instead of silent downgrade", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build a full-stack CRM for sales reps.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.unsupportedCapabilities).toEqual(expect.arrayContaining(["backend_server"]));
	});

	it("routes REST API requests to explicit static simulation instead of silent downgrade", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build a REST API for todos.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.unsupportedCapabilities).toEqual(expect.arrayContaining(["backend_server"]));
	});

	it("routes GraphQL API requests to explicit static simulation instead of silent downgrade", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build a GraphQL API for inventory.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.unsupportedCapabilities).toEqual(expect.arrayContaining(["backend_server"]));
	});

	it("routes image upload requests to explicit static simulation instead of clarification fallback", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build an app where users upload images and photos for moderation.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresSimulation).toBe(true);
		expect(decision.requiresClarification).toBe(false);
		expect(decision.unsupportedCapabilities).toEqual(expect.arrayContaining(["file_upload_runtime"]));
	});

	it("does not require clarification when a generic app request includes unsupported runtime needs", () => {
		const decision = routeAgentV2Capabilities({
			objective: "Build an app with PostgreSQL, login auth, API routes, and user roles.",
		});

		expect(decision.deliveryMode).toBe("static_simulation");
		expect(decision.requiresClarification).toBe(false);
		expect(decision.unsupportedCapabilities).toEqual(
			expect.arrayContaining(["database_runtime", "server_auth", "backend_server"]),
		);
	});

	it("requires clarification for empty or underspecified objectives", () => {
		const decision = routeAgentV2Capabilities({ objective: "make an app" });

		expect(decision.deliveryMode).toBe("needs_clarification");
		expect(decision.requiresClarification).toBe(true);
	});
});
