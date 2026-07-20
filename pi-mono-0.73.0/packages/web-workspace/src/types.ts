import type { IncomingMessage } from "node:http";
import type { BuildRunnerFailureCode } from "./build-runner.js";
import type { ContainerBuildRunnerConfig } from "./ephemeral-container-build-runner.js";

export type JsonObject = Record<string, unknown>;

export type RunStatus = "queued" | "running" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted";

export interface RuntimeSessionRecord extends JsonObject {
	sessionId: string;
	clientId: string;
	title: string;
	model: JsonObject;
	thinkingLevel: string;
	createdAt: string;
	updatedAt: string;
	lastRunStatus?: RunStatus;
	lastRunId?: string;
}

export interface RuntimeMessageRecord extends JsonObject {
	messageId: number;
	sessionId: string;
	clientId: string;
	role: string;
	payload: JsonObject;
	createdAt: string;
}

export interface RuntimeRunRecord extends JsonObject {
	runId: string;
	sessionId: string;
	clientId: string;
	status: RunStatus;
	workerId?: string;
	model: JsonObject;
	thinkingLevel: string;
	startedAt?: string;
	updatedAt: string;
	endedAt?: string;
	error?: string;
}

export interface RuntimeRunEventRecord extends JsonObject {
	eventId: number;
	runId: string;
	sessionId: string;
	clientId: string;
	seq: number;
	type: string;
	payload: JsonObject;
	createdAt: string;
}

export type AppPreviewGoalSource = "pm_handoff" | "manual";

export type AppPreviewGoalStatus =
	| "active"
	| "preview_ready"
	| "disabled"
	| "blocked"
	| "failed"
	| "cancelled"
	| "budget_limited";

export type AppPreviewGoalEventType =
	| "goal_started"
	| "goal_disabled"
	| "retry_scheduled"
	| "retry_exhausted"
	| "continuation_scheduled"
	| "preview_check_failed"
	| "preview_ready"
	| "budget_limited"
	| "blocked"
	| "queue_unavailable";

export interface AppPreviewGoalRecord extends JsonObject {
	goalId: string;
	clientId: string;
	sessionId: string;
	source: AppPreviewGoalSource;
	status: AppPreviewGoalStatus;
	maxContinuationRuns: number;
	continuationRunsUsed: number;
	retryAttemptsUsed: number;
	lastRunId?: string;
	lastPreviewUrl?: string;
	lastFailureReason?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
}

export interface AppPreviewGoalEventRecord extends JsonObject {
	eventId: number;
	goalId: string;
	clientId: string;
	sessionId: string;
	runId?: string;
	eventType: AppPreviewGoalEventType;
	reasonCode?: string;
	payload: JsonObject;
	createdAt: string;
}

export interface StartRunResult extends JsonObject {
	session: RuntimeSessionRecord;
	message?: RuntimeMessageRecord;
	run: RuntimeRunRecord;
}

export interface RuntimeActiveRunRestore extends JsonObject {
	run: RuntimeRunRecord;
	checkpointEvent?: RuntimeRunEventRecord;
	afterSeq: number;
}

export interface RuntimeSessionDetail extends JsonObject {
	session: RuntimeSessionRecord;
	messages: RuntimeMessageRecord[];
	runs: RuntimeRunRecord[];
	activeRun?: RuntimeActiveRunRestore;
}

