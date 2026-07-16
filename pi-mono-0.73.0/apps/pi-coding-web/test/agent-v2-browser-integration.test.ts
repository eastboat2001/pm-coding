import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");

describe("Agent v2 browser integration source", () => {
	it("registers legacy read-only history and the unified terminal result without creating new activity messages", () => {
		expect(bootstrapSource).toContain("registerLegacyAgentV2ActivityMessageRenderer");
		expect(bootstrapSource).toContain("registerAgentV2RunResultMessageRenderer");
		expect(bootstrapSource).not.toContain("createAgentV2ActivityMessage");
		expect(bootstrapSource).not.toContain("appendAgentV2ActivityMessage");
		expect(bootstrapSource).not.toContain("formatAgentV2DeliveryReport");
		expect(bootstrapSource).not.toContain("formatAgentV2FailureReport");
	});

	it("keeps one active presentation and renders it only through the app-generation active-run slot", () => {
		expect(bootstrapSource.match(/let activeAgentV2Presentation\b/gu)).toHaveLength(1);
		expect(bootstrapSource.match(/let workspaceExpansionState\b/gu)).toHaveLength(1);
		expect(bootstrapSource).toContain("agentInterface.activeRunContent");
		expect(bootstrapSource).toMatch(/currentSessionMode === "app_generation"[\s\S]*activeAgentV2Presentation/u);
		expect(bootstrapSource).not.toMatch(/let activeSidebarPanel\b/u);
		expect(bootstrapSource).not.toMatch(/let currentProjectFilePreviewFilename\b/u);
	});

	it("routes workspace regions and settings through the expansion coordinator", () => {
		for (const action of [
			"open_sidebar",
			"open_file_preview",
			"open_active_run_detail",
			"open_historical_run_detail",
			"open_internal_section",
			"open_settings",
			"close_settings",
		]) {
			expect(bootstrapSource).toContain(`type: "${action}"`);
		}
	});

	it("retains the existing Chat prompt and skill-runtime path", () => {
		expect(bootstrapSource).toContain("chat: async (chatInput, chatImages) => {");
		expect(bootstrapSource).toContain("const runtime = await createChatSkillRuntime({");
		expect(bootstrapSource).toContain("await invokeChatPrompt(chatInput, chatImages);");
		expect(bootstrapSource).toContain("appGeneration: startRemotePrompt");
	});
});
