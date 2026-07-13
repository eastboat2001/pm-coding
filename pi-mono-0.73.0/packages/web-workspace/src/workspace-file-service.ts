import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, relative } from "node:path";
import { PROJECT_FILE_GET_MAX_BYTES } from "./constants.js";
import type {
	ProjectFilePreviewRequest,
	ProjectFilePreviewResult,
	ProjectFileRequest,
	ProjectFileResult,
	ProjectFileSaveRequest,
	ProjectFileSaveResult,
	ProjectFilesListResult,
	ProjectRequestContext,
	StorageConfig,
} from "./types.js";
import {
	type AuthorizedWorkspacePath,
	WorkspacePathAuthorizationError,
	WorkspacePathGuard,
} from "./workspace-path-guard.js";
import { listProjectSourceFiles, workspaceContext } from "./workspace-paths.js";

export class WorkspaceFileService {
	constructor(private readonly config: StorageConfig) {}

	ensureProjectWorkspace(body: ProjectRequestContext): ProjectFilesListResult {
		const { projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		const files = listProjectSourceFiles(projectDir).map((file) =>
			normalizeProjectFilePath(relative(projectDir, file)),
		);
		return { projectId, sessionId, title, projectRoot: projectDir, files, fileCount: files.length };
	}

	listProjectFiles(body: ProjectRequestContext): ProjectFilesListResult {
		const { projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		const files = listProjectSourceFiles(projectDir).map((file) =>
			normalizeProjectFilePath(relative(projectDir, file)),
		);
		return { projectId, sessionId, title, projectRoot: projectDir, files, fileCount: files.length };
	}

	readProjectFilePreview(body: ProjectFilePreviewRequest): ProjectFilePreviewResult {
		const { projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		const authorized = WorkspacePathGuard.forProjectContent(projectDir).authorizeExisting(
			String(body.filename || "").trim(),
			"file",
		);
		const stat = statSync(authorized.absolutePath);

		const maxBytes = normalizePreviewMaxBytes(body.maxBytes);
		const bytesToRead = Math.min(stat.size, maxBytes);
		const buffer = bytesToRead > 0 ? readFilePrefix(authorized.absolutePath, bytesToRead) : Buffer.alloc(0);
		const binary = isProbablyBinary(buffer);
		const content = binary ? "" : buffer.toString("utf8");
		const filename = normalizeProjectFilePath(authorized.relativePath);
		return {
			projectId,
			sessionId,
			title,
			filename,
			content,
			size: stat.size,
			language: languageForFilename(filename),
			binary,
			truncated: stat.size > bytesToRead,
			hash: fileHash(authorized.absolutePath),
			projectRoot: projectDir,
		};
	}

	saveProjectFile(body: ProjectFileSaveRequest): ProjectFileSaveResult {
		const { projectDir } = workspaceContext(this.config, body);
		const filename = String(body.filename || "").trim();
		const content = body.content;
		const baseHash = String(body.baseHash || "").trim();
		if (!filename) throw new Error("Field `filename` is required.");
		if (typeof content !== "string") throw new Error("Field `content` is required.");
		if (!baseHash) throw new Error("Field `baseHash` is required.");
		if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_SAVE_MAX_BYTES) {
			throw new Error(`File content exceeds the ${PROJECT_FILE_SAVE_MAX_BYTES} byte save limit.`);
		}

		const authorized = WorkspacePathGuard.forProjectContent(projectDir).authorizeExisting(filename, "file");
		const stat = statSync(authorized.absolutePath);
		const currentPrefix =
			stat.size > 0
				? readFilePrefix(authorized.absolutePath, Math.min(stat.size, DEFAULT_PROJECT_FILE_PREVIEW_MAX_BYTES))
				: Buffer.alloc(0);
		if (isProbablyBinary(currentPrefix))
			throw new Error(`Cannot edit binary file: ${normalizeProjectFilePath(authorized.relativePath)}`);
		const currentHash = fileHash(authorized.absolutePath);
		if (currentHash !== baseHash) throw new Error("File has changed since it was opened. Reload before saving.");

		writeFileSync(authorized.absolutePath, content, "utf8");
		return { ...this.readProjectFilePreview(body), action: "saved" };
	}

	handle(body: ProjectFileRequest): ProjectFileResult {
		const { projectDir } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });

		const command = String(body.command || "").trim();
		const filename = String(body.filename || "").trim();

		if (command === "list") {
			const files = listProjectSourceFiles(projectDir).map((file) => file.slice(projectDir.length + 1));
			return { command, projectRoot: projectDir, files, fileCount: files.length };
		}

		if (!filename) throw new Error("Field `filename` is required.");
		const guard = WorkspacePathGuard.forProjectContent(projectDir);

		if (command === "get") {
			const readableFile = authorizeReadableProjectFile(guard, filename);
			const stat = statSync(readableFile.absolutePath);
			const bytesToRead = Math.min(stat.size, PROJECT_FILE_GET_MAX_BYTES);
			const content = bytesToRead > 0 ? readFilePrefix(readableFile.absolutePath, bytesToRead).toString("utf8") : "";
			const truncated = stat.size > bytesToRead;
			return {
				command,
				filename: normalizeProjectFilePath(readableFile.relativePath),
				content,
				size: stat.size,
				...(truncated ? { truncated, omittedBytes: stat.size - bytesToRead } : { truncated: false }),
				projectRoot: projectDir,
			};
		}

		if (command === "delete") {
			const authorized = guard.authorizeExisting(filename, "file");
			rmSync(authorized.absolutePath, { force: true });
			return {
				command,
				filename: normalizeProjectFilePath(authorized.relativePath),
				action: "deleted",
				projectRoot: projectDir,
			};
		}

		if (command === "create" || command === "rewrite") {
			if (typeof body.content !== "string") throw new Error("Field `content` is required.");
			const { authorized, existed } =
				command === "create" ? authorizeCreate(guard, filename) : authorizeRewrite(guard, filename);
			mkdirSync(dirname(authorized.absolutePath), { recursive: true });
			writeFileSync(authorized.absolutePath, body.content, "utf8");
			return {
				command,
				filename: normalizeProjectFilePath(authorized.relativePath),
				action: existed ? "updated" : "created",
				projectRoot: projectDir,
				fileCount: listProjectSourceFiles(projectDir).length,
			};
		}

		if (command === "update") {
			const authorized = guard.authorizeExisting(filename, "file");
			const relativePath = normalizeProjectFilePath(authorized.relativePath);
			const oldStr = String(body.old_str ?? "");
			const newStr = String(body.new_str ?? "");
			if (!oldStr) throw new Error("Field `old_str` is required for update.");
			const current = readFileSync(authorized.absolutePath, "utf8");
			const firstMatchIndex = current.indexOf(oldStr);
			if (firstMatchIndex === -1) throw new Error(`old_str was not found in ${relativePath}.`);
			if (current.indexOf(oldStr, firstMatchIndex + 1) !== -1) {
				throw new Error(
					`old_str must match exactly one location in ${relativePath}. Use a longer old_str context or rewrite the file.`,
				);
			}
			writeFileSync(
				authorized.absolutePath,
				`${current.slice(0, firstMatchIndex)}${newStr}${current.slice(firstMatchIndex + oldStr.length)}`,
				"utf8",
			);
			return { command, filename: relativePath, action: "updated", projectRoot: projectDir };
		}

		throw new Error(`Unsupported workspace file command: ${command}`);
	}
}

