import { DurableAgentV2InputMaterializer } from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import type { AgentV2ProductionStore, StorageConfig } from "@mariozechner/pi-web-workspace/runtime-infra";
import { describe, expect, it, vi } from "vitest";
import { AgentV2PiModelExecution } from "../src/worker/agent-v2-pi-model-execution.js";
import { createAgentV2WorkerExecution, runAgentV2WorkerIdentityLeaseRefresh } from "../src/worker/main.js";

describe("agent v2 worker production composition", () => {
	it("stops the old process after a newer process supersedes the same worker identity", async () => {
		const onLost = vi.fn();
		await runAgentV2WorkerIdentityLeaseRefresh({
			lease: { renew: async () => false },
			signal: new AbortController().signal,
			intervalMs: 1,
			onLost,
		});
		expect(onLost).toHaveBeenCalledOnce();
		expect(onLost).toHaveBeenCalledWith("superseded");
	});

	it("fails closed when worker identity ownership cannot be renewed", async () => {
		const onLost = vi.fn();
		await runAgentV2WorkerIdentityLeaseRefresh({
			lease: {
				renew: async () => {
					throw new Error("redis unavailable");
				},
			},
			signal: new AbortController().signal,
			intervalMs: 1,
			onLost,
		});
		expect(onLost).toHaveBeenCalledWith("unavailable");
	});

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
		expect(execution.materializer).toBeInstanceOf(DurableAgentV2InputMaterializer);
		expect(readSettingsFile).toHaveBeenCalledTimes(1);
		expect(getEnvApiKey).not.toHaveBeenCalled();
	});
});
