import type { Context } from "../../../packages/ai/src/types.js";
import { describe, expect, it } from "vitest";
import { summarizeContextBudget } from "../src/diagnostics/context-budget.js";

describe("summarizeContextBudget", () => {
	it("separates provider payload size from internal tool result details", () => {
		const context: Context = {
			systemPrompt: "System",
			messages: [
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "project_file",
					content: [{ type: "text", text: "short visible result" }],
					details: { rawFileContent: "x".repeat(50_000) },
					isError: false,
					timestamp: 1,
				},
			],
		};

		const budget = summarizeContextBudget(context);

		expect(budget.internalDetailsChars).toBeGreaterThan(50_000);
		expect(budget.providerPayloadChars).toBeLessThan(1_000);
		expect(budget.totalChars).toBe(budget.providerPayloadChars);
		expect(budget.internalSerializedChars).toBeGreaterThan(budget.providerPayloadChars as number);
		expect(budget.largeItems).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "toolResult", label: "project_file" })]),
		);
	});
});
