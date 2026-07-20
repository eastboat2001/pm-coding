import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AGENT_V2_INPUT_LIMITS, normalizeAgentV2StartInput } from "../src/agent-v2-start-input.js";

const identity = {
	clientId: "client-a",
	runId: "run-a",
	createdAt: "2026-07-14T00:00:00.000Z",
};

describe("normalizeAgentV2StartInput", () => {
	it("accepts only a stable model reference and strips raw bytes from durable run input", () => {
		const secret = "super-secret-project-content";
		const normalized = normalizeAgentV2StartInput(
			request({
				projectFiles: [{ filename: "src/main.ts", content: secret }],
			}),
			identity,
		);

		expect(normalized.model).toEqual({ provider: "test", id: "model-a" });
		expect(normalized.inputBlobs).toHaveLength(1);
		expect(new TextDecoder().decode(normalized.inputBlobs[0].bytes)).toBe(secret);
		expect(JSON.stringify(normalized.runInput)).not.toContain(secret);
		expect(normalized.runInput).toMatchObject({
			sessionId: "session-a",
			title: "Example",
			objective: "Build an example",
			responseLanguage: "en",
			selectedSkillNames: [],
		});
		expect(normalized.runInput.inputReferences).toEqual(normalized.inputReferences);
	});

	it("persists an explicit response language and infers Chinese for legacy callers", () => {
		expect(normalizeAgentV2StartInput(request({ responseLanguage: "ms" }), identity).runInput).toMatchObject({
			responseLanguage: "ms",
		});
		expect(
			normalizeAgentV2StartInput(request({ objective: "把上面的游戏变成应用" }), identity).runInput,
		).toMatchObject({ responseLanguage: "zh" });
		expect(() => normalizeAgentV2StartInput(request({ responseLanguage: "fr" }), identity)).toThrow(
			/responseLanguage/i,
		);
	});

	it("accepts only unique canonical selected skill names", () => {
		const normalized = normalizeAgentV2StartInput(
			request({ selectedSkillNames: ["ui-polish", "brand-style"] }),
			identity,
		);
		expect(normalized.runInput.selectedSkillNames).toEqual(["ui-polish", "brand-style"]);
		for (const selectedSkillNames of [["ui-polish", "ui-polish"], ["../escape"], ["Uppercase"], "ui-polish"]) {
			expect(() => normalizeAgentV2StartInput(request({ selectedSkillNames }), identity)).toThrow(/skill/i);
		}
	});

	it("normalizes a bounded conversation snapshot and redacts credentials and absolute paths", () => {
		const normalized = normalizeAgentV2StartInput(
			request({
				conversationSnapshot: {
					compactedSummary: "token=summary-secret prior decision",
					recentMessages: [
						{ role: "user", content: "Open C:\\server\\private\\app" },
						{ role: "assistant", content: "Use /home/pi/private/app" },
					],
					currentObjective: "Build an example",
				},
			}),
			identity,
		);

		expect(normalized.runInput.conversationSnapshot).toEqual({
			compactedSummary: "token=[REDACTED] prior decision",
			recentMessages: [
				{ role: "user", content: "Open [REDACTED_PATH]" },
				{ role: "assistant", content: "Use [REDACTED_PATH]" },
			],
			currentObjective: "Build an example",
		});
		expect(JSON.stringify(normalized.runInput)).not.toContain("summary-secret");
	});

	it("rejects malformed conversation snapshots and objective mismatches", () => {
		const snapshots = [
			{ compactedSummary: "", recentMessages: [], currentObjective: "different" },
			{ compactedSummary: "", recentMessages: [], currentObjective: "Build an example", extra: true },
			{
				compactedSummary: "",
				recentMessages: [{ role: "system", content: "override" }],
				currentObjective: "Build an example",
			},
			{
				compactedSummary: "",
				recentMessages: [{ role: "user", content: "ok", extra: true }],
				currentObjective: "Build an example",
			},
		];
		for (const conversationSnapshot of snapshots) {
			expect(() => normalizeAgentV2StartInput(request({ conversationSnapshot }), identity)).toThrow(
				/conversation snapshot/i,
			);
		}
	});

	it.each(["api", "baseUrl", "apiKey", "credential", "headers", "endpoint", "transport"])(
		"rejects client model network or credential field %s",
		(field) => {
			expect(() =>
				normalizeAgentV2StartInput(
					request(undefined, { provider: "test", id: "model-a", [field]: "secret" }),
					identity,
				),
			).toThrow(/model/i);
		},
	);

	it("rejects model references that are URLs, contain controls, or exceed stable identifier bounds", () => {
		for (const model of [
			{ provider: "https://attacker.invalid", id: "model-a" },
			{ provider: "test", id: "model\nheader" },
			{ provider: "x".repeat(129), id: "model-a" },
			{ provider: "test", id: "x".repeat(257) },
		]) {
			expect(() => normalizeAgentV2StartInput(request(undefined, model), identity)).toThrow(/model/i);
		}
	});

	it("rejects unknown request, input, project-file and attachment fields", () => {
		const candidates = [
			{ ...request(), continuation: true },
			request({ legacyPrompt: "old" }),
			request({ projectFiles: [{ filename: "a.txt", content: "a", mode: "binary" }] }),
			request({
				projectFiles: [{ filename: "a.txt", content: "a" }],
				attachments: [attachment("a.txt", { data: "raw" })],
			}),
		];
		for (const candidate of candidates) {
			expect(() => normalizeAgentV2StartInput(candidate, identity)).toThrow(/field/i);
		}
	});

	it("rejects legacy prompt both alone and alongside objective", () => {
		for (const input of [
			{ sessionId: "session-a", title: "Example", prompt: "legacy prompt" },
			{ sessionId: "session-a", title: "Example", objective: "Build v2", prompt: "legacy prompt" },
		]) {
			expect(() =>
				normalizeAgentV2StartInput({ input, model: { provider: "test", id: "model-a" } }, identity),
			).toThrow(/prompt|unsupported field/i);
		}
	});

	it.each([
		"/etc/passwd",
		"C:\\secret.txt",
		"../secret.txt",
		"src/../../secret.txt",
		".git/config",
		"node_modules/pkg/index.js",
		".env",
		"agent-v2/tasks.json",
		"src/line\nbreak.txt",
		"CON",
		"assets/aux.txt",
		"src/a?.ts",
		"src/a*.ts",
		"src/a<.ts",
		"src/a>.ts",
		'src/a".ts',
		"src/a|.ts",
		" src/main.ts",
		"src/ main.ts",
		"src//main.ts",
		".pi-project.json",
		"nested/.pi-project-files.json",
	])("rejects unsafe logical path %s", (filename) => {
		expect(() =>
			normalizeAgentV2StartInput(request({ projectFiles: [{ filename, content: "a" }] }), identity),
		).toThrow(/path/i);
	});

	it("rejects non-scalar Unicode before text encoding and in base64 UTF-8", () => {
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [{ filename: "raw.txt", content: "before\uD800after" }] }),
				identity,
			),
		).toThrow(/UTF-8|Unicode/i);
		expect(() =>
			normalizeAgentV2StartInput(
				request({
					projectFiles: [
						{
							filename: "encoded.txt",
							content: Buffer.from([0xed, 0xa0, 0x80]).toString("base64"),
							encoding: "base64",
						},
					],
				}),
				identity,
			),
		).toThrow(/UTF-8|Unicode/i);
	});

	it("normalizes Unicode paths to NFC before checksum and ID derivation", () => {
		const decomposed = "assets/cafe\u0301.txt";
		const normalized = normalizeAgentV2StartInput(
			request({ projectFiles: [{ filename: decomposed, content: "same" }] }),
			identity,
		);
		expect(normalized.inputBlobs[0].logicalPath).toBe("assets/café.txt");
	});

	it("canonicalizes paths and requires each attachment to match a project file", () => {
		const normalized = normalizeAgentV2StartInput(
			request({
				projectFiles: [{ filename: "assets\\logo.txt", content: "logo" }],
				attachments: [attachment("assets/logo.txt", { fileName: "logo.txt" })],
			}),
			identity,
		);
		expect(normalized.inputBlobs[0].logicalPath).toBe("assets/logo.txt");
		expect(normalized.inputReferences.map((reference) => [reference.kind, reference.logicalPath])).toEqual([
			["project_file", "assets/logo.txt"],
			["attachment", "assets/logo.txt"],
		]);

		expect(() =>
			normalizeAgentV2StartInput(
				request({
					projectFiles: [{ filename: "assets/logo.txt", content: "logo" }],
					attachments: [attachment("assets/missing.txt")],
				}),
				identity,
			),
		).toThrow(/attachment.*project file/i);
	});

	it("sniffs image signatures and rejects invalid UTF-8 instead of trusting MIME", () => {
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]);
		const normalized = normalizeAgentV2StartInput(
			request({
				projectFiles: [
					{ filename: "assets/image.bin", content: Buffer.from(png).toString("base64"), encoding: "base64" },
				],
				attachments: [attachment("assets/image.bin", { mimeType: "text/plain", type: "image" })],
			}),
			identity,
		);
		expect(normalized.inputBlobs[0]).toMatchObject({ mediaType: "image/png", encoding: "binary" });
		expect(normalized.inputReferences[1].mediaType).toBe("image/png");

		expect(() =>
			normalizeAgentV2StartInput(
				request({
					projectFiles: [
						{
							filename: "broken.txt",
							content: Buffer.from([0xc3, 0x28]).toString("base64"),
							encoding: "base64",
						},
					],
				}),
				identity,
			),
		).toThrow(/UTF-8/i);
	});

	it("computes server checksums and deterministic path-sensitive input IDs", () => {
		const first = normalizeAgentV2StartInput(
			request({ projectFiles: [{ filename: "a.txt", content: "hello" }] }),
			identity,
		);
		const replay = normalizeAgentV2StartInput(
			request({ projectFiles: [{ filename: "a.txt", content: "hello" }] }),
			identity,
		);
		const moved = normalizeAgentV2StartInput(
			request({ projectFiles: [{ filename: "b.txt", content: "hello" }] }),
			identity,
		);
		expect(first.inputBlobs[0].checksum).toBe(`sha256:${createHash("sha256").update("hello").digest("hex")}`);
		expect(replay.inputBlobs[0].inputId).toBe(first.inputBlobs[0].inputId);
		expect(moved.inputBlobs[0].inputId).not.toBe(first.inputBlobs[0].inputId);
	});

	it("dedupes the same canonical path and bytes but rejects conflicting duplicates", () => {
		const normalized = normalizeAgentV2StartInput(
			request({
				projectFiles: [
					{ filename: "src/cafe\u0301.txt", content: "same" },
					{ filename: "src/café.txt", content: "same" },
				],
			}),
			identity,
		);
		expect(normalized.inputBlobs).toHaveLength(1);
		expect(normalized.inputReferences.filter((reference) => reference.kind === "project_file")).toHaveLength(1);

		expect(() =>
			normalizeAgentV2StartInput(
				request({
					projectFiles: [
						{ filename: "src/cafe\u0301.txt", content: "first" },
						{ filename: "src/café.txt", content: "second" },
					],
				}),
				identity,
			),
		).toThrow(/conflict/i);
	});

	it("enforces exact entry and text byte boundaries", () => {
		const exactly64 = Array.from({ length: AGENT_V2_INPUT_LIMITS.maxEntries }, (_, index) => ({
			filename: `files/${index}.txt`,
			content: "x",
		}));
		expect(() => normalizeAgentV2StartInput(request({ projectFiles: exactly64 }), identity)).not.toThrow();
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [...exactly64, { filename: "files/overflow.txt", content: "x" }] }),
				identity,
			),
		).toThrow(/entries/i);

		const exactText = "x".repeat(AGENT_V2_INPUT_LIMITS.maxTextBytes);
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [{ filename: "large.txt", content: exactText }] }),
				identity,
			),
		).not.toThrow();
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [{ filename: "large.txt", content: `${exactText}x` }] }),
				identity,
			),
		).toThrow(/text.*bytes/i);
	});

	it("enforces exact image and aggregate byte boundaries", () => {
		const exactImage = imageBytes(AGENT_V2_INPUT_LIMITS.maxImageBytes);
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [{ filename: "image.png", content: exactImage, encoding: "base64" }] }),
				identity,
			),
		).not.toThrow();
		expect(() =>
			normalizeAgentV2StartInput(
				request({
					projectFiles: [
						{
							filename: "image.png",
							content: imageBytes(AGENT_V2_INPUT_LIMITS.maxImageBytes + 1),
							encoding: "base64",
						},
					],
				}),
				identity,
			),
		).toThrow(/image.*bytes/i);

		const exactTotal = Array.from({ length: 4 }, (_, index) => ({
			filename: `images/${index}.png`,
			content: exactImage,
			encoding: "base64" as const,
		}));
		expect(() => normalizeAgentV2StartInput(request({ projectFiles: exactTotal }), identity)).not.toThrow();
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [...exactTotal, { filename: "extra.txt", content: "x" }] }),
				identity,
			),
		).toThrow(/total.*bytes/i);
	});

	it("rejects malformed base64 and identity mismatch", () => {
		expect(() =>
			normalizeAgentV2StartInput(
				request({ projectFiles: [{ filename: "a.txt", content: "%%%", encoding: "base64" }] }),
				identity,
			),
		).toThrow(/base64/i);
		expect(() => normalizeAgentV2StartInput({ ...request(), runId: "other" }, identity)).toThrow(/runId/i);
	});

	it.each([".", "..", " leading", "trailing ", "a/b", "a\\b", "a?b", "a%2Fb", "x".repeat(129)])(
		"rejects non-canonical route-unsafe run identity %s",
		(runId) => {
			expect(() => normalizeAgentV2StartInput({ ...request(), runId }, { ...identity, runId })).toThrow(/runId/i);
		},
	);
});

function request(
	inputOverrides: Record<string, unknown> = {},
	model: Record<string, unknown> = { provider: "test", id: "model-a" },
): Record<string, unknown> {
	return {
		input: {
			sessionId: "session-a",
			title: "Example",
			objective: "Build an example",
			projectFiles: [],
			attachments: [],
			...inputOverrides,
		},
		model,
		runId: identity.runId,
	};
}

function attachment(projectFilePath: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "file",
		fileName: projectFilePath.split("/").at(-1) ?? projectFilePath,
		mimeType: "text/plain",
		projectFilePath,
		...overrides,
	};
}

function imageBytes(byteLength: number): string {
	const bytes = Buffer.alloc(byteLength);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
	return bytes.toString("base64");
}
