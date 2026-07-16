import { describe, expect, it, vi } from "vitest";
import {
	buildConversationSnapshot,
	conversationSnapshotBudget,
	normalizeConversationSnapshotState,
} from "../src/runtime/conversation-snapshot.js";

describe("conversation snapshot", () => {
	it("keeps only ordered natural-language history and treats the current objective separately", async () => {
		const result = await buildConversationSnapshot({
			messages: [
				{ role: "user", content: "先做销售看板", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "已确认使用蓝色主题" }],
					api: "openai-responses",
					provider: "test",
					model: "chat-model",
					timestamp: 2,
				},
				{ role: "toolResult", toolCallId: "x", toolName: "skill_load", content: [], timestamp: 3 },
				{
					role: "assistant",
					content: [{ type: "text", text: "Generated 3 files." }],
					api: "agent-v2",
					provider: "agent-v2",
					model: "agent-v2",
					timestamp: 4,
				},
				{ role: "artifact", filename: "index.html", content: "hidden", timestamp: 5 },
			] as never,
			currentObjective: "把看板改成移动端布局",
			contextWindowTokens: 8_000,
		});

		expect(result.snapshot).toEqual({
			compactedSummary: "",
			recentMessages: [
				{ role: "user", content: "先做销售看板" },
				{ role: "assistant", content: "已确认使用蓝色主题" },
			],
			currentObjective: "把看板改成移动端布局",
		});
		expect(JSON.stringify(result.snapshot)).not.toContain("skill_load");
		expect(JSON.stringify(result.snapshot)).not.toContain("Generated 3 files");
	});

	it("bounds long Chat messages to the app-generation submission contract", async () => {
		const result = await buildConversationSnapshot({
			messages: [
				{ role: "user", content: "生成详细方案", timestamp: 1 },
				{
					role: "assistant",
					content: [{ type: "text", text: "a".repeat(16_972) }],
					timestamp: 2,
				},
			] as never,
			currentObjective: "生成应用",
			contextWindowTokens: 128_000,
		});

		expect(result.snapshot.recentMessages).toHaveLength(2);
		expect(Math.max(...result.snapshot.recentMessages.map((message) => message.content.length))).toBeLessThanOrEqual(
			8_192,
		);
	});

	it("compacts at 75 percent of the snapshot budget using 55/35/10 allocation", async () => {
		const budget = conversationSnapshotBudget(400);
		expect(budget).toEqual({ totalChars: 400, recentChars: 220, summaryChars: 140, safetyChars: 40, triggerChars: 300 });
		const summarize = vi.fn(async ({ previousSummary, exitedMessages }: {
			previousSummary: string;
			exitedMessages: Array<{ role: string; content: string }>;
		}) => `${previousSummary}|${exitedMessages.map((message) => message.content).join("|")}`);
		const messages = Array.from({ length: 8 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content:
				index % 2 === 0
					? `第${index}轮需求-${"u".repeat(55)}`
					: [{ type: "text", text: `第${index}轮答复-${"a".repeat(55)}` }],
			timestamp: index,
		}));

		const result = await buildConversationSnapshot({
			messages: messages as never,
			currentObjective: "继续生成",
			contextWindowTokens: 400,
			summarize,
		});

		expect(result.compacted).toBe(true);
		expect(result.snapshot.recentMessages.length).toBeGreaterThan(0);
		expect(result.snapshot.recentMessages.length).toBeLessThan(messages.length);
		expect(result.state.summarizedMessageCount).toBe(messages.length - result.snapshot.recentMessages.length);
		expect(summarize).toHaveBeenCalledTimes(1);
		expect(result.snapshot.compactedSummary.length).toBeLessThanOrEqual(140);
	});

	it("rolls forward only the prior summary and newly exited messages", async () => {
		const summarize = vi.fn(async ({ previousSummary, exitedMessages }) =>
			[`previous=${previousSummary}`, ...exitedMessages.map((message: { content: string }) => message.content)].join("\n"),
		);
		const previousState = {
			summarizedMessageCount: 2,
			snapshot: {
				compactedSummary: "旧摘要",
				recentMessages: [
					{ role: "user" as const, content: "旧窗口用户" },
					{ role: "assistant" as const, content: "旧窗口助手" },
				],
				currentObjective: "旧目标",
			},
		};
		const messages = [
			{ role: "user", content: "已经摘要的用户", timestamp: 1 },
			{ role: "assistant", content: [{ type: "text", text: "已经摘要的助手" }], timestamp: 2 },
			{ role: "user", content: `新退出窗口-${"x".repeat(180)}`, timestamp: 3 },
			{ role: "assistant", content: [{ type: "text", text: `保留最近-${"y".repeat(80)}` }], timestamp: 4 },
		] as never;

		await buildConversationSnapshot({
			messages,
			currentObjective: "新目标",
			contextWindowTokens: 400,
			previousState,
			summarize,
		});

		expect(summarize).toHaveBeenCalledTimes(1);
		const input = summarize.mock.calls[0]?.[0];
		expect(input.previousSummary).toBe("旧摘要");
		expect(input.exitedMessages.map((message: { content: string }) => message.content)).toEqual([
			expect.stringContaining("新退出窗口"),
		]);
		expect(JSON.stringify(input)).not.toContain("已经摘要的用户");
	});

	it("falls back to the recent window when summarization fails and reports the loss", async () => {
		const result = await buildConversationSnapshot({
			messages: Array.from({ length: 6 }, (_, index) => ({
				role: "user",
				content: `历史${index}-${"x".repeat(90)}`,
				timestamp: index,
			})) as never,
			currentObjective: "继续",
			contextWindowTokens: 400,
			summarize: async () => {
				throw new Error("summarizer unavailable");
			},
		});

		expect(result.snapshot.compactedSummary).toBe("");
		expect(result.snapshot.recentMessages.length).toBeGreaterThan(0);
		expect(result.snapshot.recentMessages.length).toBeLessThan(6);
		expect(result.warning).toBe("earlier_context_incomplete");
	});

	it("redacts credentials and absolute paths and rejects malformed persisted state", async () => {
		const result = await buildConversationSnapshot({
			messages: [
				{
					role: "user",
					content: "token=super-secret C:\\server\\private\\app /home/pi/private/app 保留产品目标",
					timestamp: 1,
				},
			] as never,
			currentObjective: "API_KEY=top-secret 继续生成",
			contextWindowTokens: 8_000,
		});

		const serialized = JSON.stringify(result.snapshot);
		expect(serialized).not.toContain("super-secret");
		expect(serialized).not.toContain("top-secret");
		expect(serialized).not.toContain("C:\\server");
		expect(serialized).not.toContain("/home/pi");
		expect(serialized).toContain("保留产品目标");
		expect(normalizeConversationSnapshotState({ summarizedMessageCount: -1, snapshot: {} })).toBeUndefined();
	});
});
