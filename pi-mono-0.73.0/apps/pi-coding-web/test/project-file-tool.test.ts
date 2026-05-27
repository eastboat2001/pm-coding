import { validateToolArguments } from "../../../packages/ai/src/utils/validation.js";
import { describe, expect, it } from "vitest";
import { prepareProjectFileArguments, projectFileSchema } from "../src/project-tools/schemas.js";

const projectFileTool = {
	name: "project_file",
	description: "Project file test tool",
	parameters: projectFileSchema,
};

describe("project_file arguments", () => {
	it("rejects create calls that omit content", () => {
		expect(() =>
			validateToolArguments(projectFileTool, {
				type: "toolCall",
				id: "call-1",
				name: "project_file",
				arguments: { command: "create", filename: "app.js" },
			}),
		).toThrow(/content/i);
	});

	it("normalizes small-model aliases before validation", () => {
		const prepared = prepareProjectFileArguments({
			command: "write",
			path: "src/main.js",
			code: "console.log('ok');",
		});

		expect(prepared).toEqual({
			command: "create",
			filename: "src/main.js",
			content: "console.log('ok');",
		});
		expect(validateToolArguments(projectFileTool, {
			type: "toolCall",
			id: "call-2",
			name: "project_file",
			arguments: prepared,
		})).toEqual(prepared);
	});

	it("returns actionable errors for missing required fields", () => {
		expect(() => prepareProjectFileArguments({ command: "create" })).toThrow(
			/project_file create requires: \{"command":"create","filename":"index.html","content":"完整文件内容"\}/,
		);
	});

	it("rejects omitted project_file placeholders as writable content", () => {
		expect(() =>
			prepareProjectFileArguments({
				command: "rewrite",
				filename: "index.html",
				content: "[project_file content omitted: 44099 chars, 1550 lines from index.html]",
			}),
		).toThrow(/project_file get/);
	});
});
