import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type { AgentV2DiagnosticExportStore } from "../src/agent-v2-runtime-store.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot } from "../src/agent-v2-types.js";
import { loadStorageConfig } from "../src/config.js";
import { WorkspaceDiagnosticExportService } from "../src/diagnostic-export-service.js";
import { WorkspaceDiagnosticLogService } from "../src/diagnostic-log-service.js";
import { RuntimeDbStore } from "../src/runtime-db.js";
import { WorkspaceSessionService } from "../src/workspace-session-service.js";

describe("WorkspaceDiagnosticExportService", () => {
	let diagnostics: WorkspaceDiagnosticLogService;
	let dir: string;
	let runtimeDb: RuntimeDbStore;
	let sessions: WorkspaceSessionService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-diagnostic-export-"));
		const config = { ...loadStorageConfig(dir), logStdoutEnabled: false };
		runtimeDb = new RuntimeDbStore(config.runtimeDbFile);
		runtimeDb.ensureAgentV2Schema();
		diagnostics = new WorkspaceDiagnosticLogService(config);
		sessions = new WorkspaceSessionService(config);
		sessions.ensureDirs();
	});

	afterEach(() => {
		diagnostics.close();
		runtimeDb.close();
		rmSync(dir, { force: true, recursive: true });
	});

	it("exports runtime and diagnostic data for a session without extra export-layer redaction", async () => {
		sessions.writeSettings(
			{
				providerKeys: { "custom-provider:test": "server-key" },
				customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
			},
			"client-a",
		);
		runtimeDb.createAgentV2Run({
			clientId: "client-a",
			runId: "run-1",
			input: { sessionId: "session-1", title: "Token limit repro", prompt: "count forever" },
			model: { id: "mimo-v2.5", provider: "custom-provider:test", maxTokens: 512 },
			createdAt: "2026-06-12T00:00:02.000Z",
		});
		runtimeDb.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-1",
			type: "message_end",
			payload: { message: { stopReason: "length", usage: { output: 512 } } },
			createdAt: "2026-06-12T00:00:03.000Z",
		});
		diagnostics.writeEvents({
			events: [
				{
					clientId: "client-a",
					sessionId: "session-1",
					category: "provider",
					eventType: "provider.payload",
					provider: "custom-provider:test",
					model: "mimo-v2.5",
					data: { max_completion_tokens: 512 },
				},
				{
					clientId: "client-a",
					sessionId: "session-1",
					category: "model",
					eventType: "model.stream.summary",
					data: { stopReason: "length", textDeltaCount: 600 },
				},
			],
		});

		const service = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
		const exported = await service.export({ clientId: "client-a", sessionId: "session-1" });

		expect(exported.query).toMatchObject({ clientId: "client-a", sessionId: "session-1" });
		expect(exported.runtime).toMatchObject({
			session: null,
			messages: [],
			runs: [{ runId: "run-1", input: { sessionId: "session-1", prompt: "count forever" } }],
		});
		expect(exported.runtime.runEventsByRunId).toMatchObject({
			"run-1": [{ type: "message_end", payload: { message: { stopReason: "length", usage: { output: 512 } } } }],
		});
		expect(exported.runtime.agentV2DiagnosticsByRunId).toMatchObject({ "run-1": [] });
		expect(exported.diagnostics).toMatchObject({
			total: 2,
			exported: 2,
			truncated: false,
			events: [
				{ eventType: "provider.payload", data: { max_completion_tokens: 512 } },
				{ eventType: "model.stream.summary", data: { stopReason: "length", textDeltaCount: 600 } },
			],
		});
		expect(exported.settings).toMatchObject({
			providerKeys: { "custom-provider:test": "server-key" },
			customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
		});
	});

	it("exports a browser metadata session without reading legacy runtime tables", async () => {
		const store = createV2OnlyRuntimeStore();
		const service = new WorkspaceDiagnosticExportService(store, diagnostics, sessions);

		const exported = await service.export({
			clientId: "client-a",
			sessionId: "browser-session",
			includeSettings: false,
		});
		const archive = await service.exportArchive({
			clientId: "client-a",
			sessionId: "browser-session",
			includeSettings: false,
		});
		const files = await collectArchiveFiles(archive.entries);

		expect(exported.query).toMatchObject({ clientId: "client-a", sessionId: "browser-session" });
		expect(exported.runtime).toMatchObject({
			session: null,
			messages: [],
			runs: [],
			runEventsByRunId: {},
			agentV2DiagnosticsByRunId: {},
		});
		expect(JSON.parse(files["runtime/session.json"])).toBe(null);
		expect(files["runtime/messages.ndjson"]).toBe("");
		expect(JSON.parse(files["runtime/runs.json"])).toEqual([]);
	});

	it("exports v2 runs, events, and diagnostics by run id without legacy session lookups", async () => {
		const run = createAgentV2Run({ runId: "run-v2", sessionId: "browser-session" });
		const event: AgentV2RunEventRecord = {
			clientId: "client-a",
			runId: "run-v2",
			seq: 1,
			type: "agent_v2.phase_changed",
			payload: { type: "agent_v2.phase_changed", phase: "validation", status: "running" },
			createdAt: "2026-07-08T00:00:01.000Z",
		};
		const diagnostic: AgentV2DiagnosticEvent = {
			clientId: "client-a",
			runId: "run-v2",
			diagnosticId: "diag-v2",
			severity: "warn",
			category: "validation",
			code: "schema_check_failed",
			phase: "validation",
			message: "Schema check failed",
			data: { path: "manifest.blocks[0]" },
			createdAt: "2026-07-08T00:00:02.000Z",
		};
		const store = createV2OnlyRuntimeStore({
			runs: [run],
			runEventsByRunId: { "run-v2": [event] },
			diagnosticsByRunId: { "run-v2": [diagnostic] },
		});
		const service = new WorkspaceDiagnosticExportService(store, diagnostics, sessions);

		const exported = await service.export({
			clientId: "client-a",
			runId: "run-v2",
			includeSettings: false,
		});
		const archive = await service.exportArchive({
			clientId: "client-a",
			runId: "run-v2",
			includeSettings: false,
		});
		const files = await collectArchiveFiles(archive.entries);

		expect(exported.query).toMatchObject({
			clientId: "client-a",
			sessionId: "browser-session",
			runId: "run-v2",
		});
		expect(exported.runtime).toMatchObject({
			session: null,
			messages: [],
			runs: [{ runId: "run-v2", input: { sessionId: "browser-session" } }],
			runEventsByRunId: { "run-v2": [event] },
			agentV2DiagnosticsByRunId: { "run-v2": [diagnostic] },
		});
		expect(JSON.stringify(JSON.parse(files["manifest.json"]))).toContain('"runId":"run-v2"');
		expect(files["runtime/session.json"].trim()).toBe("null");
		expect(files["runtime/messages.ndjson"]).toBe("");
		expect(files["runtime/run-events/run-v2.events.ndjson"]).toContain("agent_v2.phase_changed");
		expect(files["agent-v2/diagnostics/run-v2.diagnostics.ndjson"]).toContain("schema_check_failed");
		expect(files["agent-v2/diagnostics/run-v2.diagnostics.ndjson"]).toContain("diag-v2");
		expect(JSON.parse(files["diagnostics/overview.json"])).toMatchObject({
			session: null,
			counts: {
				messages: 0,
				runs: 1,
				runtimeRunEvents: 1,
				agentV2Diagnostics: 1,
			},
			runs: [
				{ runId: "run-v2", phase: "intake", eventCount: 1, agentV2DiagnosticCodes: { schema_check_failed: 1 } },
			],
		});
	});

	it("exports a multi-file archive manifest with runtime events and full settings", async () => {
		sessions.writeSettings(
			{
				providerKeys: { "custom-provider:test": "server-key" },
				customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
			},
			"client-a",
		);
		runtimeDb.createAgentV2Run({
			clientId: "client-a",
			runId: "run-1",
			input: { sessionId: "session-1", title: "Runaway thinking repro", prompt: "make a dashboard" },
			model: { id: "mimo-v2.5", provider: "custom-provider:test", maxTokens: 512 },
			createdAt: "2026-06-12T00:00:02.000Z",
		});
		for (let index = 0; index < 25; index += 1) {
			runtimeDb.appendAgentV2RunEvent({
				clientId: "client-a",
				runId: "run-1",
				type: "message_update",
				payload: { type: "message_update", delta: `thinking chunk ${index}` },
				createdAt: `2026-06-12T00:00:${String(index + 3).padStart(2, "0")}.000Z`,
			});
		}
		runtimeDb.appendAgentV2RunEvent({
			clientId: "client-a",
			runId: "run-1",
			type: "message_end",
			payload: { type: "message_end", message: { stopReason: "length", usage: { output: 512 } } },
			createdAt: "2026-06-12T00:00:40.000Z",
		});
		diagnostics.writeEvents({
			events: [
				{
					clientId: "client-a",
					sessionId: "session-1",
					category: "model",
					eventType: "model.stream.summary",
					data: { stopReason: "length", thinkingDeltaCount: 25 },
				},
			],
		});

		const service = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
		const archive = await service.exportArchive({ clientId: "client-a", sessionId: "session-1" });
		const files = await collectArchiveFiles(archive.entries);
		const zipBuffer = Buffer.concat(await collectArchiveChunks(archive.stream()));

		expect(archive.filename).toMatch(/^pi-diagnostics-session-1-.*\.zip$/);
		expect(zipBuffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
		expect(zipBuffer.includes(Buffer.from("manifest.json"))).toBe(true);
		expect(zipBuffer.includes(Buffer.from("runtime/run-events/run-1.events.ndjson"))).toBe(true);
		expect(Object.keys(files).sort()).toEqual([
			"agent-v2/diagnostics/run-1.diagnostics.ndjson",
			"agent-v2/diagnostics/run-1.summary.json",
			"diagnostics/events.ndjson",
			"diagnostics/global-events.ndjson",
			"diagnostics/overview.json",
			"diagnostics/session-events.ndjson",
			"diagnostics/status.json",
			"diagnostics/timeline.ndjson",
			"manifest.json",
			"runtime/messages.ndjson",
			"runtime/run-events/run-1.events.ndjson",
			"runtime/run-events/run-1.summary.json",
			"runtime/runs.json",
			"runtime/session.json",
			"settings/settings.json",
		]);
		const manifest = JSON.parse(files["manifest.json"]);
		expect(manifest).toMatchObject({
			format: "pi-diagnostic-archive",
			query: { clientId: "client-a", sessionId: "session-1" },
		});
		expect(manifest.files).toContainEqual({
			path: "runtime/run-events/run-1.events.ndjson",
			kind: "agent-v2-run-events",
		});
		expect(JSON.parse(files["runtime/session.json"])).toBe(null);
		expect(files["runtime/messages.ndjson"]).toBe("");
		expect(files["runtime/run-events/run-1.events.ndjson"].trim().split("\n")).toHaveLength(26);
		expect(JSON.parse(files["runtime/run-events/run-1.summary.json"])).toMatchObject({
			runId: "run-1",
			totalEvents: 26,
			eventTypes: { message_update: 25, message_end: 1 },
		});
		expect(JSON.parse(files["agent-v2/diagnostics/run-1.summary.json"])).toMatchObject({
			runId: "run-1",
			totalDiagnostics: 0,
		});
		expect(files["diagnostics/events.ndjson"]).toContain("model.stream.summary");
		expect(files["diagnostics/session-events.ndjson"]).toContain("model.stream.summary");
		expect(files["diagnostics/timeline.ndjson"]).toContain("agent_v2.run_event");
		expect(JSON.parse(files["diagnostics/overview.json"])).toMatchObject({
			session: null,
			counts: { messages: 0, runs: 1 },
			runs: [{ runId: "run-1", eventCount: 26 }],
		});
		expect(JSON.parse(files["settings/settings.json"])).toMatchObject({
			providerKeys: { "custom-provider:test": "server-key" },
			customProviders: [{ id: "test", name: "test", apiKey: "provider-key" }],
		});
	});

	it("exports global diagnostics, timeline, and findings for a queued run with no worker progress", async () => {
		runtimeDb.createAgentV2Run({
			clientId: "client-a",
			runId: "run-queued",
			input: { sessionId: "session-queued", title: "你好你好", prompt: "你好你好" },
			model: { id: "ATS_MAX", provider: "custom-provider:ats" },
			createdAt: "2026-06-23T07:50:36.545Z",
		});
		runtimeDb.updateAgentV2Run({
			clientId: "client-a",
			runId: "run-queued",
			status: "cancelled",
			phase: "cancelled",
			endedAt: "2026-06-23T07:51:16.782Z",
			updatedAt: "2026-06-23T07:51:16.782Z",
		});
		diagnostics.writeEvents({
			events: [
				{
					timestamp: "2026-01-01T00:00:00.000Z",
					level: "error",
					category: "system",
					eventType: "worker.queue.claim.error",
					data: { queue: "pi:runs", message: "old redis outage" },
				},
				{
					timestamp: "2026-06-23T07:50:35.000Z",
					level: "info",
					category: "system",
					eventType: "system.worker.starting",
					data: { workerId: "pi-worker-1" },
				},
				{
					timestamp: "2026-06-23T07:50:38.000Z",
					level: "info",
					category: "system",
					eventType: "system.worker.starting",
					data: { workerId: "pi-worker-1" },
				},
				{
					timestamp: "2026-06-23T07:50:41.000Z",
					level: "info",
					category: "system",
					eventType: "system.worker.starting",
					data: { workerId: "pi-worker-1" },
				},
				{
					timestamp: "2026-06-23T07:50:45.000Z",
					level: "error",
					category: "system",
					eventType: "worker.queue.claim.error",
					data: { queue: "pi:runs", message: "connect ECONNREFUSED 127.0.0.1:6379" },
				},
				{
					timestamp: "2026-06-23T07:50:45.500Z",
					level: "info",
					category: "system",
					eventType: "system.worker.recovered_active_runs",
					data: { workerId: "pi-worker-1", recoveredCount: 2 },
				},
				{
					timestamp: "2026-06-23T07:50:46.000Z",
					clientId: "client-a",
					sessionId: "session-queued",
					level: "info",
					category: "agent",
					eventType: "agent.run.enqueued",
					data: {
						clientId: "client-a",
						sessionId: "session-queued",
						runId: "run-queued",
						status: "queued",
					},
				},
				{
					timestamp: "2026-06-23T07:50:46.641Z",
					clientId: "client-a",
					sessionId: "session-queued",
					level: "error",
					category: "agent",
					eventType: "agent.remote_run.queued_timeout",
					data: {
						runId: "run-queued",
						status: "queued",
						queuedMs: 10237,
						message: "Run stayed queued without worker progress; PI worker or Redis may not be running.",
					},
				},
			],
		});

		const service = new WorkspaceDiagnosticExportService(runtimeDb, diagnostics, sessions);
		const archive = await service.exportArchive({ clientId: "client-a", sessionId: "session-queued" });
		const files = await collectArchiveFiles(archive.entries);
		const overview = JSON.parse(files["diagnostics/overview.json"]);

		expect(files["diagnostics/session-events.ndjson"]).toContain("agent.remote_run.queued_timeout");
		expect(files["diagnostics/global-events.ndjson"]).toContain("worker.queue.claim.error");
		expect(files["diagnostics/global-events.ndjson"]).not.toContain("old redis outage");
		expect(files["diagnostics/timeline.ndjson"]).toContain("agent_v2.run");
		expect(files["diagnostics/timeline.ndjson"]).toContain("agent.remote_run.queued_timeout");
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "run_queued_timeout", severity: "error" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "run_never_started", severity: "error" }),
		);
		expect(overview.findings).toContainEqual(expect.objectContaining({ code: "run_has_no_events" }));
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "model_request_not_observed", severity: "warn" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "worker_queue_error", severity: "error" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "worker_start_not_confirmed", severity: "warn" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "worker_repeated_starting", severity: "warn" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "worker_recovered_active_claims", severity: "warn" }),
		);
		expect(overview.findings).toContainEqual(
			expect.objectContaining({ code: "run_enqueued_but_not_claimed", severity: "error" }),
		);
		expect(overview.runs).toEqual([
			expect.objectContaining({
				runId: "run-queued",
				status: "cancelled",
				eventCount: 0,
				workerId: null,
			}),
		]);
	});
});

