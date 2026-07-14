import { describe, expect, it } from "vitest";
import type { AgentV2DiagnosticEvent } from "../src/agent-v2-diagnostics.js";
import type {
	AgentV2DiagnosticExportStore,
	AgentV2RunApiStore,
	AgentV2WorkerStore,
} from "../src/agent-v2-runtime-store.js";
import type {
	AgentV2ArtifactRecord,
	AgentV2DocumentRecord,
	AgentV2RunEventRecord,
	AgentV2RunUpdateResult,
	AgentV2ValidationRecord,
} from "../src/agent-v2-store.js";
import type { AgentV2RunSnapshot, AgentV2TaskNode } from "../src/agent-v2-types.js";
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

type Expect<T extends true> = T;
type Equal<Left, Right> = (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
	? true
	: false;
type IsRequiredKey<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? false : true;
type _LegacyRuntimeStoreHasNoDurableCommit = Expect<
	Equal<"commitAgentV2RunStart" extends keyof RuntimeStore ? true : false, false>
>;
type _LegacyRuntimeStoreHasNoOutboxLease = Expect<
	Equal<"leaseAgentV2Outbox" extends keyof RuntimeStore ? true : false, false>
>;

type _AgentV2RunApiStoreListsWithClientIdOnly = Expect<
	Equal<Parameters<AgentV2RunApiStore["listAgentV2Runs"]>["length"], 1>
>;
type _AgentV2DiagnosticExportStoreListsWithClientIdOnly = Expect<
	Equal<Parameters<AgentV2DiagnosticExportStore["listAgentV2Runs"]>["length"], 1>
>;
type _AgentV2WorkerStoreListsActiveOwnedRunsWithWorkerIdOnly = Expect<
	Equal<Parameters<AgentV2WorkerStore["listAgentV2RunsByWorker"]>["length"], 1>
>;

type _RuntimeStoreRequiresAppendAgentV2RunEvent = Expect<IsRequiredKey<RuntimeStore, "appendAgentV2RunEvent">>;
type _RuntimeStoreRequiresListAgentV2Runs = Expect<IsRequiredKey<RuntimeStore, "listAgentV2Runs">>;
type _RuntimeStoreRequiresListAgentV2RunsByWorker = Expect<IsRequiredKey<RuntimeStore, "listAgentV2RunsByWorker">>;
type _RuntimeStoreRequiresUpdateAgentV2RunWithResult = Expect<
	IsRequiredKey<RuntimeStore, "updateAgentV2RunWithResult">
>;
type _RuntimeStoreRequiresListAgentV2RunEvents = Expect<IsRequiredKey<RuntimeStore, "listAgentV2RunEvents">>;

describe("runtime store contract", () => {
	it("lets RuntimeDbStore satisfy RuntimeStore", () => {
		const assign = (store: RuntimeStore): RuntimeStore => store;
		expect(typeof assign).toBe("function");
		expect(RuntimeDbStore).toBeDefined();
	});

	it("lets async stores satisfy RuntimeStore", () => {
		const store: RuntimeStore = {
			async ensureSchema() {},
			async ensureAgentV2Schema() {},
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
			async createAgentV2Run() {
				return {} as AgentV2RunSnapshot;
			},
			async getAgentV2Run() {
				return undefined;
			},
			async listAgentV2Runs() {
				return [];
			},
			async listAgentV2RunsByWorker() {
				return [];
			},
			async updateAgentV2Run() {
				return {} as AgentV2RunSnapshot;
			},
			async updateAgentV2RunWithResult() {
				return {} as AgentV2RunUpdateResult;
			},
			async appendAgentV2RunEvent() {
				return {} as AgentV2RunEventRecord;
			},
			async listAgentV2RunEvents() {
				return [];
			},
			async upsertAgentV2Task() {
				return {} as AgentV2TaskNode;
			},
			async listAgentV2Tasks() {
				return [];
			},
			async upsertAgentV2Artifact() {
				return {} as AgentV2ArtifactRecord;
			},
			async listAgentV2Artifacts() {
				return [];
			},
			async upsertAgentV2Document() {
				return {} as AgentV2DocumentRecord;
			},
			async listAgentV2Documents() {
				return [];
			},
			async appendAgentV2ValidationAttempt() {
				return {} as AgentV2ValidationRecord;
			},
			async listAgentV2Validations() {
				return [];
			},
			async getAgentV2Document() {
				return undefined;
			},
			async appendAgentV2Diagnostic() {
				return {} as AgentV2DiagnosticEvent;
			},
			async listAgentV2Diagnostics() {
				return [];
			},
			async resetAgentV2RuntimeData() {
				return {
					agentV2RowsDeleted: {},
					schemaVersion: 2,
				};
			},
			async deleteSession() {
				return false;
			},
		};

		expect(store).toBeDefined();
	});
});
