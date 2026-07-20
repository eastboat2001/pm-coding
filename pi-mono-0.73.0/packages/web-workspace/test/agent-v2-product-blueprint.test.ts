import { describe, expect, it } from "vitest";
import type { AgentV2InputBlobRecord } from "../src/agent-v2-durable-store.js";
import { buildAgentV2ProductBlueprint } from "../src/agent-v2-product-blueprint.js";

describe("agent v2 product blueprint", () => {
	it("extracts source-backed product evidence before planning", () => {
		const blueprint = buildAgentV2ProductBlueprint({
			runId: "run-blueprint",
			objective: "根据 PM 文档生成质量运营应用",
			responseLanguage: "zh",
			inputBlobs: [
				textBlob(
					"docs/requirements.md",
					`# 质量运营中心
## 页面与模块
- 周度质量看板必须展示 KPI、趋势图和缺陷明细表。
## 交互
- 客户筛选必须改变 KPI、图表和明细数据。
- 点击图表数据点后进入对应周的下钻视图。
## 状态
- 页面需要提供加载、空状态和错误状态。
## 权限
- 只有管理员角色可以导出生产数据。
## 视觉设计
- 桌面端使用紧凑的企业级布局，移动端不得横向溢出。
## 验收标准
- 切换客户后所有可视化数据发生可观察变化。`,
				),
			],
			now: () => "2026-07-17T00:00:00.000Z",
		});

		expect(blueprint.sourceDocuments).toEqual([
			expect.objectContaining({ path: "docs/requirements.md", checksum: "sha256:requirements" }),
		]);
		expect(itemsFor(blueprint, "page")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourcePath: "docs/requirements.md", text: expect.stringContaining("质量看板") }),
			]),
		);
		expect(
			itemsFor(blueprint, "interaction")
				.map((item) => item.text)
				.join("\n"),
		).toContain("客户筛选");
		expect(
			itemsFor(blueprint, "state")
				.map((item) => item.text)
				.join("\n"),
		).toContain("空状态");
		expect(
			itemsFor(blueprint, "permission")
				.map((item) => item.text)
				.join("\n"),
		).toContain("管理员");
		expect(
			itemsFor(blueprint, "visual")
				.map((item) => item.text)
				.join("\n"),
		).toContain("移动端");
		expect(itemsFor(blueprint, "acceptance")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					text: expect.stringContaining("可观察变化"),
					sourcePath: "docs/requirements.md",
				}),
			]),
		);
	});

	it("falls back to a bounded objective requirement when no source document exists", () => {
		const objective = `Build a dashboard ${"x".repeat(1_000)}`;
		const blueprint = buildAgentV2ProductBlueprint({
			runId: "run-fallback",
			objective,
			responseLanguage: "en",
			inputBlobs: [],
			now: () => "2026-07-17T00:00:00.000Z",
		});

		expect(blueprint.sourceDocuments).toEqual([]);
		expect(itemsFor(blueprint, "requirement")).toEqual([
			expect.objectContaining({ sourcePath: "run.objective", line: 1 }),
		]);
		expect(itemsFor(blueprint, "requirement")[0]?.text.length).toBeLessThanOrEqual(500);
		expect(blueprint.summary.length).toBeLessThanOrEqual(240);
	});

	it("stores one source line once even when it supports several categories", () => {
		const blueprint = buildAgentV2ProductBlueprint({
			runId: "run-multi-category",
			objective: "生成经营看板",
			responseLanguage: "zh",
			inputBlobs: [
				textBlob(
					"docs/multi-category.md",
					"- 看板页面必须支持客户筛选，点击图表后进入下钻视图，并在移动端保持响应式布局。",
				),
			],
		});

		const matching = blueprint.items.filter((item) => item.text.includes("客户筛选"));
		expect(matching).toHaveLength(1);
		expect(matching[0]?.categories).toEqual(expect.arrayContaining(["requirement", "page", "interaction", "visual"]));
	});

	it("keeps large source documents within the global evidence budget", () => {
		const lines = Array.from(
			{ length: 150 },
			(_, index) => `- 页面 ${index + 1} 必须支持筛选、点击图表和移动端响应式布局。`,
		).join("\n");
		const blueprint = buildAgentV2ProductBlueprint({
			runId: "run-bounded",
			objective: "生成大型分析应用",
			responseLanguage: "zh",
			inputBlobs: [textBlob("docs/large.md", lines)],
		});

		expect(blueprint.items.length).toBeLessThanOrEqual(96);
		expect(blueprint.items.reduce((total, item) => total + item.text.length, 0)).toBeLessThanOrEqual(24_000);
		const metadata = blueprint.metadata;
		if (!metadata) throw new Error("expected product blueprint metadata");
		expect(metadata.truncated).toBe(true);
		expect(metadata.omittedItemCount).toBeGreaterThan(0);
	});
});

function textBlob(logicalPath: string, content: string): AgentV2InputBlobRecord {
	const bytes = new TextEncoder().encode(content);
	return {
		clientId: "client-a",
		runId: "run-blueprint",
		inputId: `input-${logicalPath}`,
		logicalPath,
		mediaType: "text/plain",
		encoding: "utf8",
		bytes,
		byteLength: bytes.byteLength,
		checksum: "sha256:requirements",
		createdAt: "2026-07-17T00:00:00.000Z",
	};
}

function itemsFor(
	blueprint: ReturnType<typeof buildAgentV2ProductBlueprint>,
	category: keyof typeof blueprint.categoryItemIds,
) {
	const ids = new Set(blueprint.categoryItemIds[category]);
	return blueprint.items.filter((item) => ids.has(item.id));
}
