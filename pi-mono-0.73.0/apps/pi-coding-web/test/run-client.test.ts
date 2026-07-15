import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as runClient from "../src/runtime/run-client.js";

const { buildRunRequestHeaders } = runClient;

describe("run client", () => {
	const clientId = "550e8400-e29b-41d4-a716-446655440000";

	beforeEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal("window", { localStorage: createStorage(clientId), location: { origin: "http://localhost:5173" } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("preserves lowercase content-type and normalizes tuple-array headers", () => {
		const headers = buildRunRequestHeaders(
			[
				["content-type", "application/merge-patch+json"],
				["X-Test", "1"],
			],
			true,
		);

		expect(headers).toEqual({
			"content-type": "application/merge-patch+json",
			"x-test": "1",
			"X-PI-Client-ID": clientId,
		});
	});

	it("no longer exposes legacy generation run helpers", () => {
		expect(runClient).not.toHaveProperty("startRun");
		expect(runClient).not.toHaveProperty("cancelRun");
		expect(runClient).not.toHaveProperty("listRunEvents");
		expect(runClient).not.toHaveProperty("connectRunEvents");
		expect(runClient).not.toHaveProperty("getSession");
		expect(runClient).not.toHaveProperty("listSessions");
		expect(runClient).not.toHaveProperty("renameSession");
		expect(runClient).not.toHaveProperty("deleteSession");
		expect(runClient).not.toHaveProperty("buildAppPreviewGoalStartRequest");
		expect(runClient).not.toHaveProperty("getAppPreviewGoal");
		expect(runClient).not.toHaveProperty("enableAppPreviewGoal");
		expect(runClient).not.toHaveProperty("disableAppPreviewGoal");
	});

	it("does not keep legacy app preview goal browser helpers or routes", () => {
		const source = readFileSync(join(import.meta.dirname, "../src/runtime/run-client.ts"), "utf8");
		const forbidden = [
			"RuntimeSessionDetail",
			"RuntimeSessionListResult",
			"getSession(",
			"listSessions(",
			"AppPreviewGoalRecord",
			"AppPreviewGoalEventRecord",
			"AppPreviewGoalSource",
			"getAppPreviewGoal",
			"enableAppPreviewGoal",
			"disableAppPreviewGoal",
			"/goals/app-preview",
			"/api/pi-sessions",
		];

		for (const entry of forbidden) {
			expect(source, `run-client.ts must not reference ${entry}`).not.toContain(entry);
		}
	});

	it("uses v2 getRun rather than legacy session detail for active-run status settling", () => {
		const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");
		const syncStart = bootstrapSource.indexOf("const syncCurrentRunStatusFromServer");
		const syncEnd = bootstrapSource.indexOf("function reportQueuedRunTimeoutIfNeeded");
		const syncSource = bootstrapSource.slice(syncStart, syncEnd);

		expect(bootstrapSource).toContain("getRun: async (runId: string) =>");
		expect(bootstrapSource).toContain("agentV2BrowserController.apply(event);");
		expect(bootstrapSource).not.toContain("isAgentV2LifecycleRunEvent");
		expect(syncSource).toContain("const run = await runClient.getRun(runId);");
		expect(syncSource).not.toContain("const detail = await runClient.getSession(currentSessionId);");
		expect(syncSource).not.toContain("const run = detail.runs.find((candidate) => candidate.runId === runId);");
		expect(bootstrapSource).not.toContain("tryDrainRemoteRunEvents");
		expect(bootstrapSource).toContain("controller.hydrate(events, controller.lastSeq);");
	});

	it("restores sessions from local storage and v2 run APIs instead of the legacy session detail API", () => {
		const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");
		const loadSessionStart = bootstrapSource.indexOf("const loadSession = async");
		const loadSessionEnd = bootstrapSource.indexOf("const startFreshSession = async");
		const loadSessionSource = bootstrapSource.slice(loadSessionStart, loadSessionEnd);

		expect(loadSessionSource).toContain("const sessionData = await storage.sessions.get(sessionId);");
		expect(loadSessionSource).toContain("const sessionMetadata = (await storage.sessions.getMetadata(sessionId))");
		expect(bootstrapSource).toContain("getAgentV2Run(activeRunId)");
		expect(bootstrapSource).toContain("listAgentV2RunEvents(activeRunId, 0)");
		expect(loadSessionSource).not.toContain("await runClient.getSession(sessionId)");
		expect(bootstrapSource).not.toContain("runClient.getSession");
		expect(bootstrapSource).not.toContain("runClient.listSessions");
	});

	it("does not keep legacy spec artifact orchestration in bootstrap", () => {
		const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");
		const forbidden = [
			"spec-artifact",
			"currentSpecArtifact",
			"writeSpecArtifactDiagnostic",
			"buildSpecArtifact",
			"SPEC_ARTIFACT_PROJECT_FILES",
			"PI_APP_AGENT_VERSION",
			"legacy-v1-main",
			"createRunAgent",
		];

		for (const entry of forbidden) {
			expect(bootstrapSource, `bootstrap.ts must not reference ${entry}`).not.toContain(entry);
		}
	});

	it("keeps generated app rename/delete on browser session storage instead of legacy runtime sessions", () => {
		const bootstrapSource = readFileSync(join(import.meta.dirname, "../src/app/bootstrap.ts"), "utf8");
		const renameStart = bootstrapSource.indexOf("const renameSessionProject = async");
		const renameEnd = bootstrapSource.indexOf("const deleteSessionEverywhere = async");
		const deleteEnd = bootstrapSource.indexOf("const handleAgentEvent = async");
		const renameSource = bootstrapSource.slice(renameStart, renameEnd);
		const deleteSource = bootstrapSource.slice(renameEnd, deleteEnd);

		expect(bootstrapSource).not.toContain("renameRuntimeSession");
		expect(bootstrapSource).not.toContain("deleteRuntimeSession");
		expect(renameSource).toContain("await storage.sessions.updateTitle(sessionId, title);");
		expect(deleteSource).toContain("await storage.sessions.deleteSession(sessionId);");
		expect(renameSource).not.toContain("/api/pi-sessions");
		expect(deleteSource).not.toContain("/api/pi-sessions");
	});
});

function createStorage(clientId: string): Storage {
	const values = new Map<string, string>([["pi.clientId", clientId]]);
	return {
		get length() {
			return values.size;
		},
		clear() {
			values.clear();
		},
		getItem(key) {
			return values.get(key) ?? null;
		},
		key(index) {
			return Array.from(values.keys())[index] ?? null;
		},
		removeItem(key) {
			values.delete(key);
		},
		setItem(key, value) {
			values.set(key, value);
		},
	};
}
