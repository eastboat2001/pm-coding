import type { AgentV2ProductionStore, StorageConfig } from "@mariozechner/pi-web-workspace/runtime-infra";
import { describe, expect, it, vi } from "vitest";
import { AgentV2PiModelExecution } from "../src/worker/agent-v2-pi-model-execution.js";
import { createAgentV2WorkerExecution } from "../src/worker/main.js";

describe("agent v2 worker production composition", () => {
	it("calls the production factory and constructs the PI adapter from one startup settings snapshot", () => {
		const readSettingsFile = vi.fn(() => "{}");
		const getEnvApiKey = vi.fn(() => undefined);
		const execution = createAgentV2WorkerExecution(
			{ settingsFile: "unused", modelMaxOutputTokens: 4096 } as StorageConfig,
			{} as AgentV2ProductionStore,
			{
				settingsSources: { readSettingsFile, getEnvApiKey, getBuiltinProviders: () => [] },
				complete: vi.fn(),
			},
		);

		expect(execution.modelExecution).toBeInstanceOf(AgentV2PiModelExecution);
		expect(readSettingsFile).toHaveBeenCalledTimes(1);
		expect(getEnvApiKey).not.toHaveBeenCalled();
	});
});
