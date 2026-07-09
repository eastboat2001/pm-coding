import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

const PHASE4_FILES = [
	"agent-v2-tool-governance.ts",
	"agent-v2-file-adapter.ts",
	"agent-v2-validation-gate.ts",
	"agent-v2-repair-engine.ts",
	"agent-v2-execution-core.ts",
];

const FORBIDDEN = [
	"PI_APP_AGENT_VERSION",
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"app-preview-goal",
	"buildSpecArtifact",
	"SPEC_ARTIFACT_PROJECT_FILES",
	"AppPreviewGoalSupervisor",
	"createRunAgent",
	"WorkspaceRunApiService",
	"WorkspaceRunWorkerService",
	"legacy-v1-main",
	"selectApplicationGenerationRuntime",
	"project_task",
	"project_file",
];

describe("agent v2 phase 4 import boundary", () => {
	it("does not reference legacy application generation internals or old tool contracts", () => {
		for (const file of PHASE4_FILES) {
			const source = readFileSync(join(SRC_ROOT, file), "utf8");
			for (const forbidden of FORBIDDEN) {
				expect(source, `${file} must not reference ${forbidden}`).not.toContain(forbidden);
			}
		}
	});
});