const DEFAULT_PROJECT_FILE_PREVIEW_MAX_BYTES = 512 * 1024;
const PROJECT_FILE_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_FILE_SAVE_MAX_BYTES = 2 * 1024 * 1024;

function normalizeProjectFilePath(path: string): string {
	return path.replace(/\\/g, "/");
}

function authorizeReadableProjectFile(guard: WorkspacePathGuard, path: string): AuthorizedWorkspacePath {
	try {
		return guard.authorizeExisting(path, "file");
	} catch (error) {
		if (!(error instanceof WorkspacePathAuthorizationError) || error.code !== "path_missing") throw error;
		for (const candidate of attachmentAliasCandidates(path)) {
			try {
				return guard.authorizeExisting(candidate, "file");
			} catch (candidateError) {
				if (
					!(candidateError instanceof WorkspacePathAuthorizationError) ||
					candidateError.code !== "path_missing"
				) {
					throw candidateError;
				}
			}
		}
		throw error;
	}
}

function authorizeRewrite(
	guard: WorkspacePathGuard,
	path: string,
): { authorized: AuthorizedWorkspacePath; existed: boolean } {
	try {
		return { authorized: guard.authorizeExisting(path, "file"), existed: true };
	} catch (error) {
		if (!(error instanceof WorkspacePathAuthorizationError) || error.code !== "path_missing") throw error;
		return { authorized: guard.authorizeNew(path), existed: false };
	}
}

function authorizeCreate(
	guard: WorkspacePathGuard,
	path: string,
): { authorized: AuthorizedWorkspacePath; existed: boolean } {
	const authorized = guard.authorizeNew(path);
	return { authorized, existed: existsSync(authorized.absolutePath) };
}

function attachmentAliasCandidates(relativePath: string): string[] {
	const normalized = normalizeProjectFilePath(relativePath);
	if (!normalized || normalized.includes("/")) return [];
	const candidates = [`attachments/${normalized}`];
	const dotIndex = normalized.lastIndexOf(".");
	if (dotIndex > 0) {
		const base = normalized.slice(0, dotIndex);
		candidates.push(`attachments/${base}.md`);
	}
	return Array.from(new Set(candidates));
}

function normalizePreviewMaxBytes(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROJECT_FILE_PREVIEW_MAX_BYTES;
	return Math.min(Math.floor(parsed), PROJECT_FILE_PREVIEW_MAX_BYTES);
}

function readFilePrefix(path: string, bytesToRead: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0);
		return bytesRead === bytesToRead ? buffer : buffer.subarray(0, bytesRead);
	} finally {
		closeSync(fd);
	}
}

function isProbablyBinary(buffer: Buffer): boolean {
	return buffer.includes(0);
}

function fileHash(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function languageForFilename(filename: string): string {
	const extension = extname(filename).toLowerCase().slice(1);
	const languages: Record<string, string> = {
		cjs: "javascript",
		css: "css",
		html: "html",
		js: "javascript",
		json: "json",
		jsx: "javascript",
		md: "markdown",
		mjs: "javascript",
		ts: "typescript",
		tsx: "typescript",
		txt: "text",
		vue: "vue",
		xml: "xml",
		yaml: "yaml",
		yml: "yaml",
	};
	return languages[extension] || extension || "text";
}
