import { describe, expect, it } from "vitest";
import { planCapabilities } from "../src/runtime/capability-planner.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";
import {
	buildCodingSystemPrompt,
	DEFAULT_SYSTEM_PROMPT,
	PI_CODING_HANDOFF_INSTRUCTIONS_EN,
} from "../src/prompts/coding-system-prompt.js";

describe("coding system prompt", () => {
	it("tells the model to read compacted project file content before editing existing files", () => {
		const prompts = [
			["default", DEFAULT_SYSTEM_PROMPT],
			["handoff", PI_CODING_HANDOFF_INSTRUCTIONS_EN],
		] as const;

		for (const [name, prompt] of prompts) {
			expect(prompt, name).toContain("project_file get");
			expect(prompt, name).toContain("contentOmitted");
			expect(prompt, name).toContain("Project file content omitted from compacted history");
			expect(prompt, name).not.toContain("project_file content omitted");
			expect(prompt, name).not.toContain("project_file get result omitted");
		}
	});

	it("discourages repeated full-file rewrites for small edits", () => {
		const prompts = [
			["default", DEFAULT_SYSTEM_PROMPT],
			["handoff", PI_CODING_HANDOFF_INSTRUCTIONS_EN],
		] as const;

		for (const [name, prompt] of prompts) {
			expect(prompt, name).toContain("Prefer project_file update");
			expect(prompt, name).toContain("avoid rewriting an entire large file");
		}
	});

	it("keeps available skill entries compact while preserving routing metadata", () => {
		const prompt = buildCodingSystemPrompt([
			{
				name: "page-style",
				description: "Create static pages with a distinctive visual system that includes a long routing description.",
				location: "skill://page-style/SKILL.md",
				interface: {
					displayName: "Page Style",
					shortDescription: "Distinctive static page design",
					defaultPrompt: "Use $page-style to design a static landing page.",
				},
			},
		]);

		expect(prompt).toContain("<name>page-style</name>");
		expect(prompt).toContain("<description>Distinctive static page design</description>");
		expect(prompt).toContain("<location>skill://page-style/SKILL.md</location>");
		expect(prompt).not.toContain("<display_name>");
		expect(prompt).not.toContain("<short_description>");
		expect(prompt).not.toContain("<default_prompt>");
		expect(prompt).not.toContain("long routing description");
	});

	it("keeps assistant and generated UI language aligned with the user request", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Match the latest user request language");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("without switching the output language");
	});

	it("does not invite skill tool calls when no skills are listed", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Only call skill_load for skill names listed in <available_skills>");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("If there is no <available_skills> section");
	});

	it("tells the model to read document attachments from project workspace paths", () => {
		expect(DEFAULT_SYSTEM_PROMPT).toContain("User attachments are saved into the current session project workspace");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("Ordinary document and image attachments are also included in the message context");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("attachments/*.md or docs/*.md");
		expect(DEFAULT_SYSTEM_PROMPT).toContain("only when a prompt explicitly lists");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("attachments/original");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("Do not call project_file get with an ordinary attachment filename");
	});

	it("injects a per-run capability plan when the platform cannot satisfy full-stack requirements", () => {
		const capabilityPlan = planCapabilities({
			messages: [
				{
					role: "user",
					content: "Build a full-stack app with backend APIs, database persistence, and auth.",
					timestamp: 1,
				},
			],
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const prompt = buildCodingSystemPrompt([], {
			platformContract: STATIC_PREVIEW_CONTRACT,
			capabilityPlan,
		});

		expect(prompt).toContain("<capability_plan>");
		expect(prompt).toContain("adapter: static-preview");
		expect(prompt).toContain("delivery_mode: static_simulation");
		expect(prompt).toContain("unsupported_capabilities: backend_server, database_runtime, server_auth");
		expect(prompt).toContain("Do not claim that PI created a real backend, database, or server auth runtime.");
	});

	it("does not include legacy spec artifact instructions in the default generation prompt", () => {
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("<spec_artifact>");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("<spec_execution_contract>");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("docs/spec.md");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("docs/plan.md");
		expect(DEFAULT_SYSTEM_PROMPT).not.toContain("docs/tasks.md");

		const prompt = buildCodingSystemPrompt([], {
			platformContract: STATIC_PREVIEW_CONTRACT,
			capabilityPlan: planCapabilities({
				messages: [
					{
						role: "user",
						content: "Build a full-stack dashboard with KPI cards and charts.",
						timestamp: 1,
					},
				],
				platform: STATIC_PREVIEW_CONTRACT,
				source: "test",
			}),
		});

		expect(prompt).not.toContain("<spec_artifact>");
		expect(prompt).not.toContain("<spec_execution_contract>");
	});
});
