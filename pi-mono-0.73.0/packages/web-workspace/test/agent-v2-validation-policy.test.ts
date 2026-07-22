import { describe, expect, it } from "vitest";
import { classifyAgentV2ValidationPolicy } from "../src/agent-v2-validation-policy.js";

describe("agent v2 validation policy", () => {
	it("creates stable fingerprints from rule evidence rather than presentation text", () => {
		const first = classifyAgentV2ValidationPolicy({
			code: "static.loading_visible",
			source: "static_quality",
			retryable: true,
			path: ".\\index.html",
			data: { selector: "#loading", sourceMessage: "first wording" },
		});
		const second = classifyAgentV2ValidationPolicy({
			code: "static.loading_visible",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { selector: "#loading", sourceMessage: "changed wording and timestamp 2026-07-17" },
		});

		expect(first.fingerprint).toBe(second.fingerprint);
		expect(first).toMatchObject({
			severity: "warning",
			confidence: 0.55,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});

	it("uses a tighter repair budget for deterministic chart layout findings", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.canvas_layout_unbounded",
			source: "static_quality",
			retryable: true,
			path: "index.html",
			data: { canvasIds: ["sales", "trend"] },
		});

		expect(policy.evidence).toEqual([expect.objectContaining({ kind: "layout", path: "index.html" })]);
		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.95,
			blocking: true,
			repairBudget: { maxAttempts: 2, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("keeps deterministic structural failures authoritative and repairable", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.local_script_missing",
			source: "static_validate",
			retryable: true,
			path: "index.html",
			data: { script: "app.js" },
		});

		expect(policy).toMatchObject({ severity: "error", confidence: 0.99, blocking: true });
		expect(policy.repairBudget.maxAttempts).toBeGreaterThan(0);
	});

	it("allows a missing build manifest repair to create both manifest and lockfile", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.build_manifest_missing",
			source: "static_validate",
			retryable: true,
			path: "package.json",
			data: { sourceEntry: "src/main.tsx" },
		});

		expect(policy).toMatchObject({
			severity: "error",
			confidence: 0.99,
			blocking: true,
			evidence: [expect.objectContaining({ kind: "build", path: "package.json" })],
			repairBudget: { maxAttempts: 3, maxSameFingerprintAttempts: 2, maxChangedFiles: 2 },
		});
	});

	it("keeps synthetic no-effect observations advisory", () => {
		const policy = classifyAgentV2ValidationPolicy({
			code: "static.control_no_effect",
			source: "static_smoke",
			retryable: true,
			path: "index.html",
			data: { selector: "#dateType" },
		});

		expect(policy).toMatchObject({
			severity: "warning",
			confidence: 0.75,
			blocking: false,
			repairBudget: { maxAttempts: 0, maxSameFingerprintAttempts: 0, maxChangedFiles: 0 },
		});
	});
});
