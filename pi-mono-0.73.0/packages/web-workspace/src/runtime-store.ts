import type {
	AgentV2DiagnosticEvent,
} from "./agent-v2-diagnostics.js";
import type {
	AgentV2RunSnapshot,
	AgentV2TaskNode,
} from "./agent-v2-types.js";
import type {
	AppendAppPreviewGoalEventInput,
	AppendMessageInput,
	AppendRunEventInput,
	AppPreviewGoalEventRecord,
	AppPreviewGoalRecord,
	CreateRunInput,
	CreateSessionInput,
	JsonObject,
	RunStatus,
	RunStatusPatch,
	RuntimeMessageRecord,
	RuntimeRunEventRecord,
	RuntimeRunRecord,
	RuntimeSessionDetail,
	RuntimeSessionRecord,
	StartRunResult,
	UpdateAppPreviewGoalInput,
	UpsertAppPreviewGoalInput,
} from "./types.js";
import type {
	AgentV2ArtifactRecord,
	CreateAgentV2RunInput as CreateAgentV2RunInputFromStore,
	UpdateAgentV2RunInput as UpdateAgentV2RunInputFromStore,
	UpsertAgentV2ArtifactInput as UpsertAgentV2ArtifactInputFromStore,
	UpsertAgentV2TaskInput as UpsertAgentV2TaskInputFromStore,
} from "./agent-v2-store.js";

export interface ActiveRunRestore extends JsonObject {
	run: RuntimeRunRecord;
	session: RuntimeSessionRecord;
	messages: RuntimeMessageRecord[];
	latestCheckpoint?: RuntimeRunEventRecord;
}

export interface RuntimeSessionRestoreDetail extends RuntimeSessionDetail {
	activeRuns: ActiveRunRestore[];
}

export interface CreateRunWithMessageInput extends JsonObject {
	sessionId: string;
	clientId: string;
	title: string;
	model: JsonObject;
	thinkingLevel: string;
	messageRole: string;
	payload: JsonObject;
	runId: string;
	createdAt?: string;
}

export type MaybePromise<T> = T | Promise<T>;
export type MaybeAsyncIterable<T> = Iterable<T> | AsyncIterable<T>;

export interface RuntimeStore {
	ensureSchema(): MaybePromise<void>;
	ensureAgentV2Schema(): MaybePromise<void>;
	close(): MaybePromise<void>;
	upsertClient(clientId: string): MaybePromise<void>;
	createSession(input: CreateSessionInput): MaybePromise<RuntimeSessionRecord>;
	listSessions(clientId: string): MaybePromise<RuntimeSessionRecord[]>;
	getSession(clientId: string, sessionId: string): MaybePromise<RuntimeSessionRecord | undefined>;
	updateSessionTitle(
		clientId: string,
		sessionId: string,
		title: string,
	): MaybePromise<RuntimeSessionRecord | undefined>;
	appendMessage(input: AppendMessageInput): MaybePromise<RuntimeMessageRecord>;
	listMessages(clientId: string, sessionId: string): MaybePromise<RuntimeMessageRecord[]>;
	getSessionMessageStats(
		clientId: string,
		sessionId: string,
	): MaybePromise<{ messageCount: number; totalPayloadBytes: number; largestPayloadBytes: number }>;
	iterateMessages(clientId: string, sessionId: string): MaybePromise<MaybeAsyncIterable<RuntimeMessageRecord>>;
	getRun(clientId: string, runId: string): MaybePromise<RuntimeRunRecord | undefined>;
	getRunById(runId: string): MaybePromise<RuntimeRunRecord | undefined>;
	listRuns(clientId: string): MaybePromise<RuntimeRunRecord[]>;
	listRunsForSession(clientId: string, sessionId: string): MaybePromise<RuntimeRunRecord[]>;
	listRunsByStatus(status: RunStatus, workerId?: string): MaybePromise<RuntimeRunRecord[]>;
	listRunningRunsByWorker(workerId: string): MaybePromise<RuntimeRunRecord[]>;
	createRun(input: CreateRunInput): MaybePromise<RuntimeRunRecord>;
	createContinuationRun(input: CreateRunInput): MaybePromise<RuntimeRunRecord | undefined>;
	createRunWithMessage(input: CreateRunWithMessageInput): MaybePromise<StartRunResult | undefined>;
	updateRunStatus(
		runId: string,
		clientId: string,
		status: RunStatus,
		patch?: RunStatusPatch,
	): MaybePromise<RuntimeRunRecord>;
	appendRunEvent(input: AppendRunEventInput): MaybePromise<RuntimeRunEventRecord>;
	listRunEvents(clientId: string, runId: string, afterSeq: number): MaybePromise<RuntimeRunEventRecord[]>;
	iterateRunEvents(
		clientId: string,
		runId: string,
		afterSeq: number,
	): MaybePromise<MaybeAsyncIterable<RuntimeRunEventRecord>>;
	getLatestRunCheckpoint(clientId: string, runId: string): MaybePromise<RuntimeRunEventRecord | undefined>;
	upsertAppPreviewGoal(input: UpsertAppPreviewGoalInput): MaybePromise<AppPreviewGoalRecord>;
	getAppPreviewGoal(clientId: string, sessionId: string): MaybePromise<AppPreviewGoalRecord | undefined>;
	updateAppPreviewGoal(input: UpdateAppPreviewGoalInput): MaybePromise<AppPreviewGoalRecord | undefined>;
	appendAppPreviewGoalEvent(input: AppendAppPreviewGoalEventInput): MaybePromise<AppPreviewGoalEventRecord>;
	listAppPreviewGoalEvents(
		clientId: string,
		sessionId: string,
		afterEventId: number,
	): MaybePromise<AppPreviewGoalEventRecord[]>;
	createAgentV2Run(input: CreateAgentV2RunInputFromStore): MaybePromise<AgentV2RunSnapshot>;
	getAgentV2Run(clientId: string, runId: string): MaybePromise<AgentV2RunSnapshot | undefined>;
	updateAgentV2Run(input: UpdateAgentV2RunInputFromStore): MaybePromise<AgentV2RunSnapshot>;
	upsertAgentV2Task(input: UpsertAgentV2TaskInputFromStore): MaybePromise<AgentV2TaskNode>;
	listAgentV2Tasks(clientId: string, runId: string): MaybePromise<AgentV2TaskNode[]>;
	upsertAgentV2Artifact(input: UpsertAgentV2ArtifactInputFromStore): MaybePromise<AgentV2ArtifactRecord>;
	listAgentV2Artifacts(clientId: string, runId: string): MaybePromise<AgentV2ArtifactRecord[]>;
	appendAgentV2Diagnostic(input: AgentV2DiagnosticEvent): MaybePromise<AgentV2DiagnosticEvent>;
	listAgentV2Diagnostics(clientId: string, runId: string): MaybePromise<AgentV2DiagnosticEvent[]>;
	deleteSession(clientId: string, sessionId: string): MaybePromise<boolean>;
}
