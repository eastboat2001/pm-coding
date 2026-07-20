// @vitest-environment happy-dom

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { AgentInterface } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { reduceWorkspaceExpansion, createWorkspaceExpansionState } from "../src/app/workspace-expansion-coordinator.js";
import { selectAgentV2ActiveRunPresentation } from "../src/runtime/agent-v2-active-run.js";
import { createAgentV2BrowserRunSink } from "../src/runtime/agent-v2-browser-run-sink.js";
import type { AgentV2RunPresentation } from "../src/runtime/agent-v2-run-presentation.js";
import { registerAgentV2RunResultMessageRenderer } from "../src/runtime/agent-v2-run-result-message.js";

describe("Agent v2 executable browser integration", () => {
	it("isolates the active run slot from Chat mode and switches one active presentation to one result", () => {
		const browserAgent = {
			state: { messages: [] as AgentMessage[], isStreaming: false, pendingToolCalls: new Set<string>() },
		};
		let active: AgentV2RunPresentation | undefined;
		const sink = createAgentV2BrowserRunSink({
			browserAgent,
			responseLanguage: "en",
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

	it("mounts AgentInterface and switches Chat, active app generation, and terminal result DOM", async () => {
		if (!globalThis.ResizeObserver) {
			vi.stubGlobal(
				"ResizeObserver",
				class {
					observe() {}
					disconnect() {}
				},
			);
		}
		registerAgentV2RunResultMessageRenderer();
		const state = {
			messages: [] as AgentMessage[],
			tools: [],
			pendingToolCalls: new Set<string>(),
			isStreaming: false,
			model: { provider: "test", id: "test-model" },
			thinkingLevel: "off" as const,
		};
		const session = {
			state,
			streamFn: vi.fn(),
			getApiKey: vi.fn(async () => "test-key"),
			subscribe: vi.fn(() => () => {}),
			abort: vi.fn(),
			prompt: vi.fn(),
		};
		const agentInterface = document.createElement("agent-interface") as AgentInterface;
		agentInterface.session = session as never;
		document.body.append(agentInterface);
		await agentInterface.updateComplete;

		let mode: "chat" | "app_generation" = "chat";
		let active: AgentV2RunPresentation | undefined;
		const syncSlot = (presentation: AgentV2RunPresentation | undefined) => {
			active = presentation;
			const selected = selectAgentV2ActiveRunPresentation(mode, presentation);
			agentInterface.activeRunContent = selected
				? html`<agent-v2-progress-card .presentation=${selected}></agent-v2-progress-card>`
				: undefined;
			agentInterface.requestUpdate();
		};
		const sink = createAgentV2BrowserRunSink({
			browserAgent: { state },
			responseLanguage: "en",
			onPresentationChange: syncSlot,
		});
		sink.beginRun("run-dom", "2026-07-16T00:00:00.000Z");
		sink.setPhase("implementation", "running", "2026-07-16T00:00:01.000Z");
		await agentInterface.updateComplete;
		expect(agentInterface.querySelector(".agent-interface__active-run-slot")).toBeNull();

		mode = "app_generation";
		syncSlot(active);
		await agentInterface.updateComplete;
		expect(agentInterface.querySelector(".agent-interface__active-run-slot agent-v2-progress-card")).not.toBeNull();

		sink.settle("failed", "2026-07-16T00:00:02.000Z", {
			code: "static.invalid_html",
			message: "Generated HTML is invalid.",
			retryable: true,
		});
		await agentInterface.updateComplete;
		const messageList = agentInterface.querySelector("message-list") as { updateComplete?: Promise<unknown> } | null;
		await messageList?.updateComplete;
		expect(agentInterface.querySelector(".agent-interface__active-run-slot")).toBeNull();
		const terminalCard = agentInterface.querySelector("agent-v2-progress-card") as
			| (HTMLElement & { terminal?: boolean; updateComplete?: Promise<unknown> })
			| null;
		await terminalCard?.updateComplete;
		expect(terminalCard?.terminal).toBe(true);
		expect(terminalCard?.querySelector(".agent-v2-progress-card--terminal")).not.toBeNull();
		agentInterface.remove();
	});
});
