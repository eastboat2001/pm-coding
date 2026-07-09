import { describe, expect, it } from "vitest";
import * as workerMain from "../src/worker/main.js";

describe("worker schema init", () => {
	it("ensures only the agent v2 schema for worker startup", async () => {
		const calls: string[] = [];
		const ensureRuntimeSchemas = (
			workerMain as {
				ensureRuntimeSchemas?: (runtimeDb: {
					ensureAgentV2Schema(): Promise<void>;
				}) => Promise<void>;
			}
		).ensureRuntimeSchemas;

		expect(ensureRuntimeSchemas).toBeTypeOf("function");

		await ensureRuntimeSchemas!({
			async ensureAgentV2Schema() {
				calls.push("ensureAgentV2Schema");
			},
		});

		expect(calls).toEqual(["ensureAgentV2Schema"]);
	});
});
