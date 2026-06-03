import type { IncomingMessage } from "node:http";

export type JsonObject = Record<string, unknown>;

export interface StorageConfig {
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
	skillsDir: string;
	defaultSkillsDir: string;
	previewBaseUrl: string;
	projectInstallCommand: string;
	projectBuildCommand: string;
	projectInstallTimeoutMs: number;
	projectBuildTimeoutMs: number;
	serverSessionSyncEnabled: boolean;
	defaultModelProvider: string;
	defaultModelId: string;
	handoffDefaultThinkingLevel: string;
}

export interface ProjectWorkspaceContext {
	sessionId: string;
	title: string;
	projectId: string;
	projectDir: string;
}

export interface ProjectRequestContext {
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
