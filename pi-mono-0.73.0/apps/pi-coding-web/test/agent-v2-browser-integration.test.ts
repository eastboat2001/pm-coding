import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { reduceWorkspaceExpansion, createWorkspaceExpansionState } from "../src/app/workspace-expansion-coordinator.js";
import { selectAgentV2ActiveRunPresentation } from "../src/runtime/agent-v2-active-run.js";
import { createAgentV2BrowserRunSink } from "../src/runtime/agent-v2-browser-run-sink.js";
import type { AgentV2RunPresentation } from "../src/runtime/agent-v2-run-presentation.js";

vi.hoisted(() => {
	vi.stubGlobal("HTMLElement", class {});
	vi.stubGlobal("DOMMatrix", class {});
	vi.stubGlobal("ImageData", class {});
	vi.stubGlobal("Path2D", class {});
	vi.stubGlobal("customElements", { define: vi.fn(), get: vi.fn(() => undefined) });
	vi.stubGlobal("document", { addEventListener: vi.fn(), createTreeWalker: vi.fn(() => ({})), removeEventListener: vi.fn() });
});

describe("Agent v2 executable browser integration", () => {
	it("isolates the active run slot from Chat mode and switches one active presentation to one result", () => {
		const browserAgent = {
			state: { messages: [] as AgentMessage[], isStreaming: false, pendingToolCalls: new Set<string>() },
		};
		let active: AgentV2RunPresentation | undefined;
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			locale: () => "en",
			onPresentationChange: (presentation) => {
				active = presentation;
			},
		});
		sink.beginRun("run-integration", "2026-07-16T00:00:00.000Z");
		sink.setPhase("implementation", "running", "2026-07-16T00:00:01.000Z");

		expect(selectAgentV2ActiveRunPresentation("chat", active)).toBeUndefined();
		expect(selectAgentV2ActiveRunPresentation("app_generation", active)?.runId).toBe("run-integration");
		expect(browserAgent.state.messages.filter((message) => message.role === "agent-v2-run-result")).toHaveLength(0);

		sink.settle("failed", "2026-07-16T00:00:02.000Z", {
			code: "static.invalid_html",
			message: "Generated HTML is invalid.",
			retryable: true,
		});
		expect(selectAgentV2ActiveRunPresentation("app_generation", active)).toBeUndefined();
		expect(browserAgent.state.messages.filter((message) => message.role === "agent-v2-run-result")).toHaveLength(1);
	});

	it("coordinates active and historical detail ownership without sharing expansion state", () => {
		let state = createWorkspaceExpansionState("desktop");
		state = reduceWorkspaceExpansion(state, { type: "open_active_run_detail" });
		state = reduceWorkspaceExpansion(state, { type: "open_internal_section", section: "files" });
		expect(state).toMatchObject({ activeRunDetailOpen: true, historicalRunDetailId: null, internalSection: "files" });

		state = reduceWorkspaceExpansion(state, { type: "open_historical_run_detail", runId: "run-old" });
		expect(state).toMatchObject({
			activeRunDetailOpen: false,
			historicalRunDetailId: "run-old",
			internalSection: null,
		});
		state = reduceWorkspaceExpansion(state, { type: "open_internal_section", section: "validation" });
		expect(state.internalSection).toBe("validation");
	});
});
