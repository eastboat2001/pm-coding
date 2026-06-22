import type { Model } from "@mariozechner/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAppStorage } from "../src/storage/app-storage.js";
import type { Attachment } from "../src/utils/attachment-utils.js";

describe("AgentInterface", () => {
	beforeEach(() => {
		vi.stubGlobal("HTMLElement", class {});
		vi.stubGlobal("DOMMatrix", class {});
		vi.stubGlobal("ImageData", class {});
		vi.stubGlobal("Path2D", class {});
		vi.stubGlobal("customElements", {
			define: vi.fn(),
			get: vi.fn(() => undefined),
		});
		vi.stubGlobal("document", {
			addEventListener: vi.fn(),
			createTreeWalker: vi.fn(() => ({})),
			removeEventListener: vi.fn(),
		});
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		});
		vi.stubGlobal("alert", vi.fn());
		setAppStorage({
			providerKeys: {
				get: async () => "test-key",
			},
		} as never);
	});

	it("preserves editor input and attachments when prompt startup fails", async () => {
		const { AgentInterface } = await import("../src/components/AgentInterface.js");
		const attachment: Attachment = {
			id: "attachment-1",
			type: "document",
			fileName: "brief.md",
			mimeType: "text/markdown",
			size: 7,
			content: "",
			extractedText: "# Brief",
		};
		const editor = {
			value: "resume work",
			attachments: [attachment],
			requestUpdate: vi.fn(),
		};
		const promptError = new Error("startRun failed");
		const element = Object.create(AgentInterface.prototype) as InstanceType<typeof AgentInterface> & {
			_messageEditor: typeof editor;
			requestUpdate: () => void;
		};
		Object.defineProperty(element, "session", {
			configurable: true,
			value: {
				state: {
					isStreaming: false,
					model: { provider: "openai", id: "gpt-5" } satisfies Model<unknown>,
				},
				prompt: vi.fn(async () => {
					throw promptError;
				}),
			},
		});
		Object.defineProperty(element, "_messageEditor", { configurable: true, value: editor });
		Object.defineProperty(element, "requestUpdate", { configurable: true, value: vi.fn() });

		await expect(element.sendMessage("resume work", [attachment])).rejects.toThrow("startRun failed");

		expect(editor.value).toBe("resume work");
		expect(editor.attachments).toEqual([attachment]);
	});

	it("renders transient streaming status text before a message is available", async () => {
		const { StreamingMessageContainer } = await import("../src/components/StreamingMessageContainer.js");
		const element = Object.create(StreamingMessageContainer.prototype) as InstanceType<
			typeof StreamingMessageContainer
		> & {
			_message: null;
			isStreaming: boolean;
			statusText: string;
		};
		Object.defineProperty(element, "_message", { configurable: true, value: null });
		Object.defineProperty(element, "isStreaming", { configurable: true, value: true });
		Object.defineProperty(element, "statusText", { configurable: true, value: "Retrying request... (1/5)" });

		const template = element.render() as unknown as { values?: unknown[] };

		expect(templateValues(template)).toContain("Retrying request... (1/5)");
	});

	it("keeps transient streaming status visible while an assistant message is streaming", async () => {
		const { StreamingMessageContainer } = await import("../src/components/StreamingMessageContainer.js");
		const element = Object.create(StreamingMessageContainer.prototype) as InstanceType<
			typeof StreamingMessageContainer
		> & {
			_message: unknown;
			isStreaming: boolean;
			statusText: string;
			tools: unknown[];
			pendingToolCalls: Set<string>;
			toolResultsById: Map<string, unknown>;
		};
		Object.defineProperty(element, "_message", {
			configurable: true,
			value: { role: "assistant", content: "Thinking..." },
		});
		Object.defineProperty(element, "isStreaming", { configurable: true, value: true });
		Object.defineProperty(element, "statusText", { configurable: true, value: "Retrying request... (2/5)" });
		Object.defineProperty(element, "tools", { configurable: true, value: [] });
		Object.defineProperty(element, "pendingToolCalls", { configurable: true, value: new Set<string>() });
		Object.defineProperty(element, "toolResultsById", { configurable: true, value: new Map<string, unknown>() });

		const template = element.render() as unknown as { values?: unknown[] };

		expect(templateValues(template)).toContain("Retrying request... (2/5)");
	});

	it("renders app preview goal status separately from transient streaming status", async () => {
		const { AgentInterface } = await import("../src/components/AgentInterface.js");
		const element = Object.create(AgentInterface.prototype) as InstanceType<typeof AgentInterface> & {
			appPreviewGoalStatusText: string;
			appPreviewGoalStatusDetail: string;
			session: unknown;
		};
		Object.defineProperty(element, "session", {
			configurable: true,
			value: {
				state: {
					messages: [],
					tools: [],
					pendingToolCalls: new Set<string>(),
					isStreaming: false,
					model: { provider: "openai", id: "gpt-5" } satisfies Model<unknown>,
					thinkingLevel: "high",
				},
				abort: vi.fn(),
			},
		});
		Object.defineProperty(element, "extensionActions", { configurable: true, value: [] });
		Object.defineProperty(element, "slashSuggestions", { configurable: true, value: [] });
		Object.defineProperty(element, "enableAttachments", { configurable: true, value: true });
		Object.defineProperty(element, "enableModelSelector", { configurable: true, value: true });
		Object.defineProperty(element, "enableThinkingSelector", { configurable: true, value: true });
		Object.defineProperty(element, "showThemeToggle", { configurable: true, value: false });
		Object.defineProperty(element, "appPreviewGoalStatusText", {
			configurable: true,
			value: "Continuing preview generation",
		});
		Object.defineProperty(element, "appPreviewGoalStatusDetail", {
			configurable: true,
			value: "Preview access check did not pass.",
		});

		const template = element.render() as unknown as { values?: unknown[] };

		expect(templateValues(template)).toContain("Continuing preview generation");
		expect(templateValues(template)).toContain("Preview access check did not pass.");
	});
});

function templateValues(value: unknown): unknown[] {
	if (!value || typeof value !== "object") return [];
	const values = Array.isArray((value as { values?: unknown[] }).values)
		? (value as { values: unknown[] }).values
		: [];
	return values.flatMap((entry) => [entry, ...templateValues(entry)]);
}
