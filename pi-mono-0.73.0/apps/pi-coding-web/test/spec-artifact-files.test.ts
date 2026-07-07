import { describe, expect, it } from "vitest";
import { planCapabilities } from "../src/runtime/capability-planner.js";
import { STATIC_PREVIEW_CONTRACT } from "../src/runtime/platform-contract.js";
import { buildSpecArtifact } from "../src/runtime/spec-artifact.js";
import { mergeProjectFileSeeds, specArtifactProjectFileSeeds } from "../src/runtime/spec-artifact-files.js";

describe("spec artifact project files", () => {
	it("creates Spec Kit style files for the generated project workspace", () => {
		const messages = [
			{
				role: "user",
				content:
					"Build a full-stack dashboard with backend APIs, PostgreSQL persistence, auth, KPI cards, charts, and CSV export.",
				timestamp: 1,
			},
		];
		const capabilityPlan = planCapabilities({
			messages,
			platform: STATIC_PREVIEW_CONTRACT,
			source: "test",
		});
		const spec = buildSpecArtifact({ messages, capabilityPlan, platform: STATIC_PREVIEW_CONTRACT });

		const files = specArtifactProjectFileSeeds(spec);

		expect(files.map((file) => file.filename)).toEqual(["docs/spec.md", "docs/plan.md", "docs/tasks.md"]);
		expect(files[0]?.content).toContain("# Specification");
		expect(files[0]?.content).toContain("Build a full-stack dashboard");
		expect(files[1]?.content).toContain("# Implementation Plan");
		expect(files[1]?.content).toContain("static_simulation");
		expect(files[2]?.content).toContain("# Tasks");
		expect(files[2]?.content).toContain("- [ ] Run `project_task validate`");
		expect(files[2]?.content).toContain("- [ ] Confirm first preview renders meaningful data");
	});

	it("deduplicates generated and attachment project file seeds", () => {
		const merged = mergeProjectFileSeeds([
			{ filename: "docs/spec.md", content: "generated" },
			{ filename: "docs/Requirements.md", content: "requirements" },
			{ filename: "DOCS/spec.md", content: "duplicate" },
		]);

		expect(merged).toEqual([
			{ filename: "docs/spec.md", content: "generated" },
			{ filename: "docs/Requirements.md", content: "requirements" },
		]);
	});
});
