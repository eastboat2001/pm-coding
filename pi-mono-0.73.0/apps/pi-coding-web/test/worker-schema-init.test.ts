import { describe, expect, it } from "vitest";
import * as workerMain from "../src/worker/main.js";

describe("worker schema init", () => {
	it("ensures legacy and agent v2 schemas in order", async () => {
		const calls: string[] = [];
		const ensureRuntimeSchemas = (
			workerMain as {
				ensureRuntimeSchemas?: (runtimeDb: {
					ensureSchema(): Promise<void>;
					ensureAgentV2Schema(): Promise<void>;
				}) => Promise<void>;
			}
		).ensureRuntimeSchemas;

		expect(ensureRuntimeSchemas).toBeTypeOf("function");

		await ensureRuntimeSchemas!({
			async ensureSchema() {
				calls.push("ensureSchema");
			},
			async ensureAgentV2Schema() {
				calls.push("ensureAgentV2Schema");
			},
		});

		expect(calls).toEqual(["ensureSchema", "ensureAgentV2Schema"]);
	});
});
