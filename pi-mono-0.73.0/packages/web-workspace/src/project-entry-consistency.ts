import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { listProjectSourceFiles } from "./workspace-paths.js";

const SOURCE_ENTRY = /^src\/(?:.*\/)?(?:main|index|app)\.[cm]?[jt]sx?$/i;
const COMPONENT_SOURCE = /^src\/.*\.[jt]sx$/i;
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const SCRIPT_SOURCE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i;
const MODULE_IMPORT = /(?:\bfrom\s*|\bimport\s*\()(["'])([^"']+)\1/g;

export const PROJECT_ENTRY_CONFLICT_PREFIX = "Build project entry conflict:";
export const PROJECT_MANIFEST_MISSING_PREFIX = "Build project manifest missing:";

export interface ProjectEntryConsistencyAssessment {
	valid: boolean;
	errors: string[];
	sourceEntries: string[];
}

export interface ProjectEntryConsistencyFile {
	path: string;
	content: string;
}

export function assessProjectEntryConsistency(projectDir: string): ProjectEntryConsistencyAssessment {
	const indexPath = join(projectDir, "index.html");
	if (!existsSync(indexPath)) return validAssessment();
	const sourceFiles = listProjectSourceFiles(projectDir).map((path) => ({
		path: relative(projectDir, path).replaceAll("\\", "/"),
		content: readFileSync(path, "utf8"),
	}));
	if (!sourceFiles.some((file) => file.path.toLowerCase() === "index.html")) {
		sourceFiles.push({ path: "index.html", content: readFileSync(indexPath, "utf8") });
	}
	if (existsSync(join(projectDir, "package.json")) && !sourceFiles.some((file) => file.path === "package.json")) {
		sourceFiles.push({ path: "package.json", content: "" });
	}
	return assessProjectEntryConsistencyFiles(sourceFiles);
}

export function assessProjectEntryConsistencyFiles(
	projectFiles: readonly ProjectEntryConsistencyFile[],
): ProjectEntryConsistencyAssessment {
	const normalizedFiles = projectFiles.map((file) => ({
		path: file.path.replaceAll("\\", "/").replace(/^\.\//u, ""),
		content: file.content,
	}));
	const html = normalizedFiles.find((file) => file.path.toLowerCase() === "index.html")?.content;
	if (html === undefined) return validAssessment();
	const sourceEntries = normalizedFiles
		.map((file) => file.path)
		.filter((path) => SOURCE_ENTRY.test(path) || COMPONENT_SOURCE.test(path))
		.sort();
	const referencedSources = referencedSourcePaths(html);
	const referencesSourceImplementation = referencedSources.some((path) => path.startsWith("src/"));
	if (sourceEntries.length > 0 && !referencesSourceImplementation && hasSubstantialInlineApplication(html)) {
		return entryConflictAssessment(sourceEntries);
	}
	if (!normalizedFiles.some((file) => file.path.toLowerCase() === "package.json")) {
		const buildSource =
			referencedSources.find((path) => /\.(?:ts|tsx|jsx)$/i.test(path)) ??
			sourceEntries.find((path) => /\.(?:ts|tsx|jsx)$/i.test(path));
		if (buildSource) {
			return {
				valid: false,
				errors: [
					`${PROJECT_MANIFEST_MISSING_PREFIX} project contains build source ${buildSource}, but package.json is missing. Add a complete build manifest and lockfile, or convert the project to a dependency-free browser application.`,
				],
				sourceEntries,
			};
		}
		return validAssessment(sourceEntries);
	}
	if (sourceEntries.length === 0) return validAssessment();
	if (referencesSourceImplementation) return validAssessment(sourceEntries);
	if (!hasSubstantialInlineApplication(html)) return validAssessment(sourceEntries);
	return entryConflictAssessment(sourceEntries);
}

function entryConflictAssessment(sourceEntries: string[]): ProjectEntryConsistencyAssessment {
	const displayedEntries = sourceEntries.slice(0, 8);
	const suffix =
		sourceEntries.length > displayedEntries.length
			? `, and ${sourceEntries.length - displayedEntries.length} more`
			: "";
	return {
		valid: false,
		errors: [
			`${PROJECT_ENTRY_CONFLICT_PREFIX} root index.html contains a standalone inline application while source implementation entries are unreferenced: ${displayedEntries.join(", ")}${suffix}. Keep one authoritative implementation and make preview output originate from that implementation's build.`,
		],
		sourceEntries,
	};
}

export function isProjectEntryConflictMessage(message: string): boolean {
	return message.trim().startsWith(PROJECT_ENTRY_CONFLICT_PREFIX);
}

export function isProjectManifestMissingMessage(message: string): boolean {
	const normalized = message.trim();
	return (
		normalized.startsWith(PROJECT_MANIFEST_MISSING_PREFIX) || normalized === "build_static requires package.json."
	);
}

function validAssessment(sourceEntries: string[] = []): ProjectEntryConsistencyAssessment {
	return { valid: true, errors: [], sourceEntries };
}

function referencedSourcePaths(html: string): string[] {
	const references: string[] = [];
	for (const match of html.matchAll(SCRIPT_TAG)) {
		const attributes = match[1] ?? "";
		const content = match[2] ?? "";
		const sourceMatch = SCRIPT_SOURCE.exec(attributes);
		const source = sourceMatch?.[1] ?? sourceMatch?.[2] ?? sourceMatch?.[3];
		if (source) references.push(normalizeLocalReference(source));
		if (/\btype\s*=\s*(["'])module\1/i.test(attributes)) {
			for (const importMatch of content.matchAll(MODULE_IMPORT)) {
				if (importMatch[2]) references.push(normalizeLocalReference(importMatch[2]));
			}
		}
	}
	return references.filter(Boolean);
}

function normalizeLocalReference(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return "";
	const path =
		trimmed
			.split(/[?#]/, 1)[0]
			?.replace(/^\/+/, "")
			.replace(/^\.\/+/, "") ?? "";
	try {
		return decodeURIComponent(path).replaceAll("\\", "/");
	} catch {
		return path.replaceAll("\\", "/");
	}
}

function hasSubstantialInlineApplication(html: string): boolean {
	const inlineStyleLength = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].reduce(
		(total, match) => total + (match[1]?.trim().length ?? 0),
		0,
	);
	let inlineScriptLength = 0;
	for (const match of html.matchAll(SCRIPT_TAG)) {
		if (!SCRIPT_SOURCE.test(match[1] ?? "")) inlineScriptLength += match[2]?.trim().length ?? 0;
	}
	const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(html)?.[1] ?? "";
	const bodyElementCount = [...body.matchAll(/<[a-z][a-z0-9-]*\b/gi)].length;
	return inlineStyleLength >= 512 || inlineScriptLength >= 512 || (body.length >= 2_000 && bodyElementCount >= 16);
}
