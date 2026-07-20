import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentV2RunApiService, type AgentV2StartRunRequest } from "../src/agent-v2-run-api-service.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";
import { RuntimeDbStore } from "../src/runtime-db.js";

const roots: string[] = [];
const stores: RuntimeDbStore[] = [];
const storeFiles = new WeakMap<RuntimeDbStore, string>();
const CREATED_AT = "2026-07-14T01:00:00.000Z";

describe("AgentV2RunApiService", () => {
	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
	});

	it("atomically commits normalized inputs, complete planning, seq 1/2 events and outbox before wake", async () => {
		const store = createStore();
		const wakeSnapshots: Array<Record<string, number>> = [];
		const service = createService(store, {
			wakeDispatcher: () => {
				wakeSnapshots.push({
					runs: store.listAgentV2Runs("client-a").length,
					documents: store.listAgentV2Documents("client-a", "run-start").length,
					tasks: store.listAgentV2Tasks("client-a", "run-start").length,
					artifacts: store.listAgentV2Artifacts("client-a", "run-start").length,
					references: store.listAgentV2InputReferences("client-a", "run-start").length,
					events: store.listAgentV2RunEvents("client-a", "run-start", 0).length,
				});
			},
		});

		const run = await service.startRun("client-a", startRequest("run-start"));

		expect(run).toMatchObject({
			clientId: "client-a",
			runId: "run-start",
			status: "queued",
			phase: "implementation",
			model: { provider: "test", id: "model-a" },
		});
		expect(JSON.stringify(run.input)).not.toContain("secret source");
		expect(store.listAgentV2RunEvents("client-a", "run-start", 0).map((event) => [event.seq, event.type])).toEqual([
			[1, "agent_v2.run_created"],
			[2, "agent_v2.planning_ready"],
		]);
		expect(store.listAgentV2Documents("client-a", "run-start")).toHaveLength(5);
		expect(store.listAgentV2Tasks("client-a", "run-start")).toHaveLength(6);
		expect(store.listAgentV2Artifacts("client-a", "run-start")).toHaveLength(5);
		expect(store.listAgentV2Diagnostics("client-a", "run-start")).toHaveLength(1);
		expect(
			store
				.listAgentV2InputReferences("client-a", "run-start")
				.map((reference) => reference.kind)
				.sort(),
		).toEqual(["attachment", "project_file"]);
		expect(wakeSnapshots).toEqual([{ runs: 1, documents: 5, tasks: 6, artifacts: 5, references: 2, events: 2 }]);

		const intents = store.leaseAgentV2Outbox({
			ownerId: "test",
			limit: 20,
			now: "2026-07-14T01:01:00.000Z",
			leaseTtlMs: 1000,
		});
		expect(intents.map((intent) => intent.reference)).toEqual(
			expect.arrayContaining([
				{ kind: "live_event", eventSeq: 1 },
				{ kind: "live_event", eventSeq: 2 },
				{ kind: "workspace_diagnostic", diagnosticId: "capability-routing" },
				{ kind: "langfuse_diagnostic", diagnosticId: "capability-routing" },
				{ kind: "run_enqueue", queueName: "agent-v2-test" },
			]),
		);
	});

	it("keeps a durable start successful when dispatcher wake fails", async () => {
		const store = createStore();
		const service = createService(store, {
			wakeDispatcher: () => {
				throw new Error("dispatcher unavailable");
			},
		});

		await expect(service.startRun("client-a", startRequest("run-wake-fail"))).resolves.toMatchObject({
			runId: "run-wake-fail",
			status: "queued",
		});
		expect(store.listAgentV2RunEvents("client-a", "run-wake-fail", 0)).toHaveLength(2);
	});

	it("builds and commits the product blueprint from normalized PM document bytes", async () => {
		const store = createStore();
		const service = createService(store);
		const request = startRequest("run-blueprint-source");
		request.input.projectFiles = [
			{
				filename: "docs/requirements.md",
				content:
					"# Quality Dashboard\n## Interaction\n- Customer filter must update KPI and charts.\n## Acceptance\n- Loading, empty, and error states are visible when applicable.",
			},
		];
		request.input.attachments = [
			{
				type: "file",
				fileName: "requirements.md",
				mimeType: "text/markdown",
				projectFilePath: "docs/requirements.md",
			},
		];

		await service.startRun("client-a", request);

		const document = store
			.listAgentV2Documents("client-a", "run-blueprint-source")
			.find((candidate) => candidate.kind === "product_blueprint");
		expect(document?.contentJson).toMatchObject({
			kind: "product_blueprint",
			version: 1,
			sourceDocuments: [expect.objectContaining({ path: "docs/requirements.md" })],
			metadata: expect.objectContaining({ sourceDocumentCount: 1 }),
		});
		expect(JSON.stringify(document?.contentJson)).toContain("Customer filter must update KPI and charts.");
	});

	it("replays an identical runId without duplicates and conflicts on changed immutable bytes with zero writes", async () => {
		const store = createStore();
		const wakeDispatcher = vi.fn();
		const service = createService(store, {
			now: timestampSequence(CREATED_AT, "2026-07-14T01:05:00.000Z", "2026-07-14T01:06:00.000Z"),
			wakeDispatcher,
		});
		const request = startRequest("run-replay");

		const first = await service.startRun("client-a", request);
		const replay = await service.startRun("client-a", request);
		expect(replay).toEqual(first);
		expect(store.listAgentV2Runs("client-a")).toHaveLength(1);
		expect(store.listAgentV2RunEvents("client-a", "run-replay", 0)).toHaveLength(2);
		expect(store.listAgentV2Documents("client-a", "run-replay")).toHaveLength(5);
		expect(wakeDispatcher).toHaveBeenCalledTimes(2);

		const before = snapshotCounts(store, "run-replay");
		await expect(
			service.startRun("client-a", {
				...request,
				input: {
					...(request.input as Record<string, unknown>),
					projectFiles: [{ filename: "src/main.ts", content: "changed source" }],
				},
			}),
		).rejects.toMatchObject({ name: "AgentV2RunApiError", statusCode: 409 });
		expect(snapshotCounts(store, "run-replay")).toEqual(before);
	});

	it("uses one start commit for normal create, existing replay, and generated identity", async () => {
		const store = createStore();
		const commit = vi.spyOn(store, "commitAgentV2RunStart");
		const service = createService(store);

		await service.startRun("client-a", startRequest("run-call-count"));
		expect(commit).toHaveBeenCalledTimes(1);
		commit.mockClear();

		await service.startRun("client-a", startRequest("run-call-count"));
		expect(commit).toHaveBeenCalledTimes(1);
		commit.mockClear();

		const generated = startRequest("ignored");
		delete generated.runId;
		await service.startRun("client-a", generated);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("serializes concurrent identical starts across different service clocks as create plus replay", async () => {
		const store = createStore();
		const firstCommit = vi.fn(store.commitAgentV2RunStart.bind(store));
		const secondCommit = vi.fn(store.commitAgentV2RunStart.bind(store));
		const firstWake = vi.fn();
		const secondWake = vi.fn();
		const firstService = createService(withStartOverrides(store, { commit: firstCommit }), {
			now: () => "2026-07-14T01:00:00.000Z",
			wakeDispatcher: firstWake,
		});
		const secondService = createService(withStartOverrides(store, { commit: secondCommit }), {
			now: () => "2026-07-14T01:05:00.000Z",
			wakeDispatcher: secondWake,
		});
		const request = startRequest("run-concurrent");

		const [first, second] = await Promise.all([
			firstService.startRun("client-a", request),
			secondService.startRun("client-a", request),
		]);

		expect(second).toEqual(first);
		expect([firstCommit.mock.calls.length, secondCommit.mock.calls.length].sort()).toEqual([1, 2]);
		expect(firstCommit.mock.calls.length + secondCommit.mock.calls.length).toBe(3);
		expect(firstWake).toHaveBeenCalledTimes(1);
		expect(secondWake).toHaveBeenCalledTimes(1);
		expect(store.listAgentV2Runs("client-a")).toHaveLength(1);
		expect(store.listAgentV2RunEvents("client-a", "run-concurrent", 0)).toHaveLength(2);
		expect(snapshotCounts(store, "run-concurrent")).toMatchObject({
			runs: 1,
			references: 2,
			documents: 5,
			tasks: 6,
			artifacts: 5,
			diagnostics: 1,
			events: 2,
		});
	});

	it("keeps concurrent changed evidence as one durable winner plus one 409 with no partial writes", async () => {
		const store = createStore();
		const firstCommit = vi.fn(store.commitAgentV2RunStart.bind(store));
		const secondCommit = vi.fn(store.commitAgentV2RunStart.bind(store));
		const firstWake = vi.fn();
		const secondWake = vi.fn();
		const firstService = createService(withStartOverrides(store, { commit: firstCommit }), {
			now: () => "2026-07-14T01:00:00.000Z",
			wakeDispatcher: firstWake,
		});
		const secondService = createService(withStartOverrides(store, { commit: secondCommit }), {
			now: () => "2026-07-14T01:05:00.000Z",
			wakeDispatcher: secondWake,
		});
		const first = startRequest("run-concurrent-conflict");
		const changed = {
			...first,
			input: {
				...first.input,
				projectFiles: [{ filename: "src/main.ts", content: "changed source" }],
			},
		};

		const results = await Promise.allSettled([
			firstService.startRun("client-a", first),
			secondService.startRun("client-a", changed),
		]);

		expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
		const rejection = results.find((result) => result.status === "rejected");
		expect(rejection).toMatchObject({
			status: "rejected",
			reason: { name: "AgentV2RunApiError", statusCode: 409 },
		});
		expect([firstCommit.mock.calls.length, secondCommit.mock.calls.length].sort()).toEqual([1, 2]);
		expect(firstCommit.mock.calls.length + secondCommit.mock.calls.length).toBe(3);
		expect(firstWake.mock.calls.length + secondWake.mock.calls.length).toBe(1);
		expect(snapshotCounts(store, "run-concurrent-conflict")).toMatchObject({
			runs: 1,
			references: 2,
			documents: 5,
			tasks: 6,
			artifacts: 5,
			diagnostics: 1,
			events: 2,
		});
	});

	it("does not retry when the exact start conflict has no post-read winner", async () => {
		const store = createStore();
		const get = vi.fn(() => undefined);
		const commit = vi.fn(() => {
			throw new Error("Agent v2 run start replay conflict");
		});
		const wake = vi.fn();
		const service = createService(withStartOverrides(store, { get, commit }), { wakeDispatcher: wake });

		await expect(service.startRun("client-a", startRequest("run-missing-winner"))).rejects.toMatchObject({
			name: "AgentV2RunApiError",
			statusCode: 409,
		});
		expect(get).toHaveBeenCalledTimes(2);
		expect(commit).toHaveBeenCalledTimes(1);
		expect(wake).not.toHaveBeenCalled();
	});

	it("does not retry unrelated compare-and-set or injected faults even when a post-read winner could exist", async () => {
		for (const message of ["Agent v2 cancel compare-and-set conflict", "injected composite failure"]) {
			const store = createStore();
			const winner = store.createAgentV2Run({
				clientId: "client-a",
				runId: "run-unrelated-fault",
				input: { objective: "Build a reliable static application" },
				model: { provider: "test", id: "model-a" },
				createdAt: CREATED_AT,
			});
			const get = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(winner);
			const commit = vi.fn(() => {
				throw new Error(message);
			});
			const service = createService(withStartOverrides(store, { get, commit }));

			await expect(service.startRun("client-a", startRequest("run-unrelated-fault"))).rejects.toThrow(message);
			expect(get).toHaveBeenCalledTimes(1);
			expect(commit).toHaveBeenCalledTimes(1);
		}
	});

	it("normalizes caller bytes once and rebinds the frozen payload when the concurrent winner has progressed", async () => {
		const store = createStore();
		const winnerService = createService(store, { now: () => CREATED_AT });
		await winnerService.startRun("client-a", startRequest("run-toctou"));
		store.updateAgentV2Run({
			clientId: "client-a",
			runId: "run-toctou",
			status: "running",
			phase: "implementation",
			workerId: "worker-a",
			startedAt: "2026-07-14T01:00:01.000Z",
			updatedAt: "2026-07-14T01:00:01.000Z",
		});
		const progressed = store.getAgentV2Run("client-a", "run-toctou");
		if (!progressed) throw new Error("missing progressed winner");

		let contentReads = 0;
		const request = startRequest("run-toctou");
		const file = { filename: "src/main.ts" } as { filename: string; content: string };
		Object.defineProperty(file, "content", {
			enumerable: true,
			get() {
				contentReads += 1;
				return contentReads === 1 ? "secret source" : "changed source";
			},
		});
		request.input.projectFiles = [file];
		const get = vi.fn().mockReturnValueOnce(undefined).mockReturnValue(progressed);
		const originalCommit = store.commitAgentV2RunStart.bind(store);
		const commit = vi.fn(originalCommit).mockImplementationOnce(() => {
			throw new Error("Agent v2 run start replay conflict");
		});
		const wake = vi.fn();
		const service = createService(withStartOverrides(store, { get, commit }), {
			now: () => "2026-07-14T01:05:00.000Z",
			wakeDispatcher: wake,
		});

		await expect(service.startRun("client-a", request)).resolves.toEqual(progressed);
		expect(contentReads).toBe(1);
		expect(get).toHaveBeenCalledTimes(2);
		expect(commit).toHaveBeenCalledTimes(2);
		expect(wake).toHaveBeenCalledTimes(1);
	});

	it("rejects legacy prompt alone or beside objective with zero durable writes", async () => {
		for (const [index, input] of [
			{ sessionId: "session-a", title: "Example", prompt: "legacy prompt" },
			{ sessionId: "session-a", title: "Example", objective: "Build v2", prompt: "legacy prompt" },
		].entries()) {
			const store = createStore();
			const service = createService(store);
			await expect(
				service.startRun("client-a", {
					runId: `run-prompt-${index}`,
					input,
					model: { provider: "test", id: "model-a" },
				}),
			).rejects.toMatchObject({ name: "AgentV2RunApiError", statusCode: 400 });
			expect(agentV2RowCounts(storeFiles.get(store) ?? "")).toEqual({
				runs: 0,
				blobs: 0,
				references: 0,
				bootstraps: 0,
				documents: 0,
				tasks: 0,
				artifacts: 0,
				diagnostics: 0,
				events: 0,
				outbox: 0,
			});
		}
	});

	it("rejects client-controlled durable timestamps with zero writes", async () => {
		for (const [index, createdAt] of ["9999-12-31T23:59:59.999Z", "1970-01-01T00:00:00.000Z"].entries()) {
			const store = createStore();
			const service = createService(store);
			await expect(
				service.startRun("client-a", {
					...startRequest(`run-client-clock-${index}`),
					createdAt,
				} as AgentV2StartRunRequest),
			).rejects.toMatchObject({ name: "AgentV2RunApiError", statusCode: 400 });
			expect(store.listAgentV2Runs("client-a")).toEqual([]);
		}
	});

	it("rejects client and generated run IDs that are not bounded canonical route segments", async () => {
		for (const runId of [".", "..", " leading", "trailing ", "a/b", "a\\b", "a?b", "a%2Fb", "x".repeat(129)]) {
			const store = createStore();
			const commit = vi.spyOn(store, "commitAgentV2RunStart");
			const service = createService(store);
			await expect(service.startRun("client-a", startRequest(runId))).rejects.toMatchObject({
				name: "AgentV2RunApiError",
				statusCode: 400,
			});
			expect(commit).not.toHaveBeenCalled();
		}

		const store = createStore();
		const commit = vi.spyOn(store, "commitAgentV2RunStart");
		const service = createService(store, { createRunId: () => "generated/run" });
		const request = startRequest("ignored");
		delete request.runId;
		await expect(service.startRun("client-a", request)).rejects.toMatchObject({
			name: "AgentV2RunApiError",
			statusCode: 400,
		});
		expect(commit).not.toHaveBeenCalled();
	});

	it("rejects invalid model/input before calling the durable commit", async () => {
		const store = createStore();
		const commit = vi.spyOn(store, "commitAgentV2RunStart");
		const service = createService(store);

		await expect(
			service.startRun("client-a", {
				...startRequest("run-invalid"),
				model: { provider: "test", id: "model-a", baseUrl: "https://attacker.invalid" },
			}),
		).rejects.toMatchObject({ name: "AgentV2RunApiError", statusCode: 400 });
		expect(commit).not.toHaveBeenCalled();
		expect(store.listAgentV2Runs("client-a")).toEqual([]);
	});

	it("leaves no residue when the single durable start commit fails", async () => {
		const store = createStore();
		const original = store.commitAgentV2RunStart.bind(store);
		vi.spyOn(store, "commitAgentV2RunStart").mockImplementationOnce(() => {
			throw new Error("injected bootstrap write failure");
		});
		const service = createService(store);

		await expect(service.startRun("client-a", startRequest("run-fault"))).rejects.toThrow(
			"injected bootstrap write failure",
		);
		expect(store.listAgentV2Runs("client-a")).toEqual([]);
		expect(store.listAgentV2InputReferences("client-a", "run-fault")).toEqual([]);
		expect(store.listAgentV2RunEvents("client-a", "run-fault", 0)).toEqual([]);
		vi.spyOn(store, "commitAgentV2RunStart").mockImplementation(original);
	});

	it("rolls back the complete start for real blob, reference, bootstrap and planning table faults", async () => {
		for (const [index, table] of [
			"agent_v2_input_blobs",
			"agent_v2_input_references",
			"agent_v2_bootstraps",
			"agent_v2_documents",
		].entries()) {
			const store = createStore();
			const file = storeFiles.get(store);
			if (!file) throw new Error("missing test store file");
			const faultDb = new DatabaseSync(file);
			try {
				faultDb.exec(
					`CREATE TRIGGER task3_fault_${index} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'task3 injected ${table} fault'); END`,
				);
			} finally {
				faultDb.close();
			}
			const service = createService(store);
			await expect(service.startRun("client-a", startRequest(`run-fault-${index}`))).rejects.toThrow(
				`task3 injected ${table} fault`,
			);
			expect(agentV2RowCounts(file)).toEqual({
				runs: 0,
				blobs: 0,
				references: 0,
				bootstraps: 0,
				documents: 0,
				tasks: 0,
				artifacts: 0,
				diagnostics: 0,
				events: 0,
				outbox: 0,
			});
		}
	});

	it.each([
		["queued", "implementation", undefined],
		["running", "implementation", "worker-a"],
	] as const)("atomically cancels a %s run through a durable live/cancel intent", async (status, phase, workerId) => {
		const store = createStore();
		const service = createService(store, {
			now: timestampSequence(CREATED_AT, "2026-07-14T01:10:00.000Z"),
		});
		await service.startRun("client-a", startRequest(`run-${status}`));
		if (status === "running") {
			store.updateAgentV2Run({
				clientId: "client-a",
				runId: `run-${status}`,
				status,
				phase,
				workerId,
				startedAt: "2026-07-14T01:00:01.000Z",
				updatedAt: "2026-07-14T01:00:01.000Z",
			});
		}

		const cancelled = await service.cancelRun("client-a", `run-${status}`);
		expect(cancelled).toMatchObject({
			status: "cancelled",
			phase: "cancelled",
			updatedAt: "2026-07-14T01:10:00.000Z",
			endedAt: "2026-07-14T01:10:00.000Z",
		});
		const cancelEvent = store.listAgentV2RunEvents("client-a", `run-${status}`, 0).at(-1);
		expect(cancelEvent).toMatchObject({
			type: "agent_v2.phase_changed",
			payload: {
				type: "agent_v2.phase_changed",
				phase: "cancelled",
				status: "cancelled",
			},
			createdAt: "2026-07-14T01:10:00.000Z",
		});
		const intents = store.leaseAgentV2Outbox({
			ownerId: `cancel-${status}`,
			kinds: ["run_cancel"],
			limit: 1,
			now: "2026-07-14T01:10:01.000Z",
			leaseTtlMs: 1000,
		});
		expect(intents[0].reference).toEqual({
			kind: "run_cancel",
			queueName: "agent-v2-test",
			cancelToken: deterministicCancelToken("client-a", `run-${status}`),
		});
	});

	it("keeps cancel durable across wake failure and returns the terminal state for duplicate HTTP cancel", async () => {
		const store = createStore();
		const wakeDispatcher = vi.fn(async () => {
			throw new Error("redis unavailable");
		});
		const service = createService(store, {
			now: () => "2026-07-14T01:10:00.000Z",
			wakeDispatcher,
		});
		await service.startRun("client-a", startRequest("run-cancel-replay"));

		const first = await service.cancelRun("client-a", "run-cancel-replay");
		const replay = await service.cancelRun("client-a", "run-cancel-replay");
		expect(replay).toEqual(first);
		expect(
			store
				.listAgentV2RunEvents("client-a", "run-cancel-replay", 0)
				.filter(
					(event) =>
						event.type === "agent_v2.phase_changed" &&
						event.payload.phase === "cancelled" &&
						event.payload.status === "cancelled",
				),
		).toHaveLength(1);
		expect(wakeDispatcher).toHaveBeenCalledTimes(2);
	});

	it("redelivers one deterministic cancel token after delivery ack loss without duplicating Redis semantics", async () => {
		const store = createStore();
		const service = createService(store, { now: () => "2026-07-14T01:10:00.000Z" });
		await service.startRun("client-a", startRequest("run-cancel-ack-loss"));
		await service.cancelRun("client-a", "run-cancel-ack-loss");
		const firstLease = store.leaseAgentV2Outbox({
			ownerId: "dispatcher-a",
			kinds: ["run_cancel"],
			limit: 1,
			now: "2026-07-14T01:10:01.000Z",
			leaseTtlMs: 1_000,
		});
		const deliveredTokens = new Set<string>();
		const firstReference = firstLease[0].reference;
		if (firstReference.kind !== "run_cancel") throw new Error("expected cancel intent");
		deliveredTokens.add(firstReference.cancelToken);
		// Delivery succeeded, but the dispatcher lost the acknowledgement before marking the lease delivered.
		const recoveredLease = store.leaseAgentV2Outbox({
			ownerId: "dispatcher-b",
			kinds: ["run_cancel"],
			limit: 1,
			now: "2026-07-14T01:10:03.000Z",
			leaseTtlMs: 1_000,
		});
		const recoveredReference = recoveredLease[0].reference;
		if (recoveredReference.kind !== "run_cancel") throw new Error("expected recovered cancel intent");
		deliveredTokens.add(recoveredReference.cancelToken);
		expect(recoveredReference.cancelToken).toBe(firstReference.cancelToken);
		expect(deliveredTokens.size).toBe(1);
		expect(
			store.markAgentV2OutboxDelivered({
				intentId: recoveredLease[0].intentId,
				ownerId: "dispatcher-b",
				leaseAttempt: recoveredLease[0].attemptCount,
				deliveredAt: "2026-07-14T01:10:03.500Z",
			}),
		).toBe("delivered");
	});

	it("returns existing terminal runs and reports not found without durable writes", async () => {
		const store = createStore();
		const service = createService(store);
		await expect(service.cancelRun("client-a", "missing")).rejects.toMatchObject({
			name: "AgentV2RunApiError",
			statusCode: 404,
		});
		await service.startRun("client-a", startRequest("run-terminal"));
		const cancelled = await service.cancelRun("client-a", "run-terminal");
		await expect(service.cancelRun("client-a", "run-terminal")).resolves.toEqual(cancelled);
	});

	it("get/list/events use only the v2 read surfaces", async () => {
		const store = createStore();
		const service = createService(store);
		await service.startRun("client-a", startRequest("run-read"));

		await expect(service.getRun("client-a", "run-read")).resolves.toMatchObject({ runId: "run-read" });
		await expect(service.listRuns("client-a")).resolves.toHaveLength(1);
		await expect(service.listRunEvents("client-a", "run-read", 0)).resolves.toHaveLength(2);
	});
});

