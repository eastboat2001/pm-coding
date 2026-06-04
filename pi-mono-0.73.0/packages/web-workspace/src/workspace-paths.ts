import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROJECT_MANIFEST_FILE, PROJECT_METADATA_FILE } from "./constants.js";
import type { ProjectWorkspaceContext, StorageConfig } from "./types.js";

export function workspaceContext(
	config: StorageConfig,
	body: { sessionId?: unknown; title?: unknown },
): ProjectWorkspaceContext {
	const sessionId = String(body.sessionId || "").trim();
	const title = String(body.title || "").trim();
	if (!sessionId) throw new Error("Field `sessionId` is required.");
	const projectId = projectSlug(sessionId, title);
	const projectDir = projectDirectory(config.projectsRootDir, sessionId, title);
	assertInside(config.projectsRootDir, projectDir);
	return { sessionId, title, projectId, projectDir };
}

export function projectDirectory(projectsRootDir: string, sessionId: string, title?: string): string {
	return join(projectsRootDir, projectSlug(sessionId, title));
}

export function projectSlug(sessionId: string, title?: string): string {
	const base = sanitizePathComponent(title || "");
	const suffix = (sanitizePathComponent(sessionId) || sessionId).slice(0, 8);
	return base ? `${base}-${suffix}` : `project-${suffix}`;
}

export function sanitizePathComponent(value: string): string {
	let normalized = value.trim().toLowerCase().replace(/\s+/g, "-");
	normalized = normalized
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^[-._]+|[-._]+$/g, "");
	const reserved = new Set([
		"con",
		"prn",
		"aux",
		"nul",
		"com1",
		"com2",
		"com3",
		"com4",
		"com5",
		"com6",
		"com7",
		"com8",
		"com9",
		"lpt1",
		"lpt2",
		"lpt3",
		"lpt4",
		"lpt5",
		"lpt6",
		"lpt7",
		"lpt8",
		"lpt9",
	]);
	if (reserved.has(normalized)) normalized = `${normalized}-file`;
	return normalized.slice(0, 80);
}

export function safeRelativeProjectPath(filename: string): string {
	const rawParts = filename
		.replace(/\\/g, "/")
		.split("/")
		.map((part) => part.trim());
	if (rawParts.some((part) => part === "..")) throw new Error("Project path component is empty.");
	const parts = rawParts.filter(Boolean).map((part) => sanitizeProjectPathComponent(part));
	if (parts.length === 0) throw new Error("Project filename is empty.");
	return join(...parts);
}

export function sanitizeProjectPathComponent(value: string): string {
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes(":")) {
		throw new Error(`Invalid project path component: ${value}`);
	}
	const cleaned = value.replace(/[<>:"|?*\u0000-\u001f]/g, "-").replace(/^[-\s]+|[-\s]+$/g, "");
	if (!cleaned) throw new Error("Project path component is empty.");
	return cleaned;
}

export function removeSiblingProjectDirs(projectsRootDir: string, currentProjectDir: string, sessionId: string): void {
	if (!existsSync(projectsRootDir)) return;
	const suffix = `-${(sanitizePathComponent(sessionId) || sessionId).slice(0, 8)}`;
	for (const name of readdirSync(projectsRootDir)) {
		const candidate = join(projectsRootDir, name);
		if (candidate === currentProjectDir || !name.endsWith(suffix)) continue;
		rmSync(candidate, { recursive: true, force: true });
	}
}

export function deleteSessionAndProjects(projectsRootDir: string, sessionPath: string, sessionId: string): boolean {
	let deleted = false;
	if (existsSync(sessionPath)) {
		rmSync(sessionPath, { force: true });
		deleted = true;
	}
	const suffix = `-${(sanitizePathComponent(sessionId) || sessionId).slice(0, 8)}`;
	if (existsSync(projectsRootDir)) {
		for (const name of readdirSync(projectsRootDir)) {
			const projectPath = join(projectsRootDir, name);
			if (projectDirectoryBelongsToSession(projectPath, sessionId, suffix, name)) {
				rmSync(join(projectsRootDir, name), { recursive: true, force: true });
				deleted = true;
			}
		}
	}
	return deleted;
}

function projectDirectoryBelongsToSession(
	projectPath: string,
	sessionId: string,
	legacySuffix: string,
	directoryName: string,
): boolean {
	const metadataPath = join(projectPath, PROJECT_METADATA_FILE);
	if (existsSync(metadataPath)) {
		try {
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { sessionId?: unknown };
			return metadata.sessionId === sessionId;
		} catch {
			return false;
		}
	}
	return directoryName === `project${legacySuffix}` || directoryName.endsWith(legacySuffix);
}

export function listProjectSourceFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const excludedDirs = new Set([".git", ".pi", "node_modules", ".next", ".nuxt", "dist", "build", "coverage"]);
	const excludedFiles = new Set([PROJECT_METADATA_FILE, PROJECT_MANIFEST_FILE]);
	const result: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (excludedDirs.has(entry.name)) continue;
			result.push(...listProjectSourceFiles(path));
		}
		if (entry.isFile() && !excludedFiles.has(entry.name)) result.push(path);
	}
	return result;
}

export function safeRelativePreviewPath(parts: string[]): string {
	const cleaned = parts.filter(
		(part) => part && part !== "." && part !== ".." && !part.includes("/") && !part.includes("\\"),
	);
	if (cleaned.length === 0) return "index.html";
	return join(...cleaned);
}

export function pruneEmptyDirectories(root: string): void {
	if (!existsSync(root) || !statSync(root).isDirectory()) return;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) pruneEmptyDirectories(path);
	}
	if (readdirSync(root).length === 0) rmSync(root, { force: true, recursive: true });
}

export function assertInside(root: string, target: string): void {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	if (
		resolvedTarget !== resolvedRoot &&
		!resolvedTarget.startsWith(`${resolvedRoot}${resolve(root).includes("\\") ? "\\" : "/"}`)
	) {
		throw new Error("Resolved path escapes configured root.");
	}
}
