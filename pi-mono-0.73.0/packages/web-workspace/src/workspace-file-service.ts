import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ProjectFileRequest, ProjectFileResult, StorageConfig } from "./types.js";
import {
	assertInside,
	listProjectSourceFiles,
	removeSiblingProjectDirs,
	safeRelativeProjectPath,
	workspaceContext,
} from "./workspace-paths.js";

export class WorkspaceFileService {
	constructor(private readonly config: StorageConfig) {}

	handle(body: ProjectFileRequest): ProjectFileResult {
		const { projectDir, sessionId } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId);

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
			return { command, filename: relativePath, content: readFileSync(targetPath, "utf8"), projectRoot: projectDir };
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
			if (!current.includes(oldStr)) throw new Error(`old_str was not found in ${relativePath}.`);
			writeFileSync(targetPath, current.replace(oldStr, newStr), "utf8");
			return { command, filename: relativePath, action: "updated", projectRoot: projectDir };
		}

		throw new Error(`Unsupported workspace file command: ${command}`);
	}
}
