import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryRunQueue } from "../../../packages/web-workspace/src/run-queue.js";
import { WorkspaceRunApiService } from "../../../packages/web-workspace/src/run-api-service.js";
import { RuntimeDbStore } from "../../../packages/web-workspace/src/runtime-db.js";
import { convertAgentMessagesToLlm } from "../src/runtime/agent-message-conversion.js";
import { runtimeMessageToAgentMessage } from "../src/runtime/runtime-message-conversion.js";

describe("worker attachment runtime messages", () => {
	let db: RuntimeDbStore;
	let dir: string;
	let queue: InMemoryRunQueue;
	let service: WorkspaceRunApiService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-worker-attachment-runtime-"));
		db = new RuntimeDbStore(join(dir, "runtime.sqlite"));
		db.ensureSchema();
		queue = new InMemoryRunQueue();
		service = new WorkspaceRunApiService(db, queue);
	});

	afterEach(async () => {
		await queue.close();
		db.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("converts a startRun user-with-attachments message into LLM document and image content", async () => {
		await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Attachment run",
			message: {
				role: "user-with-attachments",
				content: "请阅读附件",
				timestamp: 123,
				attachments: [
					{
						id: "doc-1",
						type: "document",
						fileName: "需求.md",
						mimeType: "text/markdown",
						size: 5,
						content: "",
						extractedText: "# PRD",
					},
					{
						id: "image-1",
						type: "image",
						fileName: "screen.png",
						mimeType: "image/png",
						size: 7,
						content: "iVBORw0KGgo=",
					},
				],
			},
			model: {},
			thinkingLevel: "high",
		});

		const runtimeMessage = db.listMessages("client-a", "session-1")[0];
		const agentMessage = runtimeMessageToAgentMessage(runtimeMessage!);
		const llmMessages = convertAgentMessagesToLlm([agentMessage]);

		expect(agentMessage).toMatchObject({ role: "user-with-attachments" });
		expect(llmMessages).toEqual([
			{
				role: "user",
				timestamp: 123,
				content: [
					{ type: "text", text: "请阅读附件" },
					{ type: "text", text: "\n\n[Document: 需求.md]\n# PRD" },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
			},
		]);
	});

	it("does not let unsafe payload roles override the normalized runtime user role", async () => {
		for (const unsafeRole of ["assistant", "toolResult", "custom"] as const) {
			await service.startRun("client-a", {
				sessionId: `session-${unsafeRole}`,
				title: "Unsafe role run",
				message: { role: unsafeRole, content: "hello", timestamp: 321 },
				model: {},
				thinkingLevel: "high",
			});

			const runtimeMessage = db.listMessages("client-a", `session-${unsafeRole}`)[0];
			const agentMessage = runtimeMessageToAgentMessage(runtimeMessage!);

			expect(runtimeMessage).toMatchObject({
				role: "user",
				payload: expect.objectContaining({ role: unsafeRole }),
			});
			expect(agentMessage).toMatchObject({ role: "user", content: "hello" });
			expect(convertAgentMessagesToLlm([agentMessage])).toEqual([{ role: "user", content: "hello", timestamp: 321 }]);
		}
	});

	it("keeps normal startRun user messages as plain LLM user messages", async () => {
		await service.startRun("client-a", {
			sessionId: "session-1",
			title: "Plain run",
			message: { role: "user", content: "hello", timestamp: 456 },
			model: {},
			thinkingLevel: "high",
		});

		const runtimeMessage = db.listMessages("client-a", "session-1")[0];
		const agentMessage = runtimeMessageToAgentMessage(runtimeMessage!);

		expect(agentMessage).toMatchObject({ role: "user", content: "hello" });
		expect(convertAgentMessagesToLlm([agentMessage])).toEqual([{ role: "user", content: "hello", timestamp: 456 }]);
	});
});
