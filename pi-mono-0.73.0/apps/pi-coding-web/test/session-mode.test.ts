import { describe, expect, it, vi } from "vitest";
import {
	canSwitchSessionMode,
	defaultSessionModeForEntry,
	dispatchSessionPrompt,
	normalizeSessionMode,
	sessionModeLabel,
	sessionModeTools,
} from "../src/app/session-mode.js";

describe("session mode", () => {
	it("uses chat as the safe default for standalone and historical sessions", () => {
		expect(defaultSessionModeForEntry("standalone")).toBe("chat");
		expect(normalizeSessionMode(undefined)).toBe("chat");
		expect(normalizeSessionMode("legacy-generation")).toBe("chat");
	});

	it("uses app generation only for an explicitly trusted PM handoff", () => {
		expect(defaultSessionModeForEntry("pm_handoff")).toBe("app_generation");
		expect(normalizeSessionMode("app_generation")).toBe("app_generation");
		expect(normalizeSessionMode("chat")).toBe("chat");
	});

	it("blocks switching while chat streams or a v2 run is unsettled", () => {
		expect(canSwitchSessionMode({ isStreaming: false, hasActiveRun: false })).toBe(true);
		expect(canSwitchSessionMode({ isStreaming: true, hasActiveRun: false })).toBe(false);
		expect(canSwitchSessionMode({ isStreaming: false, hasActiveRun: true })).toBe(false);
	});

	it("routes a prompt to exactly one explicit mode handler", async () => {
		const chat = vi.fn(async () => undefined);
		const appGeneration = vi.fn(async () => undefined);
		await dispatchSessionPrompt("chat", { chat, appGeneration }, "你好");
		expect(chat).toHaveBeenCalledWith("你好", undefined);
		expect(appGeneration).not.toHaveBeenCalled();

		chat.mockClear();
		await dispatchSessionPrompt("app_generation", { chat, appGeneration }, "生成看板");
		expect(appGeneration).toHaveBeenCalledWith("生成看板", undefined);
		expect(chat).not.toHaveBeenCalled();
	});

	it("exposes only read-only skill tools in chat and no browser tools in app generation", () => {
		const readOnlyTools = [{ name: "skill_load" }, { name: "skill_resource" }];
		expect(sessionModeTools("chat", readOnlyTools)).toEqual(readOnlyTools);
		expect(sessionModeTools("chat", readOnlyTools)).not.toBe(readOnlyTools);
		expect(sessionModeTools("app_generation", readOnlyTools)).toEqual([]);
	});

	it("localizes visible mode labels with a stable English fallback", () => {
		expect(sessionModeLabel("chat", "zh-CN")).toBe("对话");
		expect(sessionModeLabel("app_generation", "zh-CN")).toBe("应用生成");
		expect(sessionModeLabel("chat", "de")).toBe("Chat");
		expect(sessionModeLabel("app_generation", "ms")).toBe("Penjanaan aplikasi");
		expect(sessionModeLabel("app_generation", "unknown")).toBe("App generation");
	});
});
