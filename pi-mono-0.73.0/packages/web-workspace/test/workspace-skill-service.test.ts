import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StorageConfig } from "../src/types.js";
import { WorkspaceSkillService } from "../src/workspace-skill-service.js";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "pi-web-workspace-skill-"));
}

function testConfig(root: string): StorageConfig {
	return {
		sessionsDir: join(root, "data", "sessions"),
		settingsFile: join(root, "data", "settings.json"),
		projectsRootDir: join(root, "data", "projects"),
		skillsDir: join(root, "data", "skills"),
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		serverSessionSyncEnabled: false,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
	};
}

describe("WorkspaceSkillService compatibility", () => {
	it("parses OpenAI agents metadata without listing it as agent-facing resource", () => {
		const root = tempRoot();
		const config = testConfig(root);
		const skillDir = join(config.skillsDir, "page-style");
		mkdirSync(join(skillDir, "agents"), { recursive: true });
		mkdirSync(join(skillDir, "references"), { recursive: true });
		mkdirSync(join(skillDir, "scripts"), { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: page-style
description: Create static pages with a distinctive visual system.
---

# Page Style

Read references/layout.md when building a page.
`,
			"utf8",
		);
		writeFileSync(
			join(skillDir, "agents", "openai.yaml"),
			`interface:
  display_name: "Page Style"
  short_description: "Distinctive static page design"
  default_prompt: "Use $page-style to design a static landing page."
  brand_color: "#2563EB"
`,
			"utf8",
		);
		writeFileSync(join(skillDir, "references", "layout.md"), "# Layout\n\nUse strong rhythm.", "utf8");
		writeFileSync(join(skillDir, "scripts", "audit.py"), "print('audit')\n", "utf8");

		const service = new WorkspaceSkillService(config);
		const list = service.list();
		const skill = list.skills[0];

		expect(skill).toMatchObject({
			name: "page-style",
			description: "Create static pages with a distinctive visual system.",
			interface: {
				displayName: "Page Style",
				shortDescription: "Distinctive static page design",
				defaultPrompt: "Use $page-style to design a static landing page.",
				brandColor: "#2563EB",
			},
		});

		const loaded = service.load({ name: "page-style" });
		expect(loaded.resources.map((resource) => resource.path)).toEqual(["references/layout.md", "scripts/audit.py"]);
	});
});
