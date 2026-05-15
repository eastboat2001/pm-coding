import type { IncomingMessage } from "node:http";

export type JsonObject = Record<string, unknown>;

export interface StorageConfig {
	sessionsDir: string;
	settingsFile: string;
	projectsRootDir: string;
	previewBaseUrl: string;
	projectInstallCommand: string;
	projectBuildCommand: string;
	projectInstallTimeoutMs: number;
	projectBuildTimeoutMs: number;
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

export interface ProjectPreviewResult extends JsonObject {
	version: number;
	projectId: string;
	sessionId: string;
	title: string;
	status: string;
	previewUrl: string;
	projectRoot: string;
	serveRoot: string;
	fileCount: number;
	updatedAt: string;
	logs: string[];
}

export type PreviewRequestLike = Pick<IncomingMessage, "headers">;
