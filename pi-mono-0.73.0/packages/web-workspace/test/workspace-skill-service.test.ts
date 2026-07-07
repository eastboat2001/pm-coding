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
		settingsFile: join(root, "data", "settings.json"),
		clientsRootDir: join(root, "data", "clients"),
		skillsDir: join(root, "data", "skills"),
		defaultSkillsDir: join(root, "data", "default-skills"),
		runtimeDbFile: join(root, "data", "runtime", "pi-runtime.sqlite"),
		redisUrl: "redis://127.0.0.1:6379",
		runtimeStore: "postgres",
		postgresUrl: "postgres://pi:pi@postgres:5432/pi_coding",
		runsEnabled: false,
		workerId: "test-worker",
		workerConcurrency: 2,
		runMaxAgentTurns: 80,
		runMaxAgentToolExecutions: 240,
		runRetryMaxAttempts: 8,
		runRetryBaseDelayMs: 2000,
		runRetryMaxDelayMs: 60000,
		runRetryJitterRatio: 0.2,
		runQueueName: "pi:runs",
		runEventRetentionDays: 30,
		runEventStreamMaxLen: 5000,
		runEventStreamTtlSeconds: 3600,
		runEventCheckpointIntervalMs: 400,
		runEventCheckpointMinChars: 256,
		clientIdRequired: true,
		previewBaseUrl: "http://localhost:5173",
		projectInstallCommand: "npm install",
		projectBuildCommand: "npm run build",
		projectInstallTimeoutMs: 120000,
		projectBuildTimeoutMs: 120000,
		defaultModelProvider: "",
		defaultModelId: "",
		handoffDefaultThinkingLevel: "high",
		envFile: "",
		envFileExists: false,
		logsDbFile: join(root, "data", "logs", "pi-diagnostics.sqlite"),
		loggingEnabled: true,
		logStdoutEnabled: false,
		rawProviderLoggingEnabled: false,
		rawProviderLogMaxChars: 12000,
		promptSnapshotLoggingEnabled: false,
		promptSnapshotMaxChars: 20000,
		modelOutputSnapshotLoggingEnabled: false,
		modelOutputSnapshotMaxChars: 20000,
		modelStreamIdleTimeoutMs: 60000,
		modelMaxOutputTokens: 12000,
		contextProviderPayloadBudgetChars: 90000,
		logRetentionDays: 30,
		logMaxEvents: 50000,
		logCleanupIntervalMs: 3600000,
		logVacuumIntervalMs: 86400000,
		langfuseEnabled: false,
		langfuseHost: "",
		langfusePublicKey: "",
		langfuseSecretKey: "",
		langfuseOtelEndpoint: "",
		langfuseFlushIntervalMs: 5000,
		langfuseBatchSize: 50,
		langfuseExportPromptSnapshots: false,
		langfuseExportRawChunks: false,
		langfuseExportModelOutputSnapshots: false,
		otelServiceName: "pi-coding-web",
		otelDeploymentEnvironment: "",
	};
}

