import { describe, expect, it } from "vitest";
import { extractToolCallsFromText } from "../src/utils/tool-call-extraction.js";

describe("extractToolCallsFromText", () => {
	it("recovers qwen/hermes tagged tool calls", () => {
		const result = extractToolCallsFromText(
			'Preparing files.\n<tool_call>{"name":"project_file","arguments":{"command":"list"}}</tool_call>',
			new Set(["project_file"]),
		);

		expect(result.calls).toEqual([
			{
				name: "project_file",
				arguments: { command: "list" },
			},
		]);
		expect(result.text).toBe("Preparing files.");
	});

	it("recovers fenced JSON tool calls with OpenAI function shape", () => {
		const result = extractToolCallsFromText(
			'```json\n{"function":{"name":"project_task","arguments":"{\\"task\\":\\"validate\\"}"}}\n```',
			new Set(["project_task"]),
		);

		expect(result.calls).toEqual([
			{
				name: "project_task",
				arguments: { task: "validate" },
			},
		]);
		expect(result.text).toBe("");
	});

	it("ignores unknown tool names", () => {
		const result = extractToolCallsFromText(
			'<tool_call>{"name":"delete_everything","arguments":{"command":"rm -rf /"}}</tool_call>',
			new Set(["project_file"]),
		);

		expect(result.calls).toEqual([]);
		expect(result.text).toContain("delete_everything");
	});
});
