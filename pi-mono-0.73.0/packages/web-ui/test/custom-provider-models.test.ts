import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { loadCustomProviderModels } from "../src/utils/custom-provider-models.js";

describe("custom provider model loading", () => {
	it("starts auto-discovery providers in parallel", async () => {
		const first = deferred<Model<any>[]>();
		const second = deferred<Model<any>[]>();
		const calls: string[] = [];
		const loading = loadCustomProviderModels(
			[
				provider("provider-a", "Provider A", "vllm"),
				provider("provider-b", "Provider B", "ollama"),
			],
			{
				discover: async (type) => {
					calls.push(type);
					return type === "vllm" ? first.promise : second.promise;
				},
				timeoutMs: 1000,
			},
		);

		await Promise.resolve();
		expect(calls).toEqual(["vllm", "ollama"]);

		first.resolve([model("a")]);
		second.resolve([model("b")]);
		const entries = await loading;

		expect(entries.map((entry) => entry.model.provider)).toEqual([
			"custom-provider:provider-a",
			"custom-provider:provider-b",
		]);
		expect(entries.map((entry) => entry.providerLabel)).toEqual(["Provider A", "Provider B"]);
	});

	it("skips a slow auto-discovery provider after the timeout", async () => {
		const entries = await loadCustomProviderModels(
			[provider("slow", "Slow Provider", "vllm"), provider("fast", "Fast Provider", "ollama")],
			{
				discover: async (type) => {
					if (type === "vllm") return new Promise<Model<any>[]>(() => {});
					return [model("fast-model")];
				},
				timeoutMs: 1,
			},
		);

		expect(entries.map((entry) => entry.model.id)).toEqual(["fast-model"]);
		expect(entries[0]?.model.provider).toBe("custom-provider:fast");
	});
});

function provider(id: string, name: string, type: "vllm" | "ollama") {
	return {
		id,
		name,
		type,
		baseUrl: `http://${id}.local`,
		apiKey: `${id}-key`,
	};
}

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "",
		baseUrl: "http://localhost:8000/v1",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 4096,
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveValue: (value: T) => void = () => {};
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}
