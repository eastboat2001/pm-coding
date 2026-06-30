import { describe, expect, it } from "vitest";
import { RuntimeDbStore } from "../src/runtime-db.js";
import type { RuntimeStore } from "../src/runtime-store.js";
import type {
	AppPreviewGoalEventRecord,
	AppPreviewGoalRecord,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionRecord,
	StartRunResult,
} from "../src/types.js";

describe("runtime store contract", () => {
	it("lets RuntimeDbStore satisfy RuntimeStore", () => {
		const assign = (store: RuntimeStore): RuntimeStore => store;
		expect(typeof assign).toBe("function");
		expect(RuntimeDbStore).toBeDefined();
	});

	it("lets async stores satisfy RuntimeStore", () => {
		const store: RuntimeStore = {
			async ensureSchema() {},
			async close() {},
			async upsertClient() {},
			async createSession() {
				return {} as RuntimeSessionRecord;
			},
			async listSessions() {
				return [];
			},
			async getSession() {
				return undefined;
			},
			async updateSessionTitle() {
				return undefined;
			},
			async appendMessage() {
				return {} as RuntimeMessageRecord;
			},
			async listMessages() {
				return [];
			},
			async getSessionMessageStats() {
				return { messageCount: 0, totalPayloadBytes: 0, largestPayloadBytes: 0 };
			},
			async *iterateMessages() {},
			async getRun() {
				return undefined;
			},
			async getRunById() {
				return undefined;
			},
			async listRuns() {
				return [];
			},
			async listRunsForSession() {
				return [];
			},
			async listRunsByStatus() {
				return [];
			},
			async listRunningRunsByWorker() {
				return [];
			},
			async createRun() {
				return {} as RuntimeRunRecord;
			},
			async createContinuationRun() {
				return undefined;
			},
			async createRunWithMessage() {
				return undefined as StartRunResult | undefined;
			},
			async updateRunStatus() {
				return {} as RuntimeRunRecord;
			},
			async appendRunEvent() {
				return {} as RuntimeRunEventRecord;
			},
			async listRunEvents() {
				return [];
			},
			async *iterateRunEvents() {},
			async getLatestRunCheckpoint() {
				return undefined;
			},
			async upsertAppPreviewGoal() {
				return {} as AppPreviewGoalRecord;
			},
			async getAppPreviewGoal() {
				return undefined;
			},
			async updateAppPreviewGoal() {
				return undefined;
			},
			async appendAppPreviewGoalEvent() {
				return {} as AppPreviewGoalEventRecord;
			},
			async listAppPreviewGoalEvents() {
				return [];
			},
			async deleteSession() {
				return false;
			},
		};

		expect(store).toBeDefined();
	});
});
