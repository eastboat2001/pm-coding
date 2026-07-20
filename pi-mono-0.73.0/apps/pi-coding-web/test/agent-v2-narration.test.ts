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
			objective: "Build a sales dashboard",
			event: phase("intake"),
		});
		state = understanding.state;
		const sameStage = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en-US",
			objective: "Build a sales dashboard",
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

		expect(understanding.candidate?.text).toContain("Goal: Build a sales dashboard");
		expect(understanding.candidate?.text).toContain("runs directly in the browser");
		expect(sameStage.candidate).toBeUndefined();
		expect(implementation.candidate?.text).toContain("Implementation is now underway");
		expect(replay.candidate).toBeUndefined();
	});

	it("projects trusted output summaries but never diagnostic or Skill internals", () => {
		let state = createAgentV2NarrationState();
		const output = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en",
			artifactPaths: ["index.html", "src/main.js", "src/main.js"],
			event: outputEvent("The dashboard is implemented."),
		});
		state = output.state;
		const sameTextOnAnotherTask = projectAgentV2Narration(state, {
			runId: "run-1",
			locale: "en",
			artifactPaths: ["index.html", "src/main.js", "src/main.js"],
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

		expect(output.candidate).toMatchObject({ source: "output" });
		expect(output.candidate?.text).toContain("The dashboard is implemented.");
		expect(output.candidate?.text).toContain("2 files were created or updated: index.html, src/main.js.");
		expect(output.candidate?.text).toContain("static startup and preview checks");
		expect(sameTextOnAnotherTask.candidate).toBeUndefined();
		for (const event of hiddenEvents) {
			expect(projectAgentV2Narration(state, { runId: "run-1", locale: "en", event }).candidate).toBeUndefined();
		}
		expect(JSON.stringify(output.candidate)).not.toMatch(/diagnostic|checksum|arguments|reasoning|SKILL\.md/iu);
	});

	it.each([
		["zh-CN", "代码已经进入检查阶段"],
		["en-GB", "The code is now being checked"],
		["de-DE", "Der Code wird jetzt geprüft"],
		["ms-MY", "Kod kini dalam peringkat semakan"],
		["fr-FR", "The code is now being checked"],
	])("uses localized stage copy for %s with English fallback", (locale, expected) => {
		const result = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale,
			event: phase("validation"),
		});

		expect(result.candidate?.text).toContain(expected);
	});

	it("uses a distinct repair narration instead of regressing to implementation", () => {
		const result = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale: "en",
			event: phase("repair"),
		});

		expect(result.candidate).toMatchObject({
			stage: "validation",
			phase: "repair",
		});
		expect(result.candidate?.text).toContain("repairable issue");
	});

	it("narrates validation outcomes without exposing raw diagnostics", () => {
		const failed = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale: "zh-CN",
			event: validationEvent("failed", 1),
		});
		const passed = projectAgentV2Narration(failed.state, {
			runId: "run-1",
			locale: "zh-CN",
			event: validationEvent("passed", 2),
		});

		expect(failed.candidate?.text).toContain("本轮校验发现问题");
		expect(passed.candidate?.text).toContain("校验已经通过");
		expect(JSON.stringify([failed.candidate, passed.candidate])).not.toContain("secret diagnostic");
	});

	it("keeps Chinese narration Chinese when the provider summary is unexpectedly English", () => {
		const output = projectAgentV2Narration(createAgentV2NarrationState(), {
			runId: "run-1",
			locale: "zh-CN",
			artifactPaths: ["index.html"],
			event: outputEvent("Dashboard implementation complete."),
		});

		expect(output.candidate?.text).toBe(
			"已生成或更新 1 个文件：index.html。\n\n下一步将运行静态启动检查和预览验证。",
		);
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

function validationEvent(status: "failed" | "passed", attempt: number) {
	return {
		type: "agent_v2.validation_recorded" as const,
		validationId: "validation-1",
		taskId: "validate",
		attempt,
		status,
		summary: "secret diagnostic",
		at: NOW,
	};
}
