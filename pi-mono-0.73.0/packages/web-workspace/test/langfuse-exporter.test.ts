import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import { type LangfuseDiagnosticEvent, LangfuseDiagnosticExporter } from "../src/langfuse-exporter.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LangfuseDiagnosticExporter", () => {
	it("makes concurrent flush callers await the same remote confirmation and passes AbortSignal", async () => {
		const pending = deferred<Response>();
		const fetch = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
		const exporter = new LangfuseDiagnosticExporter(config(), { fetch });
		exporter.enqueue([event()]);
		const controller = new AbortController();
		const first = exporter.flush(controller.signal);
		const second = exporter.flush(controller.signal);
		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		await Promise.resolve();
		expect(secondSettled).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
		pending.resolve(new Response("{}", { status: 200 }));
		await Promise.all([first, second]);
		expect(exporter.status().langfuseQueuedEvents).toBe(0);
	});

	it("awaits projected delivery and never exposes a raw response body or thrown secret", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(new Response("provider-secret-response", { status: 503 }))
			.mockRejectedValueOnce(new Error("network-secret"));
		const exporter = new LangfuseDiagnosticExporter(config(), { fetch });
		await expect(exporter.deliver([event()], new AbortController().signal)).rejects.toThrow(
			"agent_v2.langfuse_delivery_failed",
		);
		expect(JSON.stringify(exporter.status())).not.toContain("provider-secret-response");
		await expect(exporter.deliver([event()], new AbortController().signal)).rejects.toThrow(
			"agent_v2.langfuse_delivery_failed",
		);
		expect(JSON.stringify(exporter.status())).not.toContain("network-secret");
	});

	it("replays an acknowledgement-loss delivery with the same deterministic OTLP identity", async () => {
		const bodies: string[] = [];
		const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return new Response("{}", { status: 200 });
		});
		const exporter = new LangfuseDiagnosticExporter(config(), { fetch });
		const signal = new AbortController().signal;
		await exporter.deliver([event()], signal);
		await exporter.deliver([event()], signal);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
	});
});

function config() {
	const root = mkdtempSync(join(tmpdir(), "pi-langfuse-exporter-"));
	roots.push(root);
	return {
		...loadStorageConfig(root),
		langfuseEnabled: true,
		langfuseHost: "https://langfuse.test",
		langfusePublicKey: "public-test",
		langfuseSecretKey: "secret-test",
		langfuseFlushIntervalMs: 60_000,
		langfuseBatchSize: 10,
	};
}

function event(): LangfuseDiagnosticEvent {
	return {
		timestamp: "2026-07-15T00:00:00.000Z",
		clientId: "client-a",
		level: "error",
		category: "agent",
		eventType: "agent_v2.validation_failed",
		traceId: "trace-a",
		data: { diagnosticId: "diag-a", runId: "run-a" },
	};
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((next) => {
		resolve = next;
	});
	return { promise, resolve };
}
