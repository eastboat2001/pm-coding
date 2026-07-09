import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { loadStorageConfig } from "../../../packages/web-workspace/src/config.js";
import { afterEach, describe, expect, it } from "vitest";
import { selectApplicationGenerationRuntime } from "../src/agent-v2/runtime-entry.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";
import { createWorkerStartupDiagnosticEvents } from "../src/worker/main.js";

describe("application generation runtime entry", () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) rmSync(dir, { force: true, recursive: true });
		dir = undefined;
		delete process.env.PI_APP_AGENT_VERSION;
	});

	it("selects v2 by default", () => {
		expect(selectApplicationGenerationRuntime({})).toMatchObject({
			version: "v2",
			v1Disabled: true,
			platformContract: STATIC_PREVIEW_CONTRACT,
		});
		expect(selectApplicationGenerationRuntime({}).buildPlanningBootstrap).toEqual(expect.any(Function));
	});

	it("rejects v1 as a product runtime", () => {
		expect(() => selectApplicationGenerationRuntime({ requestedVersion: "v1" })).toThrow(
			"v1 is retired",
		);
	});

	it("does not expose v1 as a stable version option", () => {
		expect(selectApplicationGenerationRuntime({ requestedVersion: "v2" })).toMatchObject({
			version: "v2",
			v1Disabled: true,
		});
	});

	it("returns a fresh selection object for each successful call", () => {
		const first = selectApplicationGenerationRuntime({});
		const mutated = {
			...first,
			reason: "mutated",
		};
		const second = selectApplicationGenerationRuntime({});

		expect(mutated.reason).toBe("mutated");
		expect(second.reason).toContain("replacement default");
		expect(second).not.toBe(first);
	});

	it("ignores PI_APP_AGENT_VERSION=v1 and keeps the worker entry on the v2 path", () => {
		dir = mkdtempSync(join(tmpdir(), "pi-agent-v2-runtime-entry-"));
		process.env.PI_APP_AGENT_VERSION = "v1";
		const config = loadStorageConfig(dir);
		const workerEntrySource = readFileSync(new URL("../src/worker/main.ts", import.meta.url), "utf8");

		expect("appAgentVersion" in config).toBe(false);
		expect(createWorkerStartupDiagnosticEvents(config)).toContainEqual(
			expect.objectContaining({
				eventType: "system.startup.config",
				data: expect.not.objectContaining({
					appAgentVersion: expect.anything(),
				}),
			}),
		);
		expect(workerEntrySource).not.toContain("legacy-v1-main");
	});
});
