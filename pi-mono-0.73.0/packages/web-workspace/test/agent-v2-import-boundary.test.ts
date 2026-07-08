import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(process.cwd(), "src");

const V2_RUNTIME_FILES = [
	"agent-v2-task-engine.ts",
	"agent-v2-artifact-index.ts",
	"agent-v2-context-packet.ts",
	"agent-v2-runtime-core.ts",
];

const FORBIDDEN_IMPORT_FRAGMENTS = [
	"capability-planner",
	"spec-artifact",
	"context-orchestrator",
	"preview-goal",
	"app-preview-goal",
	"createRunAgent",
	"selectApplicationGenerationRuntime",
];

describe("agent v2 runtime import boundary", () => {
	it("does not import legacy application generation internals", () => {
		for (const fileName of V2_RUNTIME_FILES) {
			const source = readFileSync(join(SRC_ROOT, fileName), "utf8");
			for (const forbidden of FORBIDDEN_IMPORT_FRAGMENTS) {
				expect(source, `${fileName} must not reference ${forbidden}`).not.toContain(forbidden);
			}
		}
	});
});
