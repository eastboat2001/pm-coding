import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { planCapabilities } from "../src/runtime/capability-planner.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";

describe("capability planner", () => {
	it("routes ordinary static UI work to static_app", () => {
		const plan = planCapabilities({
			messages: [userMessage("Create a static landing page with tabs and sample data.")],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		expect(plan.deliveryMode).toBe("static_app");
		expect(plan.requiresSimulation).toBe(false);
		expect(plan.unsupportedCapabilities).toEqual([]);
		expect(plan.supportedCapabilities).toEqual(expect.arrayContaining(["static_assets"]));
	});

	it("routes build-based frontend work to build_static_frontend", () => {
		const plan = planCapabilities({
			messages: [userMessage("Build a React dashboard with Vite and publish the static dist output.")],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		expect(plan.deliveryMode).toBe("build_static_frontend");
		expect(plan.requestedCapabilities).toEqual(expect.arrayContaining(["build_static_frontend"]));
		expect(plan.unsupportedCapabilities).toEqual([]);
	});

	it("does not silently treat full-stack requirements as an ordinary static task", () => {
		const plan = planCapabilities({
			messages: [
				userMessage(
					"Create a full-stack app with backend REST APIs, PostgreSQL persistence, auth, file uploads, and scheduled jobs.",
				),
			],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		expect(plan.deliveryMode).toBe("static_simulation");
		expect(plan.requiresSimulation).toBe(true);
		expect(plan.requiresClarification).toBe(false);
		expect(plan.requestedCapabilities).toEqual(
			expect.arrayContaining([
				"backend_server",
				"database_runtime",
				"server_auth",
				"file_upload_runtime",
				"scheduled_jobs",
			]),
		);
		expect(plan.unsupportedCapabilities).toEqual(
			expect.arrayContaining([
				"backend_server",
				"database_runtime",
				"server_auth",
				"file_upload_runtime",
				"scheduled_jobs",
			]),
		);
		expect(plan.userVisibleContract).toContain("static simulation");
		expect(plan.userVisibleContract).toContain("backend_server");
		expect(plan.diagnosticReason).toContain("static-preview");
	});

	it("uses PM handoff llmContent when planning capabilities", () => {
		const plan = planCapabilities({
			messages: [
				{
					role: "user-with-attachments",
					content: "Implement the PM handoff.",
					llmContent:
						"PM implementation prompt: build an API server with database persistence and login sessions.",
					timestamp: 1,
				} as unknown as AgentMessage,
			],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		expect(plan.deliveryMode).toBe("static_simulation");
		expect(plan.requestedCapabilities).toEqual(
			expect.arrayContaining(["backend_server", "database_runtime", "server_auth"]),
		);
		expect(plan.evidence.map((item) => item.matchedText.toLowerCase())).toEqual(
			expect.arrayContaining(["api server", "database", "login"]),
		);
	});

	it("returns deterministic evidence for requested unsupported capabilities", () => {
		const plan = planCapabilities({
			messages: [
				userMessage("Need backend APIs and backend services."),
				userMessage("Also add database persistence and external integration runtime."),
			],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});

		expect(plan.requestedCapabilities).toEqual([
			"backend_server",
			"database_runtime",
			"external_integration_runtime",
		]);
		expect(plan.evidence.map((item) => [item.capability, item.messageIndex])).toEqual([
			["backend_server", 0],
			["database_runtime", 1],
			["external_integration_runtime", 1],
		]);
	});
});

function userMessage(content: string): AgentMessage {
	return {
		role: "user",
		content,
		timestamp: 1,
	} as AgentMessage;
}
