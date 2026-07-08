import { describe, expect, it } from "vitest";
import {
	assertAgentV2ToolAllowed,
	createAgentV2ToolFailure,
	createAgentV2ToolRegistry,
} from "../src/agent-v2-tool-governance.js";

describe("agent v2 tool governance", () => {
	it("resolves registered tools and enforces phase allowlists", () => {
		const registry = createAgentV2ToolRegistry();

		expect(registry.get("file.write")).toMatchObject({
			name: "file.write",
			sideEffects: "workspace_files",
		});
		expect(() => assertAgentV2ToolAllowed(registry, "file.write", "implementation")).not.toThrow();
		expect(() => assertAgentV2ToolAllowed(registry, "file.write", "validation")).toThrow(
			"Agent v2 tool file.write is not allowed during phase validation",
		);
	});

	it("fails closed for unknown tools", () => {
		const registry = createAgentV2ToolRegistry();
		expect(() => assertAgentV2ToolAllowed(registry, "legacy.project_task" as never, "implementation")).toThrow(
			"Agent v2 tool is not registered: legacy.project_task",
		);
	});

	it("creates stable structured tool failures", () => {
		expect(
			createAgentV2ToolFailure({
				code: "tool.not_allowed_in_phase",
				message: "Tool not allowed",
				retryable: false,
				taskId: "validate",
				path: "index.html",
				data: { tool: "file.write" },
			}),
		).toEqual({
			code: "tool.not_allowed_in_phase",
			message: "Tool not allowed",
			retryable: false,
			taskId: "validate",
			path: "index.html",
			data: { tool: "file.write" },
		});
	});
});