function writeSkill(root: string, name: string, description: string, body = "Use this skill body."): void {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: ${description}
---

# ${name}

${body}
`,
		"utf8",
	);
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

	it("reports quality warnings for vague skill descriptions", () => {
		const root = tempRoot();
		const config = testConfig(root);
		const skillDir = join(config.skillsDir, "vague-style");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: vague-style
description: Make things better.
---

# Vague Style
`,
			"utf8",
		);

		const service = new WorkspaceSkillService(config);
		const list = service.list();

		expect(list.skills.map((skill) => skill.name)).toEqual(["vague-style"]);
		expect(list.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(
			expect.arrayContaining([
				'description should include explicit trigger wording such as "Use this skill when" or "Use when"',
				'description should describe non-use boundaries, for example: "Do not use for backend-only, data-only, or pure documentation tasks."',
				"description should be specific enough to guide model invocation; include task types, trigger phrases, and boundaries",
			]),
		);
	});

	it("keeps skill diagnostics in the API response without writing backend diagnostic events", () => {
		const root = tempRoot();
		const config = testConfig(root);
		const diagnostics = new RecordingDiagnostics();
		const skillDir = join(config.skillsDir, "vague-style");
		mkdirSync(skillDir, { recursive: true });
		writeFileSync(
			join(skillDir, "SKILL.md"),
			`---
name: vague-style
description: Make things better.
---

# Vague Style
`,
			"utf8",
		);

		const service = new WorkspaceSkillService(config, diagnostics);
		const list = service.list();

		expect(list.diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics.events).toEqual([]);
	});

	it("reports invalid skill files with paths and excludes them from available skills", () => {
		const root = tempRoot();
		const config = testConfig(root);
		const markdownMetadataDir = join(config.skillsDir, "markdown-metadata");
		const missingNameDir = join(config.skillsDir, "missing-name");
		const versionedDir = join(config.skillsDir, "ui-ux-design-1.0.0");
		mkdirSync(markdownMetadataDir, { recursive: true });
		mkdirSync(missingNameDir, { recursive: true });
		mkdirSync(versionedDir, { recursive: true });
		writeFileSync(
			join(markdownMetadataDir, "SKILL.md"),
			`# UI/UX Design

**Name:** ui-ux-design
**Description:** Use this skill when creating UI/UX design. Do not use for backend-only tasks.
`,
			"utf8",
		);
		writeFileSync(
			join(missingNameDir, "SKILL.md"),
			`---
description: Use this skill when creating UI/UX design. Do not use for backend-only tasks.
---

# Missing Name
`,
			"utf8",
		);
		writeFileSync(
			join(versionedDir, "SKILL.md"),
			`---
name: ui-ux-design
description: Use this skill when creating UI/UX design. Do not use for backend-only tasks.
---

# UI/UX Design
`,
			"utf8",
		);

		const service = new WorkspaceSkillService(config);
		const list = service.list();

		expect(list.skills).toEqual([]);
		expect(list.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "error",
					path: "markdown-metadata/SKILL.md",
					message: "description is required in SKILL.md YAML frontmatter",
				}),
				expect.objectContaining({
					type: "error",
					path: "missing-name/SKILL.md",
					message: "name is required in SKILL.md YAML frontmatter",
				}),
				expect.objectContaining({
					type: "error",
					path: "ui-ux-design-1.0.0/SKILL.md",
					message: 'name "ui-ux-design" does not match skill path "ui-ux-design-1.0.0"',
				}),
			]),
		);
	});

	it("keeps default forced skills hidden from selectable skills while allowing backend load", () => {
		const root = tempRoot();
		const config = testConfig(root);
		writeSkill(
			config.skillsDir,
			"selectable-style",
			"Use this skill when creating selectable page styles. Do not use for backend-only tasks.",
		);
		writeSkill(
			config.defaultSkillsDir,
			"platform-defaults",
			"Use this skill when any PI static app is generated. Do not use outside PI static preview delivery.",
			"Always preserve PI platform defaults.",
		);
		writeSkill(
			config.skillsDir,
			"platform-defaults",
			"Use this skill when selecting visible platform defaults. Do not use for backend-forced defaults.",
			"This duplicate should stay hidden behind the default skill.",
		);

		const service = new WorkspaceSkillService(config);
		const list = service.list();

		expect(list.skills.map((skill) => skill.name)).toEqual(["selectable-style"]);
		expect(list.promptSkills.map((skill) => skill.name)).toEqual(["selectable-style"]);
		expect(list.defaultSkills.map((skill) => skill.name)).toEqual(["platform-defaults"]);
		expect(list.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			'name "platform-defaults" collision between selectable and default skills',
		);
		expect(service.load({ name: "platform-defaults" }).content).toContain("Always preserve PI platform defaults.");
	});
});

class RecordingDiagnostics {
	events: Array<Record<string, unknown>> = [];

	writeEvents(input: { events: Array<Record<string, unknown>> }): { accepted: number; dropped: number } {
		this.events.push(...input.events);
		return { accepted: input.events.length, dropped: 0 };
	}
}
