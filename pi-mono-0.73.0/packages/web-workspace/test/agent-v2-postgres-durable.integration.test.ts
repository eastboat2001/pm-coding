import { afterEach, describe, expect, it, vi } from "vitest";
import { type AgentV2DurableCommitStore, agentV2StartReplayFingerprint } from "../src/agent-v2-durable-store.js";
import type { AgentV2OutboxStore } from "../src/agent-v2-outbox.js";
import { AgentV2RunApiService } from "../src/agent-v2-run-api-service.js";
import type { AgentV2RunEventRecord } from "../src/agent-v2-store.js";
import { PostgresRuntimeStore, type Queryable } from "../src/postgres-runtime-store.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./helpers/postgres-test-schema.js";

const schemas: PostgresTestSchema[] = [];
const stores: PostgresRuntimeStore[] = [];

afterEach(async () => {
	for (const store of stores.splice(0)) await store.close();
	for (const schema of schemas.splice(0)) await schema.close();
});

describe("agent v2 PostgreSQL durable store", () => {
	it("serializes two concurrent identical missing-row starts into create plus replay", async () => {
		const isolated = await createIsolated();
		let begun = 0;
		let releaseBegins!: () => void;
		const beginsReleased = new Promise<void>((resolve) => {
			releaseBegins = resolve;
		});
		const barrierQueryable: Queryable & { connect(): Promise<Queryable & { release(): void }> } = {
			query: (sql, values) => isolated.pool.query(sql, values ? [...values] : undefined),
			async connect() {
				const client = await isolated.pool.connect();
				return {
					async query(sql, values) {
						const result = await client.query(sql, values ? [...values] : undefined);
						if (sql.trim() === "BEGIN") {
							begun += 1;
							if (begun === 2) releaseBegins();
							await beginsReleased;
						}
						return result;
					},
					release: () => client.release(),
				};
			},
		};
		const schemaStore = new PostgresRuntimeStore({ queryable: isolated.pool });
		stores.push(schemaStore);
		await schemaStore.ensureAgentV2Schema();
		const store = new PostgresRuntimeStore({ queryable: barrierQueryable }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		const input = startInput("run-concurrent", "2026-07-13T10:50:00.000Z");
		input.run.input.prompt = "private start prompt evidence";
		const fingerprint = agentV2StartReplayFingerprint(input);
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("concurrent start timed out")), 3000),
		);
		const results = await Promise.race([
			Promise.all([store.commitAgentV2RunStart(input), store.commitAgentV2RunStart(input)]),
			timeout,
		]);
		expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
		const publicEvents = await store.listAgentV2RunEvents("client-a", "run-concurrent", 0);
		expect(publicEvents).toHaveLength(2);
		expect(publicEvents[0]?.payload).toEqual({
			type: "agent_v2.run_created",
			status: "queued",
			phase: "intake",
			attempt: 1,
			at: input.createdAt,
		});
		const serializedEvents = JSON.stringify(publicEvents);
		for (const privateValue of [input.run.input.prompt, input.bootstrapChecksum, fingerprint]) {
			expect(serializedEvents).not.toContain(privateValue);
		}
		const bootstrap = await isolated.pool.query<{ bootstrap_checksum: string }>(
			"SELECT bootstrap_checksum FROM agent_v2_bootstraps WHERE client_id='client-a' AND run_id='run-concurrent'",
		);
		expect(bootstrap.rows[0]?.bootstrap_checksum).toBe(fingerprint);
		expect(bootstrap.rows[0]?.bootstrap_checksum).not.toBe(input.bootstrapChecksum);
		const rows = await isolated.pool.query<{ count: string }>(
			"SELECT COUNT(*)::text AS count FROM agent_v2_runs WHERE client_id='client-a' AND run_id='run-concurrent'",
		);
		expect(rows.rows[0]?.count).toBe("1");
	});

	it("reconciles two service starts with different clocks through one bounded replay without duplicate rows", async () => {
		const isolated = await createIsolated();
		let begun = 0;
		let releaseBegins!: () => void;
		const beginsReleased = new Promise<void>((resolve) => {
			releaseBegins = resolve;
		});
		const barrierQueryable: Queryable & { connect(): Promise<Queryable & { release(): void }> } = {
			query: (sql, values) => isolated.pool.query(sql, values ? [...values] : undefined),
			async connect() {
				const client = await isolated.pool.connect();
				return {
					async query(sql, values) {
						const result = await client.query(sql, values ? [...values] : undefined);
						if (sql.trim() === "BEGIN") {
							begun += 1;
							if (begun === 2) releaseBegins();
							await beginsReleased;
						}
						return result;
					},
					release: () => client.release(),
				};
			},
		};
		const schemaStore = new PostgresRuntimeStore({ queryable: isolated.pool });
		stores.push(schemaStore);
		await schemaStore.ensureAgentV2Schema();
		const store = new PostgresRuntimeStore({ queryable: barrierQueryable }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		const originalCommit = store.commitAgentV2RunStart.bind(store);
		const replayed: boolean[] = [];
		const commit = vi.spyOn(store, "commitAgentV2RunStart").mockImplementation(async (input) => {
			const result = await originalCommit(input);
			replayed.push(result.replayed);
			return result;
		});
		const createService = (now: string) =>
			new AgentV2RunApiService({
				store,
				events: {
					list: async (clientId: string, runId: string, afterSeq: number): Promise<AgentV2RunEventRecord[]> =>
						store.listAgentV2RunEvents(clientId, runId, afterSeq),
				},
				queueName: "agent-v2-postgres-test",
				now: () => now,
			});
		const request = {
			runId: "run-service-concurrent",
			input: {
				sessionId: "session-a",
				title: "PostgreSQL concurrency",
				objective: "Build a durable static application",
				projectFiles: [{ filename: "src/main.ts", content: "export const ready = true;" }],
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
		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("service concurrent start timed out")), 5000),
		);
		const runs = await Promise.race([
			Promise.all([
				createService("2026-07-13T10:55:00.000Z").startRun("client-a", request),
				createService("2026-07-13T10:56:00.000Z").startRun("client-a", request),
			]),
			timeout,
		]);

		expect(runs[1]).toEqual(runs[0]);
		expect(commit).toHaveBeenCalledTimes(3);
		expect(replayed.sort()).toEqual([false, true]);
		const counts = await isolated.pool.query<{ table_name: string; count: string }>(`
			SELECT 'runs' AS table_name, COUNT(*)::text AS count FROM agent_v2_runs WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'blobs', COUNT(*)::text FROM agent_v2_input_blobs WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'references', COUNT(*)::text FROM agent_v2_input_references WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'documents', COUNT(*)::text FROM agent_v2_documents WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'tasks', COUNT(*)::text FROM agent_v2_tasks WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'artifacts', COUNT(*)::text FROM agent_v2_artifacts WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'diagnostics', COUNT(*)::text FROM agent_v2_diagnostics WHERE client_id='client-a' AND run_id='run-service-concurrent'
			UNION ALL SELECT 'events', COUNT(*)::text FROM agent_v2_run_events WHERE client_id='client-a' AND run_id='run-service-concurrent'
		`);
		expect(Object.fromEntries(counts.rows.map((row) => [row.table_name, Number(row.count)]))).toEqual({
			runs: 1,
			blobs: 1,
			references: 2,
			documents: 5,
			tasks: 6,
			artifacts: 5,
			diagnostics: 1,
			events: 2,
		});
	});

	it("uses SKIP LOCKED across two real connections and never overlaps a held candidate", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore &
			AgentV2OutboxStore;
		stores.push(store);
		await store.ensureAgentV2Schema();
		await store.commitAgentV2RunStart(startInput("run-a", "2026-07-13T11:00:00.000Z"));
		await store.commitAgentV2RunStart(startInput("run-b", "2026-07-13T11:00:01.000Z"));

		const ownerA = await isolated.pool.connect();
		try {
			await ownerA.query("BEGIN");
			const held = await ownerA.query<{ intent_id: string }>(
				"SELECT intent_id FROM agent_v2_outbox WHERE status = 'pending' ORDER BY available_at, created_at, intent_id LIMIT 1 FOR UPDATE",
			);
			await ownerA.query(
				"UPDATE agent_v2_outbox SET status = 'leased', lease_owner = 'owner-a', lease_expires_at = '2026-07-13T11:00:03.000Z', attempt_count = attempt_count + 1 WHERE intent_id = $1",
				[held.rows[0]?.intent_id],
			);
			const timeout = new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("SKIP LOCKED lease blocked")), 1500),
			);
			const leased = await Promise.race([
				store.leaseAgentV2Outbox({
					ownerId: "owner-b",
					limit: 1,
					now: "2026-07-13T11:00:02.000Z",
					leaseTtlMs: 1000,
				}),
				timeout,
			]);
			expect(leased).toHaveLength(1);
			expect(leased[0]?.intentId).not.toBe(held.rows[0]?.intent_id);
		} finally {
			await ownerA.query("ROLLBACK");
			ownerA.release();
		}
	});

	it("uses one transaction and rolls back every composite-start child on an injected failure", async () => {
		const isolated = await createIsolated();
		const schemaStore = new PostgresRuntimeStore({ queryable: isolated.pool });
		stores.push(schemaStore);
		await schemaStore.ensureAgentV2Schema();
		const boundaries: string[] = [];
		let failureMatcher: (sql: string, values: readonly unknown[]) => boolean = () => false;
		const failingQueryable: Queryable & { connect(): Promise<Queryable & { release(): void }> } = {
			query: (sql, values) => isolated.pool.query(sql, values ? [...values] : undefined),
			async connect() {
				const client = await isolated.pool.connect();
				return {
					async query(sql, values) {
						const normalized = sql.trim().replace(/\s+/g, " ");
						if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) boundaries.push(normalized);
						if (failureMatcher(normalized, values ?? [])) throw new Error("injected composite failure");
						return client.query(sql, values ? [...values] : undefined);
					},
					release: () => client.release(),
				};
			},
		};
		const store = new PostgresRuntimeStore({ queryable: failingQueryable }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		await store.commitAgentV2RunStart(startInput("run-success", "2026-07-13T11:09:00.000Z"));
		expect(boundaries).toEqual(["BEGIN", "COMMIT"]);
		boundaries.length = 0;
		const faultPoints: Array<[string, (sql: string, values: readonly unknown[]) => boolean]> = [
			["blob", (sql) => sql.startsWith("INSERT INTO agent_v2_input_blobs")],
			["reference", (sql) => sql.startsWith("INSERT INTO agent_v2_input_references")],
			["bootstrap", (sql) => sql.startsWith("INSERT INTO agent_v2_bootstraps")],
			[
				"planning",
				(sql, values) =>
					sql.startsWith("INSERT INTO agent_v2_run_events") && values[3] === "agent_v2.planning_ready",
			],
			["outbox", (sql, values) => sql.startsWith("INSERT INTO agent_v2_outbox") && values[4] === "run_enqueue"],
		];
		for (const [label, matcher] of faultPoints) {
			boundaries.length = 0;
			failureMatcher = matcher;
			const runId = `run-failure-${label}`;
			const input = startInput(runId, "2026-07-13T11:10:00.000Z");
			input.inputBlobs.push({
				clientId: "client-a",
				runId,
				inputId: "input-a",
				logicalPath: "a.txt",
				mediaType: "text/plain",
				encoding: "utf8",
				bytes: new Uint8Array([97]),
				byteLength: 1,
				checksum: "sha-a",
				createdAt: input.createdAt,
			});
			input.inputReferences.push({
				clientId: "client-a",
				runId,
				kind: "attachment",
				ordinal: 0,
				inputId: "input-a",
				logicalPath: "a.txt",
				mediaType: "text/plain",
				byteLength: 1,
				checksum: "sha-a",
			});
			await expect(store.commitAgentV2RunStart(input), label).rejects.toThrow("injected composite failure");
			expect(boundaries, label).toEqual(["BEGIN", "ROLLBACK"]);
			for (const table of [
				"agent_v2_runs",
				"agent_v2_input_blobs",
				"agent_v2_input_references",
				"agent_v2_bootstraps",
				"agent_v2_run_events",
				"agent_v2_outbox",
			]) {
				const count = await isolated.pool.query<{ count: string }>(
					`SELECT COUNT(*)::text AS count FROM ${table} WHERE run_id = $1`,
					[runId],
				);
				expect(count.rows[0]?.count, `${label}:${table}`).toBe("0");
			}
		}
	});

	it("enforces complete updatedAt CAS before PostgreSQL event and outbox writes", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		await store.ensureAgentV2Schema();
		const createdAt = "2026-07-13T11:20:00.000Z";
		await store.commitAgentV2RunStart(startInput("run-cas", createdAt));
		const run = await store.getAgentV2Run("client-a", "run-cas");
		if (!run) throw new Error("expected run");
		const expectedRun = {
			status: run.status,
			phase: run.phase,
			attempt: run.attempt,
			workerId: run.workerId ?? null,
			updatedAt: run.updatedAt,
		};
		const mismatches = [
			{ status: "running" as const },
			{ phase: "validation" as const },
			{ attempt: expectedRun.attempt + 1 },
			{ workerId: "worker-aba" },
			{ updatedAt: "2026-07-13T11:19:59.000Z" },
		];
		for (const [index, mismatch] of mismatches.entries()) {
			const rejected = await store.commitAgentV2RunTransition({
				expectedRun: { ...expectedRun, ...mismatch },
				update: {
					clientId: "client-a",
					runId: "run-cas",
					expectedStatuses: ["queued"],
					status: "running",
					updatedAt: `2026-07-13T11:20:0${index + 1}.000Z`,
				},
				event: { type: "must_not_write", payload: { index }, createdAt },
			});
			expect(rejected.update.applied, JSON.stringify(mismatch)).toBe(false);
		}
		expect(await store.listAgentV2RunEvents("client-a", "run-cas", 0)).toHaveLength(2);
		const first = await store.commitAgentV2RunTransition({
			expectedRun,
			update: {
				clientId: "client-a",
				runId: "run-cas",
				expectedStatuses: ["queued"],
				status: "running",
				updatedAt: "2026-07-13T11:20:01.000Z",
			},
			event: { type: "run_started", payload: {}, createdAt: "2026-07-13T11:20:01.000Z" },
		});
		expect(first.update.applied).toBe(true);
		const stale = await store.commitAgentV2RunTransition({
			expectedRun,
			update: {
				clientId: "client-a",
				runId: "run-cas",
				expectedStatuses: ["running"],
				phase: "validation",
				updatedAt: "2026-07-13T11:20:02.000Z",
			},
			event: { type: "must_not_write", payload: {}, createdAt: "2026-07-13T11:20:02.000Z" },
		});
		expect(stale.update.applied).toBe(false);
		expect(await store.listAgentV2RunEvents("client-a", "run-cas", 0)).toHaveLength(3);
	});

	it("rejects missing, duplicate, cross-run and non-advancing execution revisions with zero writes", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		await store.ensureAgentV2Schema();
		const createdAt = "2026-07-13T11:25:00.000Z";
		const task = {
			clientId: "client-a",
			runId: "run-task-cas",
			taskId: "task-a",
			kind: "implementation" as const,
			title: "Build",
			status: "ready" as const,
			dependsOn: [],
			acceptanceCriteria: [],
			input: {},
			output: {},
			createdAt,
			updatedAt: createdAt,
		};
		await store.commitAgentV2RunStart({ ...startInput("run-task-cas", createdAt), tasks: [task] });
		const run = await store.getAgentV2Run("client-a", "run-task-cas");
		const currentTask = (await store.listAgentV2Tasks("client-a", "run-task-cas"))[0];
		if (!run || !currentTask) throw new Error("expected task state");
		const expectedRun = expectedRunOf(run);
		const expectedTask = { taskId: "task-a", status: "ready" as const, updatedAt: createdAt };
		const updatedTask = {
			...task,
			status: "running" as const,
			updatedAt: "2026-07-13T11:25:01.000Z",
		};
		const base = {
			clientId: "client-a",
			runId: "run-task-cas",
			expectedRun,
			expectedTasks: [expectedTask],
			updatedAt: "2026-07-13T11:25:01.000Z",
			tasks: [updatedTask],
			events: [{ type: "task_started", payload: { taskId: "task-a" }, createdAt: "2026-07-13T11:25:01.000Z" }],
		};
		const variants = [
			{ ...base, expectedTasks: [] },
			{ ...base, expectedTasks: [expectedTask, expectedTask] },
			{ ...base, expectedTasks: [{ ...expectedTask, taskId: "missing" }] },
			{ ...base, expectedTasks: [{ ...expectedTask, status: "pending" as const }] },
			{ ...base, expectedTasks: [{ ...expectedTask, updatedAt: "stale" }] },
			{ ...base, updatedAt: expectedRun.updatedAt },
			{ ...base, updatedAt: "not-a-date" },
			{ ...base, updatedAt: "2026-07-13T11:25:01Z" },
			{ ...base, updatedAt: "2026-07-13T11:24:59.000Z" },
			{ ...base, tasks: [{ ...updatedTask, updatedAt: expectedTask.updatedAt }] },
			{ ...base, tasks: [{ ...updatedTask, updatedAt: "not-a-date" }] },
			{ ...base, tasks: [{ ...updatedTask, updatedAt: "2026-07-13T11:25:01Z" }] },
			{ ...base, tasks: [{ ...updatedTask, updatedAt: "2026-07-13T11:24:59.000Z" }] },
			{ ...base, tasks: [{ ...updatedTask, runId: "other-run" }] },
		];
		const beforeInvalid = await postgresDurableSnapshot(isolated.pool, "run-task-cas");
		for (const candidate of variants) {
			expect((await store.commitAgentV2ExecutionMutation(candidate)).applied).toBe(false);
			expect(await postgresDurableSnapshot(isolated.pool, "run-task-cas")).toEqual(beforeInvalid);
		}
		expect(await store.listAgentV2RunEvents("client-a", "run-task-cas", 0)).toHaveLength(2);
		expect((await store.listAgentV2Tasks("client-a", "run-task-cas"))[0]).toEqual(currentTask);
		expect((await store.commitAgentV2ExecutionMutation(base)).applied).toBe(true);
		expect((await store.commitAgentV2ExecutionMutation(base)).applied).toBe(false);
		const afterT1 = await postgresDurableSnapshot(isolated.pool, "run-task-cas");
		const runAtT1 = await store.getAgentV2Run("client-a", "run-task-cas");
		const taskAtT1 = (await store.listAgentV2Tasks("client-a", "run-task-cas"))[0];
		if (!runAtT1 || !taskAtT1) throw new Error("expected T1 state");
		const aba = await store.commitAgentV2ExecutionMutation({
			...base,
			expectedRun: expectedRunOf(runAtT1),
			expectedTasks: [{ taskId: "task-a", status: taskAtT1.status, updatedAt: taskAtT1.updatedAt }],
			updatedAt: createdAt,
			tasks: [
				{
					...taskAtT1,
					clientId: "client-a",
					runId: "run-task-cas",
					status: "succeeded",
					updatedAt: createdAt,
				},
			],
			events: [{ type: "must_not_write", payload: {}, createdAt }],
		});
		expect(aba.applied).toBe(false);
		expect(await postgresDurableSnapshot(isolated.pool, "run-task-cas")).toEqual(afterT1);
	});

	it("enforces canonical start revisions and monotonic transition/cancel revisions with zero writes", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(store);
		await store.ensureAgentV2Schema();
		const t0 = "2026-07-13T11:27:00.000Z";
		const invalidBaselines = [
			{ createdAt: "not-a-date", updatedAt: t0 },
			{ createdAt: "2026-07-13T11:27:00Z", updatedAt: t0 },
			{ createdAt: t0, updatedAt: "not-a-date" },
			{ createdAt: t0, updatedAt: "2026-07-13T11:27:00Z" },
			{ createdAt: t0, updatedAt: "2026-07-13T11:26:59.000Z" },
		];
		for (const [index, invalid] of invalidBaselines.entries()) {
			const runId = `run-invalid-start-${index}`;
			const input = startInput(runId, t0);
			input.run.createdAt = invalid.createdAt;
			input.run.updatedAt = invalid.updatedAt;
			const before = await postgresDurableSnapshot(isolated.pool, runId);
			await expect(store.commitAgentV2RunStart(input)).rejects.toThrow("canonical UTC millisecond");
			expect(await postgresDurableSnapshot(isolated.pool, runId)).toEqual(before);

			const taskRunId = `run-invalid-task-${index}`;
			const taskInput = startInput(taskRunId, t0);
			const taskBefore = await postgresDurableSnapshot(isolated.pool, taskRunId);
			await expect(
				store.commitAgentV2RunStart({
					...taskInput,
					tasks: [
						{
							clientId: "client-a",
							runId: taskRunId,
							taskId: "task-a",
							kind: "implementation",
							title: "Build",
							status: "ready",
							dependsOn: [],
							acceptanceCriteria: [],
							input: {},
							output: {},
							createdAt: invalid.createdAt,
							updatedAt: invalid.updatedAt,
						},
					],
				}),
			).rejects.toThrow("canonical UTC millisecond");
			expect(await postgresDurableSnapshot(isolated.pool, taskRunId)).toEqual(taskBefore);
		}

		const runId = "run-transition-revision";
		await store.commitAgentV2RunStart(startInput(runId, t0));
		const initial = await store.getAgentV2Run("client-a", runId);
		if (!initial) throw new Error("expected initial run");
		for (const invalid of [t0, "2026-07-13T11:26:59.000Z", "not-a-date", "2026-07-13T11:27:01Z"]) {
			const before = await postgresDurableSnapshot(isolated.pool, runId);
			const result = await store.commitAgentV2RunTransition({
				expectedRun: expectedRunOf(initial),
				update: {
					clientId: "client-a",
					runId,
					expectedStatuses: ["queued"],
					phase: "validation",
					updatedAt: invalid,
				},
				event: { type: "must_not_write", payload: {}, createdAt: t0 },
			});
			expect(result.update.applied).toBe(false);
			expect(await postgresDurableSnapshot(isolated.pool, runId)).toEqual(before);
		}
		const t1 = "2026-07-13T11:27:01.000Z";
		expect(
			(
				await store.commitAgentV2RunTransition({
					expectedRun: expectedRunOf(initial),
					update: {
						clientId: "client-a",
						runId,
						expectedStatuses: ["queued"],
						phase: "validation",
						updatedAt: t1,
					},
					event: { type: "phase_changed", payload: {}, createdAt: t1 },
				})
			).update.applied,
		).toBe(true);
		const atT1 = await store.getAgentV2Run("client-a", runId);
		if (!atT1) throw new Error("expected T1 run");
		const beforeAba = await postgresDurableSnapshot(isolated.pool, runId);
		expect(
			(
				await store.commitAgentV2RunTransition({
					expectedRun: expectedRunOf(atT1),
					update: {
						clientId: "client-a",
						runId,
						expectedStatuses: ["queued"],
						phase: "implementation",
						updatedAt: t0,
					},
					event: { type: "must_not_write", payload: {}, createdAt: t1 },
				})
			).update.applied,
		).toBe(false);
		expect(await postgresDurableSnapshot(isolated.pool, runId)).toEqual(beforeAba);

		for (const invalid of [t1, t0, "not-a-date", "2026-07-13T11:27:02Z"]) {
			const before = await postgresDurableSnapshot(isolated.pool, runId);
			await expect(
				store.commitAgentV2RunCancel({
					clientId: "client-a",
					runId,
					expectedStatuses: ["queued"],
					expectedRun: expectedRunOf(atT1),
					queueName: "agent-v2",
					cancelToken: `invalid-${invalid}`,
					cancelledAt: invalid,
				}),
			).rejects.toThrow("compare-and-set conflict");
			expect(await postgresDurableSnapshot(isolated.pool, runId)).toEqual(before);
		}
	});

	it("rolls back transition, cancel, execution and diagnostic when their final outbox write fails", async () => {
		const isolated = await createIsolated();
		const normal = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(normal);
		await normal.ensureAgentV2Schema();
		const createdAt = "2026-07-13T11:28:00.000Z";
		for (const runId of ["run-transition-fault", "run-cancel-fault", "run-execution-fault", "run-diagnostic-fault"])
			await normal.commitAgentV2RunStart(startInput(runId, createdAt));
		const boundaries: string[] = [];
		let failKind: string | undefined;
		const faultingQueryable: Queryable & { connect(): Promise<Queryable & { release(): void }> } = {
			query: (sql, values) => isolated.pool.query(sql, values ? [...values] : undefined),
			async connect() {
				const client = await isolated.pool.connect();
				return {
					async query(sql, values) {
						const normalized = sql.trim().replace(/\s+/g, " ");
						if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) boundaries.push(normalized);
						if (
							failKind &&
							normalized.startsWith("INSERT INTO agent_v2_outbox") &&
							(values?.[4] === failKind || (failKind === "diagnostic-live" && values?.[4] === "live_event"))
						)
							throw new Error("injected final outbox failure");
						return client.query(sql, values ? [...values] : undefined);
					},
					release: () => client.release(),
				};
			},
		};
		const faulting = new PostgresRuntimeStore({ queryable: faultingQueryable }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore;
		stores.push(faulting);
		const runState = async (runId: string) => {
			const run = await normal.getAgentV2Run("client-a", runId);
			if (!run) throw new Error("expected run");
			return run;
		};

		failKind = "live_event";
		boundaries.length = 0;
		const transitionRun = await runState("run-transition-fault");
		const transitionBefore = await postgresDurableSnapshot(isolated.pool, transitionRun.runId);
		await expect(
			faulting.commitAgentV2RunTransition({
				expectedRun: expectedRunOf(transitionRun),
				update: {
					clientId: "client-a",
					runId: transitionRun.runId,
					expectedStatuses: ["queued"],
					status: "running",
					updatedAt: "2026-07-13T11:28:01.000Z",
				},
				event: { type: "run_started", payload: {}, createdAt: "2026-07-13T11:28:01.000Z" },
			}),
		).rejects.toThrow("injected final outbox failure");
		expect(boundaries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(await postgresDurableSnapshot(isolated.pool, transitionRun.runId)).toEqual(transitionBefore);

		failKind = "run_cancel";
		boundaries.length = 0;
		const cancelRun = await runState("run-cancel-fault");
		const cancelBefore = await postgresDurableSnapshot(isolated.pool, cancelRun.runId);
		await expect(
			faulting.commitAgentV2RunCancel({
				clientId: "client-a",
				runId: cancelRun.runId,
				expectedStatuses: ["queued"],
				expectedRun: expectedRunOf(cancelRun),
				queueName: "agent-v2",
				cancelToken: "fault-token",
				cancelledAt: "2026-07-13T11:28:02.000Z",
			}),
		).rejects.toThrow("injected final outbox failure");
		expect(boundaries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(await postgresDurableSnapshot(isolated.pool, cancelRun.runId)).toEqual(cancelBefore);

		failKind = "live_event";
		boundaries.length = 0;
		const executionRun = await runState("run-execution-fault");
		const executionBefore = await postgresDurableSnapshot(isolated.pool, executionRun.runId);
		await expect(
			faulting.commitAgentV2ExecutionMutation({
				clientId: "client-a",
				runId: executionRun.runId,
				expectedRun: expectedRunOf(executionRun),
				expectedTasks: [],
				updatedAt: "2026-07-13T11:28:03.000Z",
				tasks: [],
				events: [{ type: "execution_progress", payload: {}, createdAt: "2026-07-13T11:28:03.000Z" }],
			}),
		).rejects.toThrow("injected final outbox failure");
		expect(boundaries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(await postgresDurableSnapshot(isolated.pool, executionRun.runId)).toEqual(executionBefore);

		failKind = "diagnostic-live";
		boundaries.length = 0;
		const diagnosticBefore = await postgresDurableSnapshot(isolated.pool, "run-diagnostic-fault");
		await expect(
			faulting.commitAgentV2Diagnostic({
				diagnostic: {
					diagnosticId: "diag-fault",
					clientId: "client-a",
					runId: "run-diagnostic-fault",
					severity: "error",
					category: "worker",
					code: "runtime.fault",
					message: "fault",
					data: {},
					createdAt: "2026-07-13T11:28:04.000Z",
				},
				emitRunEvent: true,
			}),
		).rejects.toThrow("injected final outbox failure");
		expect(boundaries).toEqual(["BEGIN", "ROLLBACK"]);
		expect(await postgresDurableSnapshot(isolated.pool, "run-diagnostic-fault")).toEqual(diagnosticBefore);
	});

	it("enforces cross-run child identity, execution revision consumption and lease generation", async () => {
		const isolated = await createIsolated();
		const store = new PostgresRuntimeStore({ queryable: isolated.pool }) as PostgresRuntimeStore &
			AgentV2DurableCommitStore &
			AgentV2OutboxStore;
		stores.push(store);
		await store.ensureAgentV2Schema();
		const createdAt = "2026-07-13T11:30:00.000Z";
		await store.commitAgentV2RunStart(startInput("run-a", createdAt));
		await store.commitAgentV2RunStart(startInput("run-b", createdAt));
		await store.commitAgentV2RunStart(startInput("run-cancel-semantic", createdAt));
		const run = await store.getAgentV2Run("client-a", "run-a");
		if (!run) throw new Error("expected run");
		const expectedRun = expectedRunOf(run);
		await expect(
			store.commitAgentV2RunTransition({
				expectedRun,
				update: {
					clientId: "client-a",
					runId: "run-a",
					expectedStatuses: ["queued"],
					status: "running",
					updatedAt: "2026-07-13T11:30:01.000Z",
				},
				event: { type: "run_started", payload: {}, createdAt: "2026-07-13T11:30:01.000Z" },
				diagnostic: {
					diagnosticId: "diag-cross",
					clientId: "client-a",
					runId: "run-b",
					severity: "error",
					category: "worker",
					code: "runtime.cross",
					message: "cross",
					data: {},
					createdAt: "2026-07-13T11:30:01.000Z",
				},
			}),
		).rejects.toThrow("identity mismatch");
		expect((await store.getAgentV2Run("client-a", "run-a"))?.status).toBe("queued");
		expect(await store.listAgentV2Diagnostics("client-a", "run-b")).toEqual([]);

		const mutation = {
			clientId: "client-a",
			runId: "run-a",
			expectedRun,
			expectedTasks: [],
			updatedAt: "2026-07-13T11:30:02.000Z",
			tasks: [],
			events: [{ type: "execution_progress", payload: {}, createdAt: "2026-07-13T11:30:02.000Z" }],
		};
		expect((await store.commitAgentV2ExecutionMutation(mutation)).applied).toBe(true);
		expect((await store.commitAgentV2ExecutionMutation(mutation)).applied).toBe(false);
		const cancellable = await store.getAgentV2Run("client-a", "run-cancel-semantic");
		if (!cancellable) throw new Error("expected cancellable run");
		const cancel = {
			clientId: "client-a",
			runId: "run-cancel-semantic",
			expectedStatuses: ["queued"] as const,
			expectedRun: expectedRunOf(cancellable),
			queueName: "agent-v2",
			cancelToken: "semantic-token",
			cancelledAt: "2026-07-13T11:30:03.000Z",
			reason: "user request",
		};
		expect((await store.commitAgentV2RunCancel(cancel)).replayed).toBe(false);
		expect((await store.commitAgentV2RunCancel(cancel)).replayed).toBe(true);
		await expect(store.commitAgentV2RunCancel({ ...cancel, reason: "different" })).rejects.toThrow("replay conflict");

		const leased1 = (
			await store.leaseAgentV2Outbox({
				ownerId: "stable-owner",
				limit: 1,
				now: "2026-07-13T11:31:00.000Z",
				leaseTtlMs: 1000,
			})
		)[0]!;
		const leased2 = (
			await store.leaseAgentV2Outbox({
				ownerId: "stable-owner",
				limit: 1,
				now: "2026-07-13T11:31:01.000Z",
				leaseTtlMs: 1000,
			})
		)[0]!;
		expect(leased2.intentId).toBe(leased1.intentId);
		expect(
			await store.markAgentV2OutboxDelivered({
				intentId: leased1.intentId,
				ownerId: "stable-owner",
				leaseAttempt: leased1.attemptCount,
				deliveredAt: "2026-07-13T11:31:01.100Z",
			}),
		).toBe("lease_lost");
		expect(
			await store.rescheduleAgentV2Outbox({
				intentId: leased1.intentId,
				ownerId: "stable-owner",
				leaseAttempt: leased1.attemptCount,
				availableAt: "2026-07-13T11:31:02.000Z",
				errorCode: "stale",
				errorMessage: "stale",
				maxAttempts: 3,
				updatedAt: "2026-07-13T11:31:01.200Z",
			}),
		).toBe("lease_lost");
	});
});

async function createIsolated(): Promise<PostgresTestSchema> {
	const isolated = await createPostgresTestSchema();
	schemas.push(isolated);
	return isolated;
}

function startInput(
	runId: string,
	createdAt: string,
): {
	run: {
		clientId: string;
		runId: string;
		input: { prompt: string };
		model: { provider: string };
		createdAt: string;
		updatedAt: string;
	};
	bootstrapVersion: string;
	bootstrapChecksum: string;
	inputBlobs: import("../src/agent-v2-durable-store.js").AgentV2InputBlobRecord[];
	inputReferences: import("../src/agent-v2-durable-store.js").AgentV2InputReferenceRecord[];
	readyPhase: "implementation";
	documents: [];
	tasks: [];
	artifacts: [];
	diagnostics: [];
	queueName: string;
	createdAt: string;
} {
	return {
		run: {
			clientId: "client-a",
			runId,
			input: { prompt: runId },
			model: { provider: "test" },
			createdAt,
			updatedAt: createdAt,
		},
		bootstrapVersion: "1",
		bootstrapChecksum: `bootstrap-${runId}`,
		inputBlobs: [],
		inputReferences: [],
		readyPhase: "implementation" as const,
		documents: [],
		tasks: [],
		artifacts: [],
		diagnostics: [],
		queueName: "agent-v2",
		createdAt,
	};
}

function expectedRunOf(run: NonNullable<Awaited<ReturnType<PostgresRuntimeStore["getAgentV2Run"]>>>) {
	return {
		status: run.status,
		phase: run.phase,
		attempt: run.attempt,
		workerId: run.workerId ?? null,
		updatedAt: run.updatedAt,
	};
}

async function postgresDurableSnapshot(queryable: Queryable, runId: string): Promise<Record<string, unknown>> {
	const tables = [
		"agent_v2_runs",
		"agent_v2_bootstraps",
		"agent_v2_run_events",
		"agent_v2_outbox",
		"agent_v2_diagnostics",
		"agent_v2_artifacts",
		"agent_v2_validation_attempts",
		"agent_v2_tasks",
	] as const;
	const snapshot: Record<string, unknown> = {};
	for (const table of tables) {
		const result = await queryable.query(
			`SELECT COALESCE(jsonb_agg(to_jsonb(row_data) ORDER BY to_jsonb(row_data)::text), '[]'::jsonb) AS rows
			FROM (SELECT * FROM ${table} WHERE client_id=$1 AND run_id=$2) AS row_data`,
			["client-a", runId],
		);
		snapshot[table] = (result.rows[0] as { rows: unknown } | undefined)?.rows ?? [];
	}
	return snapshot;
}
