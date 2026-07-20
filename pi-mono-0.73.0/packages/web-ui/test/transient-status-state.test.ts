import { describe, expect, it } from "vitest";
import { parseTransientStatusText } from "../src/components/transient-status-state.js";

describe("transient status state", () => {
	it("separates retry progress from the status label", () => {
		expect(parseTransientStatusText("Retrying request... (2/5)")).toEqual({
			kind: "retry",
			label: "Retrying request...",
			progress: "2/5",
		});
		expect(parseTransientStatusText("正在重试请求... (3/5)")).toEqual({
			kind: "retry",
			label: "正在重试请求...",
			progress: "3/5",
		});
	});

	it("separates elapsed activity progress without classifying it as a retry", () => {
		expect(parseTransientStatusText("模型正在处理应用生成请求… (12s)")).toEqual({
			kind: "waiting",
			label: "模型正在处理应用生成请求…",
			progress: "12s",
		});
	});

	it("classifies recovery and waiting status without retry progress", () => {
		expect(parseTransientStatusText("运行连接已中断，正在恢复更新...")).toEqual({
			kind: "recovery",
			label: "运行连接已中断，正在恢复更新...",
		});
		expect(parseTransientStatusText("模型响应暂无更新，正在等待恢复...")).toEqual({
			kind: "waiting",
			label: "模型响应暂无更新，正在等待恢复...",
		});
	});
});
