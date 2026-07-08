import { createHash } from "node:crypto";
import { extname } from "node:path";
import { createAgentV2ToolFailure } from "./agent-v2-tool-governance.js";
import type { AgentV2ArtifactRecord } from "./agent-v2-store.js";
import type { StorageConfig } from "./types.js";
import { WorkspaceFileService } from "./workspace-file-service.js";

export interface AgentV2FileAdapterContext {
	clientId: string;
	sessionId: string;
	title: string;
}

export interface CreateAgentV2FileAdapterInput {
	config: StorageConfig;
	context: AgentV2FileAdapterContext;
	files?: WorkspaceFileService;
}

export type AgentV2FileWriteMode = "create" | "rewrite";

export interface AgentV2FileArtifactCandidate
	extends Omit<AgentV2ArtifactRecord, "clientId" | "runId" | "createdAt" | "updatedAt"> {}

export interface AgentV2FileWriteResult {
	path: string;
	action: "created" | "updated";
	artifact: AgentV2FileArtifactCandidate;
}

export interface AgentV2FileAdapter {
	listFiles(): { files: string[] };
	readFile(path: string): { path: string; content: string; truncated: boolean };
	writeFile(input: {
		path: string;
		content: string;
		mode: AgentV2FileWriteMode;
		taskId: string;
		now: string;
	}): AgentV2FileWriteResult;
	patchFile(input: {
		path: string;
		oldText: string;
		newText: string;
		taskId: string;
		now: string;
	}): AgentV2FileWriteResult;
}

export function createAgentV2FileAdapter(input: CreateAgentV2FileAdapterInput): AgentV2FileAdapter {
	const files = input.files ?? new WorkspaceFileService(input.config);
	const context = {
		clientId: input.context.clientId,
		sessionId: input.context.sessionId,
		title: input.context.title,
	};

	const artifactFor = (path: string, content: string, taskId: string): AgentV2FileArtifactCandidate => ({
		artifactId: `file:${path}`,
		kind: "source",
		path,
		mediaType: mediaTypeForPath(path),
		checksum: `sha256:${createHash("sha256").update(content).digest("hex")}`,
		version: "v2",
		sourceTaskId: taskId,
		validationStatus: "not_started",
		metadataJson: {},
	});

	const mapError = (error: unknown, path?: string): never => {
		const message = error instanceof Error ? error.message : String(error);
		if (isPathValidationError(message)) {
			throw new Error(
				JSON.stringify(
					createAgentV2ToolFailure({
						code: "file.path_invalid",
						message,
						retryable: false,
						path,
						data: {},
					}),
				),
			);
		}
		throw error;
	};

	return {
		listFiles() {
			const result = files.handle({ ...context, command: "list" });
			return { files: Array.isArray(result.files) ? result.files : [] };
		},
		readFile(path) {
			try {
				const result = files.handle({ ...context, command: "get", filename: path });
				return {
					path: typeof result.filename === "string" ? result.filename : path,
					content: typeof result.content === "string" ? result.content : "",
					truncated: Boolean(result.truncated),
				};
			} catch (error) {
				return mapError(error, path);
			}
		},
		writeFile(write) {
			try {
				const result = files.handle({
					...context,
					command: write.mode,
					filename: write.path,
					content: write.content,
				});
				const path = typeof result.filename === "string" ? result.filename : write.path;
				return {
					path,
					action: result.action === "created" ? "created" : "updated",
					artifact: artifactFor(path, write.content, write.taskId),
				};
			} catch (error) {
				return mapError(error, write.path);
			}
		},
		patchFile(patch) {
			try {
				const before = this.readFile(patch.path);
				const result = files.handle({
					...context,
					command: "update",
					filename: patch.path,
					old_str: patch.oldText,
					new_str: patch.newText,
				});
				const path = typeof result.filename === "string" ? result.filename : patch.path;
				return {
					path,
					action: "updated",
					artifact: artifactFor(path, before.content.replace(patch.oldText, patch.newText), patch.taskId),
				};
			} catch (error) {
				return mapError(error, patch.path);
			}
		},
	};
}

function isPathValidationError(message: string): boolean {
	return (
		message.includes("Project path component is empty.") ||
		message.includes("Invalid project path component:") ||
		message.includes("Resolved path escapes configured root.")
	);
}

function mediaTypeForPath(path: string): string {
	const extension = extname(path).toLowerCase();
	if (extension === ".html") return "text/html";
	if (extension === ".css") return "text/css";
	if (extension === ".js" || extension === ".mjs") return "text/javascript";
	if (extension === ".json") return "application/json";
	if (extension === ".md") return "text/markdown";
	return "text/plain";
}
