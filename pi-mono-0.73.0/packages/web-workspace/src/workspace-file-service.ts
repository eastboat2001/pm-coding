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
import { dirname, extname, relative, resolve } from "node:path";
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
	assertInside,
	listProjectSourceFiles,
	migrateLegacyProjectDir,
	removeSiblingProjectDirs,
	safeRelativeProjectPath,
	workspaceContext,
} from "./workspace-paths.js";

export class WorkspaceFileService {
	constructor(private readonly config: StorageConfig) {}

	ensureProjectWorkspace(body: ProjectRequestContext): ProjectFilesListResult {
		const { clientId, projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId, clientId);
		const files = listProjectSourceFiles(projectDir).map((file) =>
			normalizeProjectFilePath(relative(projectDir, file)),
		);
		return { projectId, sessionId, title, projectRoot: projectDir, files, fileCount: files.length };
	}

	listProjectFiles(body: ProjectRequestContext): ProjectFilesListResult {
		const { clientId, projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		const files = listProjectSourceFiles(projectDir).map((file) =>
			normalizeProjectFilePath(relative(projectDir, file)),
		);
		return { projectId, sessionId, title, projectRoot: projectDir, files, fileCount: files.length };
	}

	readProjectFilePreview(body: ProjectFilePreviewRequest): ProjectFilePreviewResult {
		const { clientId, projectDir, projectId, sessionId, title } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		const relativePath = safeRelativeProjectPath(String(body.filename || "").trim());
		const targetPath = resolve(projectDir, relativePath);
		assertInside(projectDir, targetPath);
		if (!existsSync(targetPath)) throw new Error(`File not found: ${normalizeProjectFilePath(relativePath)}`);
		const stat = statSync(targetPath);
		if (!stat.isFile()) throw new Error(`Project path is not a file: ${normalizeProjectFilePath(relativePath)}`);

		const maxBytes = normalizePreviewMaxBytes(body.maxBytes);
		const bytesToRead = Math.min(stat.size, maxBytes);
		const buffer = bytesToRead > 0 ? readFilePrefix(targetPath, bytesToRead) : Buffer.alloc(0);
		const binary = isProbablyBinary(buffer);
		const content = binary ? "" : buffer.toString("utf8");
		const filename = normalizeProjectFilePath(relativePath);
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
			hash: fileHash(targetPath),
			projectRoot: projectDir,
		};
	}

	saveProjectFile(body: ProjectFileSaveRequest): ProjectFileSaveResult {
		const { clientId, projectDir, sessionId } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		const filename = String(body.filename || "").trim();
		const content = body.content;
		const baseHash = String(body.baseHash || "").trim();
		if (!filename) throw new Error("Field `filename` is required.");
		if (typeof content !== "string") throw new Error("Field `content` is required.");
		if (!baseHash) throw new Error("Field `baseHash` is required.");
		if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_SAVE_MAX_BYTES) {
			throw new Error(`File content exceeds the ${PROJECT_FILE_SAVE_MAX_BYTES} byte save limit.`);
		}

		const relativePath = safeRelativeProjectPath(filename);
		const targetPath = resolve(projectDir, relativePath);
		assertInside(projectDir, targetPath);
		if (!existsSync(targetPath)) throw new Error(`File not found: ${normalizeProjectFilePath(relativePath)}`);
		const stat = statSync(targetPath);
		if (!stat.isFile()) throw new Error(`Project path is not a file: ${normalizeProjectFilePath(relativePath)}`);
		const currentPrefix =
			stat.size > 0
				? readFilePrefix(targetPath, Math.min(stat.size, DEFAULT_PROJECT_FILE_PREVIEW_MAX_BYTES))
				: Buffer.alloc(0);
		if (isProbablyBinary(currentPrefix))
			throw new Error(`Cannot edit binary file: ${normalizeProjectFilePath(relativePath)}`);
		const currentHash = fileHash(targetPath);
		if (currentHash !== baseHash) throw new Error("File has changed since it was opened. Reload before saving.");

		writeFileSync(targetPath, content, "utf8");
		return { ...this.readProjectFilePreview(body), action: "saved" };
	}

	handle(body: ProjectFileRequest): ProjectFileResult {
		const { clientId, projectDir, sessionId } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId, clientId);

		const command = String(body.command || "").trim();
		const filename = String(body.filename || "").trim();

		if (command === "list") {
			const files = listProjectSourceFiles(projectDir).map((file) => file.slice(projectDir.length + 1));
			return { command, projectRoot: projectDir, files, fileCount: files.length };
		}

		if (!filename) throw new Error("Field `filename` is required.");
		const relativePath = safeRelativeProjectPath(filename);
		const targetPath = resolve(projectDir, relativePath);
		assertInside(projectDir, targetPath);

		if (command === "get") {
			if (!existsSync(targetPath)) throw new Error(`File not found: ${relativePath}`);
			const stat = statSync(targetPath);
			if (!stat.isFile()) throw new Error(`Project path is not a file: ${relativePath}`);
			const bytesToRead = Math.min(stat.size, PROJECT_FILE_GET_MAX_BYTES);
			const content = bytesToRead > 0 ? readFilePrefix(targetPath, bytesToRead).toString("utf8") : "";
			const truncated = stat.size > bytesToRead;
			return {
				command,
				filename: relativePath,
				content,
				size: stat.size,
				...(truncated ? { truncated, omittedBytes: stat.size - bytesToRead } : { truncated: false }),
				projectRoot: projectDir,
			};
		}

		if (command === "delete") {
			const existed = existsSync(targetPath);
			if (existed) rmSync(targetPath, { force: true });
			return { command, filename: relativePath, action: existed ? "deleted" : "missing", projectRoot: projectDir };
		}

		if (command === "create" || command === "rewrite") {
			if (typeof body.content !== "string") throw new Error("Field `content` is required.");
			const existed = existsSync(targetPath);
			mkdirSync(dirname(targetPath), { recursive: true });
			writeFileSync(targetPath, body.content, "utf8");
			return {
				command,
				filename: relativePath,
				action: existed ? "updated" : "created",
				projectRoot: projectDir,
				fileCount: listProjectSourceFiles(projectDir).length,
			};
		}

		if (command === "update") {
			if (!existsSync(targetPath)) throw new Error(`File not found: ${relativePath}`);
			const oldStr = String(body.old_str ?? "");
			const newStr = String(body.new_str ?? "");
			if (!oldStr) throw new Error("Field `old_str` is required for update.");
			const current = readFileSync(targetPath, "utf8");
			const firstMatchIndex = current.indexOf(oldStr);
			if (firstMatchIndex === -1) throw new Error(`old_str was not found in ${relativePath}.`);
			if (current.indexOf(oldStr, firstMatchIndex + 1) !== -1) {
				throw new Error(
					`old_str must match exactly one location in ${relativePath}. Use a longer old_str context or rewrite the file.`,
				);
			}
			writeFileSync(
				targetPath,
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