export interface CreateSessionInput extends JsonObject {
	sessionId: string;
	clientId: string;
	title: string;
	model: JsonObject;
	thinkingLevel: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface AppendMessageInput extends JsonObject {
	sessionId: string;
	clientId: string;
	role: string;
	payload: JsonObject;
	createdAt?: string;
}

export interface CreateRunInput extends JsonObject {
	runId: string;
	sessionId: string;
	clientId: string;
	model: JsonObject;
	thinkingLevel: string;
	createdAt?: string;
}

export interface RunStatusPatch extends JsonObject {
	workerId?: string;
	startedAt?: string;
	endedAt?: string;
	error?: string;
	updatedAt?: string;
}

export interface AppendRunEventInput extends JsonObject {
	runId: string;
	sessionId: string;
	clientId: string;
	seq?: number;
	type: string;
	payload: JsonObject;
	createdAt?: string;
}

export interface UpsertAppPreviewGoalInput extends JsonObject {
	goalId: string;
	clientId: string;
	sessionId: string;
	source: AppPreviewGoalSource;
	status: AppPreviewGoalStatus;
	maxContinuationRuns: number;
	continuationRunsUsed: number;
	retryAttemptsUsed: number;
	lastRunId?: string;
	lastPreviewUrl?: string;
	lastFailureReason?: string;
	createdAt?: string;
	updatedAt?: string;
	completedAt?: string;
}

export interface UpdateAppPreviewGoalInput extends JsonObject {
	clientId: string;
	sessionId: string;
	status?: AppPreviewGoalStatus;
	maxContinuationRuns?: number;
	continuationRunsUsed?: number;
	retryAttemptsUsed?: number;
	lastRunId?: string | null;
	lastPreviewUrl?: string | null;
	lastFailureReason?: string | null;
	updatedAt?: string;
	completedAt?: string | null;
}

export interface AppendAppPreviewGoalEventInput extends JsonObject {
	goalId: string;
	clientId: string;
	sessionId: string;
	runId?: string;
	eventType: AppPreviewGoalEventType;
	reasonCode?: string;
	payload?: JsonObject;
	createdAt?: string;
}

export interface AgentV2RuntimeConfig {
	queueName: string;
	eventStreamMaxLen: number;
	eventStreamTtlSeconds: number;
}

export interface StorageConfig {
	settingsFile: string;
	clientsRootDir: string;
	skillsDir: string;
	runtimeDbFile: string;
	redisUrl: string;
	runtimeStore: "postgres" | "sqlite";
	postgresUrl: string;
	agentV2: AgentV2RuntimeConfig;
	workerId: string;
	workerConcurrency: number;
	clientIdRequired: boolean;
	previewBaseUrl: string;
	previewInternalOrigin: string;
	containerBuild: ContainerBuildRunnerConfig;
	defaultModelProvider: string;
	defaultModelId: string;
	handoffDefaultThinkingLevel: string;
	envFile: string;
	envFileExists: boolean;
	logsDbFile: string;
	loggingEnabled: boolean;
	logStdoutEnabled: boolean;
	rawProviderLoggingEnabled: boolean;
	rawProviderLogMaxChars: number;
	promptSnapshotLoggingEnabled: boolean;
	promptSnapshotMaxChars: number;
	modelOutputSnapshotLoggingEnabled: boolean;
	modelOutputSnapshotMaxChars: number;
	modelStreamIdleTimeoutMs: number;
	modelMaxOutputTokens: number;
	contextProviderPayloadBudgetChars: number;
	logRetentionDays: number;
	logMaxEvents: number;
	logCleanupIntervalMs: number;
	logVacuumIntervalMs: number;
	langfuseEnabled: boolean;
	langfuseHost: string;
	langfusePublicKey: string;
	langfuseSecretKey: string;
	langfuseOtelEndpoint: string;
	langfuseFlushIntervalMs: number;
	langfuseBatchSize: number;
	langfuseExportPromptSnapshots: boolean;
	langfuseExportRawChunks: boolean;
	langfuseExportModelOutputSnapshots: boolean;
	otelServiceName: string;
	otelDeploymentEnvironment: string;
}

export type DiagnosticLogLevel = "debug" | "info" | "warn" | "error";

export type DiagnosticLogCategory =
	| "agent"
	| "handoff"
	| "model"
	| "project"
	| "provider"
	| "skill"
	| "storage"
	| "system"
	| "tool";

export interface DiagnosticLogEventInput extends JsonObject {
	timestamp?: string;
	clientId?: string;
	level?: DiagnosticLogLevel;
	category?: DiagnosticLogCategory;
	eventType?: string;
	sessionId?: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	requestId?: string;
	provider?: string;
	model?: string;
	durationMs?: number;
	data?: JsonObject;
}

export interface DiagnosticLogEventRecord extends JsonObject {
	id: number;
	timestamp: string;
	clientId?: string;
	level: DiagnosticLogLevel;
	category: DiagnosticLogCategory;
	eventType: string;
	sessionId?: string;
	traceId?: string;
	spanId?: string;
	parentSpanId?: string;
	requestId?: string;
	provider?: string;
	model?: string;
	durationMs?: number;
	data: JsonObject;
}

export interface DiagnosticLogWriteRequest extends JsonObject {
	events?: DiagnosticLogEventInput[];
}

export interface DiagnosticLogWriteResult extends JsonObject {
	accepted: number;
	dropped: number;
}

export interface DiagnosticLogQuery extends JsonObject {
	clientId?: string;
	sessionId?: string;
	traceId?: string;
	level?: DiagnosticLogLevel;
	category?: DiagnosticLogCategory;
	eventType?: string;
	limit?: number;
}

export interface DiagnosticLogQueryResult extends JsonObject {
	events: DiagnosticLogEventRecord[];
}

export interface DiagnosticLogExportQuery extends DiagnosticLogQuery {
	since?: string;
	until?: string;
	globalOnly?: boolean;
	order?: "asc" | "desc";
	maxEvents?: number;
}

export interface DiagnosticLogExportResult extends JsonObject {
	events: DiagnosticLogEventRecord[];
	total: number;
	exported: number;
	truncated: boolean;
	limit: number;
}

export interface DiagnosticLogStatus extends JsonObject {
	enabled: boolean;
	databaseFile: string;
	eventCount: number;
	rawProviderLoggingEnabled?: boolean;
	rawProviderLogMaxChars?: number;
	promptSnapshotLoggingEnabled?: boolean;
	promptSnapshotMaxChars?: number;
	modelOutputSnapshotLoggingEnabled?: boolean;
	modelOutputSnapshotMaxChars?: number;
	modelStreamIdleTimeoutMs?: number;
	modelMaxOutputTokens?: number;
	contextProviderPayloadBudgetChars?: number;
	logRetentionDays?: number;
	logMaxEvents?: number;
	lastCleanupAt?: string;
	lastVacuumAt?: string;
	langfuseEnabled?: boolean;
	langfuseConfigured?: boolean;
	langfuseHost?: string;
	langfuseOtelEndpoint?: string;
	langfuseQueuedEvents?: number;
	langfuseLastFlushAt?: string;
	langfuseLastError?: string;
	langfuseExportPromptSnapshots?: boolean;
	langfuseExportRawChunks?: boolean;
	langfuseExportModelOutputSnapshots?: boolean;
	otelServiceName?: string;
	otelDeploymentEnvironment?: string;
}

export interface ProjectWorkspaceContext {
	clientId: string;
	sessionId: string;
	title: string;
	projectId: string;
	projectDir: string;
}

export interface ProjectRequestContext {
	clientId?: string;
	sessionId: string;
	title?: string;
}

export interface ProjectFileRequest extends ProjectRequestContext {
	command: "create" | "rewrite" | "update" | "get" | "delete" | "list";
	filename?: string;
	content?: string;
	old_str?: string;
	new_str?: string;
}

export interface ProjectFileResult extends JsonObject {
	command: string;
	filename?: string;
	action?: string;
	content?: string;
	size?: number;
	truncated?: boolean;
	omittedBytes?: number;
	files?: string[];
	fileCount?: number;
	projectRoot?: string;
}

export interface ProjectFilesListResult extends JsonObject {
	projectId: string;
	sessionId: string;
	title: string;
	files: string[];
	fileCount: number;
	projectRoot: string;
}

export interface ProjectFilePreviewRequest extends ProjectRequestContext {
	filename: string;
	maxBytes?: number;
}

export interface ProjectFilePreviewResult extends JsonObject {
	projectId: string;
	sessionId: string;
	title: string;
	filename: string;
	content: string;
	size: number;
	language: string;
	binary: boolean;
	truncated: boolean;
	hash: string;
	projectRoot: string;
}

export interface ProjectFileSaveRequest extends ProjectRequestContext {
	filename: string;
	content: string;
	baseHash: string;
}

export interface ProjectFileSaveResult extends ProjectFilePreviewResult {
	action: "saved";
}

export interface ProjectBashRequest extends ProjectRequestContext {
	command: string;
	timeoutMs?: number;
}

export interface ProjectBashResult extends JsonObject {
	command: string;
	output: string;
	projectRoot: string;
}

export interface ProjectPreviewRequest extends ProjectRequestContext {
	note?: string;
}

export interface ProjectPreviewRenameRequest extends JsonObject {
	title?: string;
}

export interface ProjectPreviewResult extends JsonObject {
	version: number;
	projectId: string;
	clientId?: string;
	sessionId: string;
	title: string;
	status: string;
	mode: "static";
	previewUrl: string;
	projectRoot: string;
	serveRoot: string;
	fileCount: number;
	updatedAt: string;
	logs: string[];
}

export interface ProjectPreviewSummary extends JsonObject {
	projectId: string;
	clientId?: string;
	sessionId: string;
	title: string;
	status: string;
	mode: "static";
	previewUrl: string;
	fileCount: number;
	updatedAt: string;
}

export interface ProjectPreviewListResult extends JsonObject {
	projects: ProjectPreviewSummary[];
}

export type ProjectTaskName = "inspect" | "validate" | "build_static" | "preview" | "logs";

export interface ProjectTaskRequest extends ProjectRequestContext {
	task: ProjectTaskName;
}

export interface ProjectTaskResult extends JsonObject {
	task: ProjectTaskName;
	status: string;
	projectId?: string;
	sessionId?: string;
	title?: string;
	projectRoot?: string;
	fileCount?: number;
	files?: string[];
	hasPackageJson?: boolean;
	valid?: boolean;
	errors?: string[];
	warnings?: string[];
	mode?: "static";
	previewUrl?: string;
	serveRoot?: string;
	logs?: string[];
	failureCode?: BuildRunnerFailureCode;
	updatedAt?: string;
}

export type PreviewRequestLike = Pick<IncomingMessage, "headers">;

export interface ResourceDiagnostic {
	type: "error" | "warning" | "collision";
	message: string;
	path?: string;
	collision?: {
		resourceType: "skill";
		name: string;
		winnerPath: string;
		loserPath: string;
	};
}

export interface SkillSummary extends JsonObject {
	name: string;
	description: string;
	location: string;
	allowImplicitInvocation: boolean;
	interface?: SkillInterfaceMetadata;
}

export interface SkillInterfaceMetadata extends JsonObject {
	displayName?: string;
	shortDescription?: string;
	defaultPrompt?: string;
	iconSmall?: string;
	iconLarge?: string;
	brandColor?: string;
}

export interface SkillListResult extends JsonObject {
	skills: SkillSummary[];
	diagnostics: ResourceDiagnostic[];
}

export interface SkillLoadRequest extends JsonObject {
	name?: string;
}

export interface SkillLoadResult extends SkillSummary {
	content: string;
	resources: SkillResourceSummary[];
}

export interface SkillResourceRequest extends JsonObject {
	name?: string;
	path?: string;
}

export interface SkillResourceSummary extends JsonObject {
	path: string;
	size: number;
}

export interface SkillResourceResult extends JsonObject {
	name: string;
	path: string;
	content: string;
	size: number;
}
