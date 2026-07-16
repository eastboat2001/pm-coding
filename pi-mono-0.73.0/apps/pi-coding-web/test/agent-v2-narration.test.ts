import { describe, expect, it } from "vitest";
import {
	createAgentV2NarrationState,
	markAgentV2NarrationCandidateNarrated,
	narrationCandidateToAssistantMessage,
	projectAgentV2Narration,
} from "../src/runtime/agent-v2-narration.js";

const NOW = "2026-07-16T00:00:00.000Z";

describe("Agent v2 narration", () => {
	it("projects only meaningful stage changes and de-duplicates replay by key and text", () => {
		let state = createAgentV2NarrationState();
		const understanding = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en-US",
			event: phase("intake"),
		});
		state = understanding.state;
		const sameStage = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en-US",
			event: phase("capability_routing"),
		});
		state = sameStage.state;
		const implementation = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en-US",
			event: phase("implementation"),
		});
		state = implementation.state;
		const replay = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en-US",
			event: phase("implementation"),
		});

		expect(understanding.candidate?.text).toBe("I’m understanding what you need.");
		expect(sameStage.candidate).toBeUndefined();
		expect(implementation.candidate?.text).toBe("I’m implementing the plan.");
		expect(replay.candidate).toBeUndefined();
	});

	it("projects trusted output summaries but never diagnostic or Skill internals", () => {
		let state = createAgentV2NarrationState();
		const output = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en",
			event: outputEvent("The dashboard is implemented."),
		});
		state = output.state;
		const sameTextOnAnotherTask = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en",
			event: { ...outputEvent("The dashboard is implemented."), taskId: "task-2" },
		});
		state = sameTextOnAnotherTask.state;
		const hiddenEvents = [
			{
				type: "agent_v2.diagnostic_recorded" as const,
				diagnosticId: "diagnostic-1",
				severity: "error" as const,
				code: "raw.tool_arguments",
				message: "secret tool arguments and hidden reasoning",
				at: NOW,
			},
			{
				type: "agent_v2.skill_applied" as const,
				name: "private-skill",
				location: "skill://private/SKILL.md",
				at: NOW,
			},
			{
				type: "agent_v2.skill_resource_loaded" as const,
				name: "private-skill",
				path: "references/internal.md",
				checksum: `sha256:${"a".repeat(64)}`,
				at: NOW,
			},
		];

		expect(output.candidate).toMatchObject({ source: "output", text: "The dashboard is implemented." });
		expect(sameTextOnAnotherTask.candidate).toBeUndefined();
		for (const event of hiddenEvents) {
			expect(projectAgentV2Narration(state, { runId: "run-1", locale: "en", event }).candidate).toBeUndefined();
		}
		expect(JSON.stringify(output.candidate)).not.toMatch(/diagnostic|checksum|arguments|reasoning|SKILL\.md/iu);
	});

	it.each([
		["zh-CN", "正在检查结果并修复问题。"],
		["en-GB", "I’m checking the result and fixing issues."],
		["de-DE", "Ich prüfe das Ergebnis und behebe Probleme."],
		["ms-MY", "Saya sedang menyemak hasil dan membaiki masalah."],
		["fr-FR", "I’m checking the result and fixing issues."],
	])("uses localized stage copy for %s with English fallback", (locale, expected) => {
		const result = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale,
			event: phase("validation"),
		});

		expect(result.candidate?.text).toBe(expected);
	});

	it("converts event text with zero usage and preserves provider-backed output identity", () => {
		const phaseCandidate = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale: "en",
			event: phase("planning_ready"),
		}).candidate;
		const outputCandidate = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale: "en",
			event: outputEvent("Provider summary."),
		}).candidate;
		if (!phaseCandidate || !outputCandidate) throw new Error("Expected narration candidates.");

		const eventMessage = narrationCandidateToAssistantMessage(phaseCandidate);
		const providerMessage = narrationCandidateToAssistantMessage(outputCandidate);
		const narrated = markAgentV2NarrationCandidateNarrated(outputCandidate);

		expect(eventMessage).toMatchObject({
			role: "assistant",
			api: "agent-v2",
			provider: "agent-v2",
			model: "event",
			usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } },
		});
		expect(providerMessage).toMatchObject({
			provider: "openai",
			model: "gpt-test",
			usage: { input: 12, output: 34, totalTokens: 46, cost: { total: 0.25 } },
		});
		expect(narrated).toMatchObject({ alreadyNarrated: true, provider: "openai", model: "gpt-test" });
	});
});

function phase(phase: string) {
	return {
		type: "agent_v2.phase_changed" as const,
		phase: phase === "planning_ready" ? ("plan_draft" as const) : phase,
		status: "running" as const,
		at: NOW,
	};
}

function outputEvent(summary: string) {
	return {
		type: "agent_v2.output_recorded" as const,
		taskId: "task-1",
		summary,
		provider: "openai",
		model: "gpt-test",
		usage: { input: 12, output: 34, totalTokens: 46, costTotal: 0.25 },
		at: NOW,
	};
}
