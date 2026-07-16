import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AgentV2RunEventRecord, AgentV2RunSnapshot } from "@mariozechner/pi-web-workspace";
import { describe, expect, it, vi } from "vitest";
import { restoreAgentV2BrowserRunProjection } from "../src/runtime/agent-v2-run-restoration.js";
import { createAgentV2BrowserRunSink } from "../src/runtime/agent-v2-browser-run-sink.js";

vi.hoisted(() => {
	vi.stubGlobal("HTMLElement", class {});
	vi.stubGlobal("DOMMatrix", class {});
	vi.stubGlobal("ImageData", class {});
	vi.stubGlobal("Path2D", class {});
	vi.stubGlobal("customElements", { define: vi.fn(), get: vi.fn(() => undefined) });
	vi.stubGlobal("document", { addEventListener: vi.fn(), createTreeWalker: vi.fn(() => ({})), removeEventListener: vi.fn() });
});

describe("Agent v2 run restoration", () => {
	it.each(["succeeded", "failed"] as const)(
		"rebuilds and idempotently settles a run saved active but restored %s",
		(status) => {
			const browserAgent = { state: { messages: [] as AgentMessage[], isStreaming: false, pendingToolCalls: new Set<string>() } };
			const makeSink = () => createAgentV2BrowserRunSink({ browserAgent, locale: () => "en", onPresentationChange: vi.fn() });
			for (let replay = 0; replay < 2; replay += 1) {
				const result = restoreAgentV2BrowserRunProjection({
					snapshot: snapshot(status),
					events: events(status),
					sink: makeSink(),
					terminalStatus: status,
					terminalAt: "2026-07-16T00:03:00.000Z",
					...(status === "failed"
						? { error: { code: "static.invalid_html", message: "HTML is invalid.", retryable: true } }
						: {}),
				});
				expect(result.active).toBe(false);
			}
			expect(browserAgent.state.messages.filter((message) => message.role === "agent-v2-run-result")).toHaveLength(1);
			expect(browserAgent.state.messages.find((message) => message.role === "agent-v2-run-result")).toMatchObject({
				presentation: { status },
			});
		});
});

function snapshot(status: "succeeded" | "failed"): AgentV2RunSnapshot {
	return {
		clientId: "client-1",
		runId: "run-restored",
		status,
		phase: status === "succeeded" ? "delivery" : "failed",
		attempt: 1,
		input: {},
		model: {},
		createdAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:03:00.000Z",
	};
}

function events(status: "succeeded" | "failed"): AgentV2RunEventRecord[] {
	return [
		{
			runId: "run-restored",
			seq: 1,
			type: "agent_v2.phase_changed",
			payload: { type: "agent_v2.phase_changed", phase: "implementation", status: "running", attempt: 1, at: "2026-07-16T00:01:00.000Z" },
			createdAt: "2026-07-16T00:01:00.000Z",
		},
		{
			runId: "run-restored",
			seq: 2,
			type: "agent_v2.output_recorded",
			payload: { type: "agent_v2.output_recorded", taskId: "implement", summary: "Implementation complete.", provider: "openai", model: "gpt-test", at: "2026-07-16T00:02:00.000Z" },
			createdAt: "2026-07-16T00:02:00.000Z",
		},
		{
			runId: "run-restored",
			seq: 3,
			type: "agent_v2.phase_changed",
			payload: { type: "agent_v2.phase_changed", phase: status === "succeeded" ? "delivery" : "failed", status, attempt: 1, at: "2026-07-16T00:03:00.000Z" },
			createdAt: "2026-07-16T00:03:00.000Z",
		},
	] as AgentV2RunEventRecord[];
}