async function collectArchiveFiles(
	entries: Array<{ path: string; chunks(): Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array> }>,
): Promise<Record<string, string>> {
	const decoder = new TextDecoder();
	const files: Record<string, string> = {};
	for (const entry of entries) {
		let content = "";
		for await (const chunk of entry.chunks()) {
			content += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
		}
		content += decoder.decode();
		files[entry.path] = content;
	}
	return files;
}

async function collectArchiveChunks(chunks: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
	const buffers: Buffer[] = [];
	for await (const chunk of chunks) {
		buffers.push(Buffer.from(chunk));
	}
	return buffers;
}

function createAgentV2Run(input: { runId: string; sessionId: string }): AgentV2RunSnapshot {
	return {
		clientId: "client-a",
		runId: input.runId,
		status: "running",
		phase: "intake",
		attempt: 1,
		input: {
			sessionId: input.sessionId,
			title: "Browser session",
			prompt: "Build a v2 app",
		},
		model: { provider: "test", id: "v2-model" },
		workerId: "worker-v2",
		createdAt: "2026-07-08T00:00:00.000Z",
		updatedAt: "2026-07-08T00:00:03.000Z",
		startedAt: "2026-07-08T00:00:01.000Z",
	};
}

function createV2OnlyRuntimeStore(
	options: {
		runs?: AgentV2RunSnapshot[];
		runEventsByRunId?: Record<string, AgentV2RunEventRecord[]>;
		diagnosticsByRunId?: Record<string, AgentV2DiagnosticEvent[]>;
	} = {},
): AgentV2DiagnosticExportStore {
	const runs = options.runs ?? [];
	const runEventsByRunId = options.runEventsByRunId ?? {};
	const diagnosticsByRunId = options.diagnosticsByRunId ?? {};
	return {
		getAgentV2Run: (_clientId: string, runId: string) => runs.find((run) => run.runId === runId),
		listAgentV2Runs: () => runs,
		listAgentV2RunEvents: (_clientId: string, runId: string, afterSeq: number) =>
			(runEventsByRunId[runId] ?? []).filter((event) => event.seq > afterSeq),
		listAgentV2Diagnostics: (_clientId: string, runId: string) => diagnosticsByRunId[runId] ?? [],
	};
}
