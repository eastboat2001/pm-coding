import type { AgentV2DocumentRecord, SkillSummary } from "@mariozechner/pi-web-workspace";
import type {
	AgentV2DiagnosticEvent,
	AgentV2RunSnapshot,
} from "@mariozechner/pi-web-workspace/agent-v2-runtime";
import { describe, expect, it, vi } from "vitest";
import {
	type AgentV2AutomaticSkillSelectionEnvelope,
	buildAgentV2AutomaticSkillSelectionRequest,
	parseAgentV2AutomaticSkillSelectionResult,
	renderAgentV2AutomaticSkillSelectionPrompt,
	resolveAgentV2SkillContextForRun,
} from "../src/worker/agent-v2-automatic-skill-selection.js";

describe("Agent v2 automatic Skill selection", () => {
	it("offers only implicit Skills and accepts only exact authorized model selections", () => {
		const request = buildAgentV2AutomaticSkillSelectionRequest({
			run: run(),
			skills: [
				summary("dashboard-design", true, "Use this skill when building dashboards. Do not use for games."),
				summary("explicit-only", false, "Use this skill when explicitly selected. Do not use implicitly."),
			],
			documents: [blueprintDocument("Build an operations dashboard with charts and filters.")],
		});

		expect(request?.candidates.map((candidate) => candidate.name)).toEqual(["dashboard-design"]);
		expect(renderAgentV2AutomaticSkillSelectionPrompt(request!).systemPrompt).toContain(
			"Prefer selecting no Skill",
		);
		expect(
			parseAgentV2AutomaticSkillSelectionResult(
				'{"selectedSkillNames":["dashboard-design"],"reason":"The dashboard trigger clearly matches."}',
				request!,
			),
		).toEqual({
			selectedSkillNames: ["dashboard-design"],
			reason: "The dashboard trigger clearly matches.",
		});
		expect(() =>
			parseAgentV2AutomaticSkillSelectionResult(
				'{"selectedSkillNames":["invented-skill"],"reason":"Invented."}',
				request!,
			),
		).toThrow(/unauthorized/i);
	});

	it("persists the model decision and reuses it across later worker steps", async () => {
		const diagnostics: AgentV2DiagnosticEvent[] = [];
		const selector = {
			selectAutomaticSkills: vi.fn(async (): Promise<AgentV2AutomaticSkillSelectionEnvelope> => ({
				selectedSkillNames: ["dashboard-design"],
				reason: "The request is explicitly a dashboard.",
				provider: "test-provider",
				model: "test-model",
			})),
		};
		const skills = skillService([
			summary("dashboard-design", true, "Use this skill when building dashboards. Do not use for games."),
		]);
		const store = diagnosticStore(diagnostics, [blueprintDocument("Build a dashboard.")]);

		const first = await resolveAgentV2SkillContextForRun({
			run: run(),
			store,
			skills,
			selector,
			signal: new AbortController().signal,
			now: () => "2026-07-23T00:00:00.000Z",
		});
		const second = await resolveAgentV2SkillContextForRun({
			run: run(),
			store,
			skills,
			selector,
			signal: new AbortController().signal,
			now: () => "2026-07-23T00:00:01.000Z",
		});

		expect(first?.skills.map((skill) => skill.name)).toEqual(["dashboard-design"]);
		expect(second?.skills.map((skill) => skill.name)).toEqual(["dashboard-design"]);
		expect(selector.selectAutomaticSkills).toHaveBeenCalledTimes(1);
		expect(diagnostics).toEqual([
			expect.objectContaining({
				diagnosticId: "skill-auto-selection",
				code: "agent_v2.skill_auto_selection",
				data: expect.objectContaining({
					outcome: "selected",
					selectedSkillNames: ["dashboard-design"],
				}),
			}),
		]);
	});

	it("keeps an explicit selection authoritative and performs no automatic model call", async () => {
		const selector = { selectAutomaticSkills: vi.fn() };
		const explicitRun = run(["explicit-only"]);
		const context = await resolveAgentV2SkillContextForRun({
			run: explicitRun,
			store: diagnosticStore([], []),
			skills: skillService([
				summary("explicit-only", false, "Use only when explicitly selected. Do not use implicitly."),
				summary("automatic", true, "Use this skill when automatic applies. Do not use otherwise."),
			]),
			selector,
			signal: new AbortController().signal,
		});

		expect(context?.skills.map((skill) => skill.name)).toEqual(["explicit-only"]);
		expect(selector.selectAutomaticSkills).not.toHaveBeenCalled();
	});

	it("fails open when the optional model selector fails", async () => {
		const diagnostics: AgentV2DiagnosticEvent[] = [];
		const context = await resolveAgentV2SkillContextForRun({
			run: run(),
			store: diagnosticStore(diagnostics, [blueprintDocument("Build a dashboard.")]),
			skills: skillService([
				summary("dashboard-design", true, "Use this skill when building dashboards. Do not use for games."),
			]),
			selector: {
				selectAutomaticSkills: vi.fn(async () => {
					throw new Error("selector unavailable");
				}),
			},
			signal: new AbortController().signal,
		});

		expect(context).toBeUndefined();
		expect(diagnostics).toEqual([
			expect.objectContaining({
				severity: "warn",
				code: "agent_v2.skill_auto_selection",
				data: expect.objectContaining({ outcome: "failed_open", selectedSkillNames: [] }),
			}),
		]);
	});

	it("continues with the selected Skill when optional diagnostic persistence fails", async () => {
		const context = await resolveAgentV2SkillContextForRun({
			run: run(),
			store: {
				listAgentV2Documents: vi.fn(async () => [blueprintDocument("Build a dashboard.")]),
				listAgentV2Diagnostics: vi.fn(async () => []),
				commitAgentV2Diagnostic: vi.fn(async () => {
					throw new Error("diagnostic store unavailable");
				}),
			},
			skills: skillService([
				summary("dashboard-design", true, "Use this skill when building dashboards. Do not use for games."),
			]),
			selector: {
				selectAutomaticSkills: vi.fn(async () => ({
					selectedSkillNames: ["dashboard-design"],
					reason: "The dashboard trigger clearly matches.",
					provider: "test-provider",
					model: "test-model",
				})),
			},
			signal: new AbortController().signal,
		});

		expect(context?.skills.map((skill) => skill.name)).toEqual(["dashboard-design"]);
	});

	it("fails open before the selector when optional catalog discovery fails", async () => {
		const selector = { selectAutomaticSkills: vi.fn() };
		const context = await resolveAgentV2SkillContextForRun({
			run: run(),
			store: diagnosticStore([], []),
			skills: {
				list: () => {
					throw new Error("catalog unavailable");
				},
				load: vi.fn(),
				readResource: vi.fn(),
			},
			selector,
			signal: new AbortController().signal,
		});

		expect(context).toBeUndefined();
		expect(selector.selectAutomaticSkills).not.toHaveBeenCalled();
	});

	it("persists an empty no-match decision so later worker steps do not reroute", async () => {
		const diagnostics: AgentV2DiagnosticEvent[] = [];
		const selector = {
			selectAutomaticSkills: vi.fn(async () => ({
				selectedSkillNames: [],
				reason: "No candidate clearly matches the requested product.",
				provider: "test-provider",
				model: "test-model",
			})),
		};
		const input = {
			run: run(),
			store: diagnosticStore(diagnostics, [blueprintDocument("Build an inventory reconciliation tool.")]),
			skills: skillService([
				summary("marketing-landing-page", true, "Use this skill for marketing landing pages. Do not use for tools."),
			]),
			selector,
			signal: new AbortController().signal,
		};

		expect(await resolveAgentV2SkillContextForRun(input)).toBeUndefined();
		expect(await resolveAgentV2SkillContextForRun(input)).toBeUndefined();
		expect(selector.selectAutomaticSkills).toHaveBeenCalledTimes(1);
		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "agent_v2.skill_auto_selection",
				data: expect.objectContaining({ outcome: "no_match", selectedSkillNames: [] }),
			}),
		]);
	});

	it("keeps the first automatic Skill and skips a later Skill that exceeds the shared instruction budget", async () => {
		const diagnostics: AgentV2DiagnosticEvent[] = [];
		const summaries = [
			summary("first-skill", true, "Use this skill when first applies. Do not use otherwise."),
			summary("second-skill", true, "Use this skill when second applies. Do not use otherwise."),
		];
		const skills = skillService(summaries, {
			"first-skill": "A".repeat(50_000),
			"second-skill": "B".repeat(50_000),
		});
		const context = await resolveAgentV2SkillContextForRun({
			run: run(),
			store: diagnosticStore(diagnostics, [blueprintDocument("Use first and second workflows.")]),
			skills,
			selector: {
				selectAutomaticSkills: vi.fn(async () => ({
					selectedSkillNames: ["first-skill", "second-skill"],
					reason: "Both descriptions match.",
					provider: "test-provider",
					model: "test-model",
				})),
			},
			signal: new AbortController().signal,
		});

		expect(context?.skills.map((skill) => skill.name)).toEqual(["first-skill"]);
		expect(diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: "agent_v2.skill_auto_load_skipped",
					data: expect.objectContaining({
						loadedSkillNames: ["first-skill"],
						skippedSkills: [{ name: "second-skill", code: "skill_limit_exceeded" }],
					}),
				}),
			]),
		);
	});
});

