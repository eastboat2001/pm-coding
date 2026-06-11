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
});
