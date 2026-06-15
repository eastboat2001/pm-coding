import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { PROJECT_MANIFEST_FILE, PROJECT_METADATA_FILE } from "./constants.js";
import type { ProjectWorkspaceContext, StorageConfig } from "./types.js";

export function workspaceContext(
	config: StorageConfig,
	body: { clientId?: unknown; sessionId?: unknown; title?: unknown },
): ProjectWorkspaceContext {
	const clientId = optionalSafePathId(body.clientId, "client");
	const sessionId = String(body.sessionId || "").trim();
	const title = String(body.title || "").trim();
	if (!sessionId) throw new Error("Field `sessionId` is required.");
	const projectId = projectSlug(sessionId, title, clientId);
	const projectDir = projectDirectory(config.projectsRootDir, sessionId, title, clientId);
	assertInside(config.projectsRootDir, projectDir);
	return { ...(clientId ? { clientId } : {}), sessionId, title, projectId, projectDir };
}

export function projectDirectory(projectsRootDir: string, sessionId: string, title?: string, clientId?: string): string {
	return join(projectsRootDir, projectSlug(sessionId, title, clientId));
}

export function projectSlug(sessionId: string, _title?: string, clientId?: string): string {
	const suffix = projectSlugSuffix(sessionId, clientId);
	return `project-${suffix}`;
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

export function removeSiblingProjectDirs(
	projectsRootDir: string,
	currentProjectDir: string,
	sessionId: string,
	clientId?: string,
): void {
	if (!existsSync(projectsRootDir)) return;
	const suffix = `-${projectSlugSuffix(sessionId, clientId)}`;
	for (const name of readdirSync(projectsRootDir)) {
		const candidate = join(projectsRootDir, name);
		if (candidate === currentProjectDir || !name.endsWith(suffix)) continue;
		if (!projectDirectoryBelongsToSession(candidate, sessionId, suffix, name, clientId)) continue;
		rmSync(candidate, { recursive: true, force: true });
	}
}

export function migrateLegacyProjectDir(
	projectsRootDir: string,
	currentProjectDir: string,
	sessionId: string,
	clientId?: string,
): void {
	if (!existsSync(projectsRootDir) || projectDirectoryHasContent(currentProjectDir)) return;
	const suffix = `-${projectSlugSuffix(sessionId, clientId)}`;
	for (const name of readdirSync(projectsRootDir)) {
		const candidate = join(projectsRootDir, name);
		if (candidate === currentProjectDir) continue;
		if (!projectDirectoryBelongsToSession(candidate, sessionId, suffix, name, clientId)) continue;
		if (existsSync(currentProjectDir)) rmSync(currentProjectDir, { recursive: true, force: true });
		renameSync(candidate, currentProjectDir);
		rewriteMigratedProjectMetadata(currentProjectDir, candidate);
		return;
	}
}

export function deleteSessionAndProjects(
	projectsRootDir: string,
	sessionPath: string,
	sessionId: string,
	clientId?: string,
): boolean {
	let deleted = false;
	if (existsSync(sessionPath)) {
		rmSync(sessionPath, { force: true });
		deleted = true;
	}
	const suffix = `-${projectSlugSuffix(sessionId, clientId)}`;
	if (existsSync(projectsRootDir)) {
		for (const name of readdirSync(projectsRootDir)) {
			const projectPath = join(projectsRootDir, name);
			if (projectDirectoryBelongsToSession(projectPath, sessionId, suffix, name, clientId)) {
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
	clientId?: string,
): boolean {
	const metadataPath = join(projectPath, PROJECT_METADATA_FILE);
	if (existsSync(metadataPath)) {
		try {
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
				clientId?: unknown;
				sessionId?: unknown;
			};
			return metadata.sessionId === sessionId && (!clientId || metadata.clientId === clientId);
		} catch {
			return false;
		}
	}
	return directoryName === `project${legacySuffix}` || directoryName.endsWith(legacySuffix);
}

function projectDirectoryHasContent(projectDir: string): boolean {
	if (!existsSync(projectDir)) return false;
	try {
		return statSync(projectDir).isDirectory() && readdirSync(projectDir).length > 0;
	} catch {
		return false;
	}
}

function rewriteMigratedProjectMetadata(projectDir: string, legacyProjectDir: string): void {
	const metadataPath = join(projectDir, PROJECT_METADATA_FILE);
	if (!existsSync(metadataPath)) return;
	try {
		const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
		const nextProjectId = basename(projectDir);
		metadata.projectId = nextProjectId;
		metadata.projectRoot = projectDir;
		if (typeof metadata.serveRoot === "string" && metadata.serveRoot.startsWith(legacyProjectDir)) {
			metadata.serveRoot = `${projectDir}${metadata.serveRoot.slice(legacyProjectDir.length)}`;
		}
		writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
	} catch {
		// Ignore corrupt metadata; callers can still access migrated source files.
	}
}

function projectSlugSuffix(sessionId: string, clientId?: string): string {
	const safeSessionId = requiredSafePathId(sessionId, "session");
	if (!clientId) return safeSessionId.slice(0, 8);
	const safeClientId = requiredSafePathId(clientId, "client");
	return `${safeClientId.slice(0, 8)}-${safeSessionId.slice(0, 8)}`;
}

function optionalSafePathId(value: unknown, label: "client" | "session"): string | undefined {
	if (value === undefined || value === null) return undefined;
	const trimmed = String(value).trim();
	if (!trimmed) return undefined;
	return requiredSafePathId(trimmed, label);
}

function requiredSafePathId(value: string, label: "client" | "session"): string {
	const safeValue = sanitizePathComponent(value);
	if (!safeValue) throw new Error(`Invalid ${label} id.`);
	return safeValue;
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