function summary(name: string, allowImplicitInvocation: boolean, description: string): SkillSummary {
	return {
		name,
		description,
		location: `skill://${name}/SKILL.md`,
		allowImplicitInvocation,
	};
}

function run(selectedSkillNames: string[] = []): AgentV2RunSnapshot {
	return {
		clientId: "client-1",
		runId: "run-1",
		status: "running",
		phase: "implementation",
		attempt: 1,
		input: {
			sessionId: "session-1",
			title: "Operations dashboard",
			objective: "Build an operations dashboard with charts, filters, and a table.",
			responseLanguage: "en",
			selectedSkillNames,
			inputReferences: [],
		},
		model: { provider: "test-provider", id: "test-model" },
		workerId: "worker-1",
		createdAt: "2026-07-23T00:00:00.000Z",
		updatedAt: "2026-07-23T00:00:00.000Z",
		startedAt: "2026-07-23T00:00:00.000Z",
	};
}

function blueprintDocument(requirement: string): AgentV2DocumentRecord {
	return {
		clientId: "client-1",
		runId: "run-1",
		documentId: "product_blueprint",
		kind: "product_blueprint",
		version: "v2",
		contentMarkdown: requirement,
		contentJson: {
			kind: "product_blueprint",
			version: 1,
			title: "Operations dashboard",
			summary: requirement,
			responseLanguage: "en",
			sourceDocuments: [],
			items: [
				{
					id: "item-1",
					text: requirement,
					sourceInputId: "input-1",
					sourcePath: "requirements.md",
					sourceChecksum: `sha256:${"a".repeat(64)}`,
					line: 1,
					categories: ["requirement", "page", "visual"],
				},
			],
			categoryItemIds: {
				requirement: ["item-1"],
				page: ["item-1"],
				interaction: [],
				state: [],
				permission: [],
				visual: ["item-1"],
				acceptance: [],
			},
		},
		sourceTaskId: "spec",
		createdAt: "2026-07-23T00:00:00.000Z",
		updatedAt: "2026-07-23T00:00:00.000Z",
	};
}

function skillService(summaries: SkillSummary[], contentByName: Record<string, string> = {}) {
	return {
		list: () => ({ skills: summaries, diagnostics: [] }),
		load: ({ name }: { name: string }) => {
			const selected = summaries.find((skill) => skill.name === name);
			if (!selected) throw new Error(`Skill not found: ${name}`);
			return {
				...selected,
				content: contentByName[name] ?? `Apply ${name}.`,
				resources: [],
			};
		},
		readResource: vi.fn(),
	};
}

function diagnosticStore(
	diagnostics: AgentV2DiagnosticEvent[],
	documents: AgentV2DocumentRecord[],
) {
	return {
		listAgentV2Documents: vi.fn(async () => documents),
		listAgentV2Diagnostics: vi.fn(async () => diagnostics),
		commitAgentV2Diagnostic: vi.fn(async ({ diagnostic }: { diagnostic: AgentV2DiagnosticEvent }) => {
			if (!diagnostics.some((candidate) => candidate.diagnosticId === diagnostic.diagnosticId)) {
				diagnostics.push(diagnostic);
			}
			return {} as never;
		}),
	};
}
