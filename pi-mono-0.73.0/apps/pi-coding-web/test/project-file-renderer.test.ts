import { beforeAll, describe, expect, it } from "vitest";

let selectProjectFileDisplay: typeof import("../src/project-tools/renderers.js").selectProjectFileDisplay;

describe("project_file renderer", () => {
	beforeAll(async () => {
		class TestDOMMatrix {}
		class TestImageData {}
		class TestPath2D {}
		Object.assign(globalThis, {
			DOMMatrix: TestDOMMatrix,
			ImageData: TestImageData,
			Path2D: TestPath2D,
		});
		({ selectProjectFileDisplay } = await import("../src/project-tools/renderers.js"));
	});

	it("shows the tool error instead of attempted file content when a file operation fails", () => {
		const display = selectProjectFileDisplay(
			{
				command: "create",
				filename: "index.html",
				content: "<!doctype html><script>window.created = true</script>",
			},
			{
				type: "toolResult",
				id: "call-1",
				name: "project_file",
				isError: true,
				content: [{ type: "text", text: "Request was cancelled." }],
			} as any,
		);

		expect(display.code).toBe("Request was cancelled.");
		expect(display.language).toBe("text");
	});

	it("does not display attempted file content for interrupted file operations without an error body", () => {
		const display = selectProjectFileDisplay(
			{
				command: "create",
				filename: "index.html",
				content: "<!doctype html><script>window.created = true</script>",
			},
			{
				type: "toolResult",
				id: "call-2",
				name: "project_file",
				isError: true,
				content: [],
			} as any,
		);

		expect(display.code).toBe("");
		expect(display.language).toBe("text");
	});
});
