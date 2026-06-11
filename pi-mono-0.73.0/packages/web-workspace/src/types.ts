import type { IncomingMessage } from "node:http";

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

export interface StartRunRequest extends JsonObject {
	sessionId?: string;
	title?: string;
	message?: JsonObject;
	model?: JsonObject;
	thinkingLevel?: string;
	projectFiles?: StartRunProjectFile[];
}

export interface StartRunProjectFile extends JsonObject {
	filename: string;
	content: string;
}

export interface StartRunResult extends JsonObject {
	session: RuntimeSessionRecord;
	message?: RuntimeMessageRecord;
	run: RuntimeRunRecord;
}

export interface RuntimeSessionDetail extends JsonObject {
	session: RuntimeSessionRecord;
	messages: RuntimeMessageRecord[];
	runs: RuntimeRunRecord[];
}

export interface DeleteSessionResult extends JsonObject {
	deleted: boolean;
	sessionId: string;
	cancelledRuns?: number;
}

export interface RuntimeSessionListResult extends JsonObject {
	sessions: RuntimeSessionRecord[];
}

export interface RuntimeRunListResult extends JsonObject {
	runs: RuntimeRunRecord[];
}

export interface RuntimeRunEventListResult extends JsonObject {
	events: RuntimeRunEventRecord[];
}

export interface WorkerAgentInput extends JsonObject {
	run: RuntimeRunRecord;
	session: RuntimeSessionRecord;
	messages: RuntimeMessageRecord[];
	model: JsonObject;
	thinkingLevel: string;
	projectContext?: ProjectWorkspaceContext;
	signal?: AbortSignal;
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
	type: string;
	payload: JsonObject;
	createdAt?: string;
}

export interface StorageConfig {
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
	skillsDir: string;
	defaultSkillsDir: string;
	runtimeDbFile: string;
	redisUrl: string;
	runsEnabled: boolean;
	workerId: string;
	workerConcurrency: number;
	runQueueName: string;
	runEventRetentionDays: number;
	clientIdRequired: boolean;
	previewBaseUrl: string;
	projectInstallCommand: string;
	projectBuildCommand: string;
	projectInstallTimeoutMs: number;
	projectBuildTimeoutMs: number;
	serverSessionSyncEnabled: boolean;
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
	clientId?: string;
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
	mode?: "static";
	previewUrl?: string;
	serveRoot?: string;
	logs?: string[];
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
	disableModelInvocation: boolean;
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
	defaultSkills: SkillSummary[];
	promptSkills: SkillSummary[];
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
