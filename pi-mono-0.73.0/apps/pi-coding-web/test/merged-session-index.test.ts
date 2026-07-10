import type { SessionMetadata } from "@mariozechner/pi-web-ui";
import { describe, expect, it } from "vitest";
import type { BrowserSessionRecord } from "../src/runtime/browser-records.js";
import { mergeBrowserSessionRecords, mergeSessionMetadata } from "../src/storage/merged-session-index.js";

describe("merged session index", () => {
	it("includes sessions that only exist in configured storage", () => {
		const sessions = mergeBrowserSessionRecords([], [], [createMetadata("configured-only", "PI-only session")]);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "configured-only",
			title: "PI-only session",
			preferredSource: "configured",
			messageCount: 2,
		});
	});

	it("omits empty metadata-only sessions from the session list", () => {
		const browserEmpty = createMetadata("browser-empty", "Empty browser session", "2026-06-09T04:00:00.000Z", 0);
		const configuredEmpty = createMetadata(
			"configured-empty",
			"Empty configured session",
			"2026-06-09T05:00:00.000Z",
			0,
		);

		const sessions = mergeBrowserSessionRecords([], [browserEmpty], [configuredEmpty]);

		expect(sessions).toEqual([]);
	});

	it("keeps empty sessions visible when they still have an active run", () => {
		const activeEmpty = {
			...createMetadata("active-empty", "Active empty session", "2026-06-09T04:00:00.000Z", 0),
			activeRunId: "run-1",
			runStatus: "running",
		} as SessionMetadata;

		const sessions = mergeBrowserSessionRecords([], [activeEmpty], []);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "active-empty",
			activeRunId: "run-1",
			runStatus: "running",
		});
	});

	it("preserves configured metadata when runtime state also exists", () => {
		const sessions = mergeBrowserSessionRecords(
			[
				createBrowserSession({
					sessionId: "session-1",
					title: "Runtime title",
					lastRunId: "run-1",
					lastRunStatus: "running",
				}),
			],
			[],
			[createMetadata("session-1", "Configured title")],
		);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			id: "session-1",
			title: "Runtime title",
			messageCount: 2,
			preview: "Configured title preview",
			runStatus: "running",
			activeRunId: "run-1",
			preferredSource: "configured",
		});
	});

	it("prefers newer metadata between browser and configured storage", () => {
		const browser = createMetadata("session-1", "Browser title", "2026-06-09T01:00:00.000Z");
		const configured = createMetadata("session-1", "Configured title", "2026-06-09T02:00:00.000Z");

		const sessions = mergeSessionMetadata([browser], [configured]);

		expect(sessions[0]).toMatchObject({
			id: "session-1",
			title: "Configured title",
			preferredSource: "configured",
		});
	});
});

function createMetadata(
	id: string,
	title: string,
	lastModified = "2026-06-09T00:00:00.000Z",
	messageCount = 2,
): SessionMetadata {
	return {
		id,
		title,
		createdAt: "2026-06-08T00:00:00.000Z",
		lastModified,
		messageCount,
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		thinkingLevel: "high",
		preview: `${title} preview`,
	};
}

function createBrowserSession(overrides: Partial<BrowserSessionRecord> = {}): BrowserSessionRecord {
	return {
		sessionId: "session-1",
		clientId: "550e8400-e29b-41d4-a716-446655440000",
		title: "Runtime title",
		model: {},
		thinkingLevel: "high",
		createdAt: "2026-06-08T00:00:00.000Z",
		updatedAt: "2026-06-09T03:00:00.000Z",
		...overrides,
	};
}