function createStore(): RuntimeDbStore {
	const root = mkdtempSync(join(tmpdir(), "pi-agent-v2-run-api-service-"));
	const file = join(root, "runtime.sqlite");
	const store = new RuntimeDbStore(file);
	store.ensureAgentV2Schema();
	roots.push(root);
	stores.push(store);
	storeFiles.set(store, file);
	return store;
}

function agentV2RowCounts(file: string): Record<string, number> {
	const db = new DatabaseSync(file);
	try {
		const count = (table: string) =>
			(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
		return {
			runs: count("agent_v2_runs"),
			blobs: count("agent_v2_input_blobs"),
			references: count("agent_v2_input_references"),
			bootstraps: count("agent_v2_bootstraps"),
			documents: count("agent_v2_documents"),
			tasks: count("agent_v2_tasks"),
			artifacts: count("agent_v2_artifacts"),
			diagnostics: count("agent_v2_diagnostics"),
			events: count("agent_v2_run_events"),
			outbox: count("agent_v2_outbox"),
		};
	} finally {
		db.close();
	}
}

function createService(
	store: RuntimeDbStore,
	overrides: {
		now?: () => string;
		wakeDispatcher?: () => void | Promise<void>;
		createRunId?: () => string;
	} = {},
): AgentV2RunApiService {
	return new AgentV2RunApiService({
		store,
		events: {
			list: async (clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> =>
				store.listAgentV2RunEvents(clientId, runId, afterSeq),
		},
		queueName: "agent-v2-test",
		createRunId: overrides.createRunId ?? (() => "generated-run"),
		now: overrides.now ?? (() => CREATED_AT),
		wakeDispatcher: overrides.wakeDispatcher,
	});
}

function withStartOverrides(
	store: RuntimeDbStore,
	overrides: {
		get?: RuntimeDbStore["getAgentV2Run"];
		commit?: RuntimeDbStore["commitAgentV2RunStart"];
	},
): RuntimeDbStore {
	return new Proxy(store, {
		get(target, property) {
			if (property === "getAgentV2Run" && overrides.get) return overrides.get;
			if (property === "commitAgentV2RunStart" && overrides.commit) return overrides.commit;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function startRequest(runId: string): AgentV2StartRunRequest & { input: Record<string, unknown> } {
	return {
		runId,
		input: {
			sessionId: "session-a",
			title: "Example",
			objective: "Build a reliable static application",
			projectFiles: [{ filename: "src/main.ts", content: "secret source" }],
			attachments: [
				{
					type: "file",
					fileName: "main.ts",
					mimeType: "application/typescript",
					projectFilePath: "src/main.ts",
				},
			],
		},
		model: { provider: "test", id: "model-a" },
	};
}

function snapshotCounts(store: RuntimeDbStore, runId: string): Record<string, number> {
	return {
		runs: store.listAgentV2Runs("client-a").length,
		references: store.listAgentV2InputReferences("client-a", runId).length,
		documents: store.listAgentV2Documents("client-a", runId).length,
		tasks: store.listAgentV2Tasks("client-a", runId).length,
		artifacts: store.listAgentV2Artifacts("client-a", runId).length,
		diagnostics: store.listAgentV2Diagnostics("client-a", runId).length,
		events: store.listAgentV2RunEvents("client-a", runId, 0).length,
	};
}

function deterministicCancelToken(clientId: string, runId: string): string {
	return `cancel:${createHash("sha256").update(`${clientId}\0${runId}\0cancel`).digest("hex")}`;
}

function timestampSequence(...timestamps: string[]): () => string {
	let index = 0;
	return () => timestamps[index++] ?? timestamps.at(-1) ?? CREATED_AT;
}
