import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";

export type StaticResourceReference =
	| { kind: "external"; value: string }
	| { kind: "local"; value: string; relativePath: string };

export function staticHtmlAttributeValue(attributes: string, name: "href" | "rel" | "src"): string | undefined {
	const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "i").exec(attributes);
	return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function classifyStaticResourceReference(value: string | undefined): StaticResourceReference | undefined {
	const trimmed = value?.trim();
	if (!trimmed || trimmed.startsWith("#")) return undefined;
	if (trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
		return { kind: "external", value: trimmed };
	}
	const withoutQueryOrHash = trimmed.split(/[?#]/, 1)[0]?.trim();
	if (!withoutQueryOrHash) return undefined;
	const relativePath = withoutQueryOrHash.replace(/^\/+/, "").replace(/^\.\/+/, "");
	if (!relativePath) return undefined;
	try {
		return { kind: "local", value: trimmed, relativePath: decodeURIComponent(relativePath) };
	} catch {
		return { kind: "local", value: trimmed, relativePath };
	}
}

export function staticServeRootCandidates(hasPackageJson: boolean): string[] {
	return hasPackageJson ? ["dist", "build", "public", ""] : ["", "dist", "build", "public"];
}

export function findStaticServeRoot(projectDir: string, candidates: string[]): string | undefined {
	const guard = WorkspacePathGuard.forProjectContent(projectDir);
	for (const candidate of candidates) {
		let serveRoot: string;
		let entryPath: string;
		try {
			serveRoot = candidate
				? guard.authorizeExisting(candidate, "directory").absolutePath
				: guard.authorizeAbsoluteExisting(projectDir, "directory").absolutePath;
			entryPath = guard.authorizeExisting(
				candidate ? join(candidate, "index.html") : "index.html",
				"file",
			).absolutePath;
		} catch (error) {
			if (error instanceof WorkspacePathAuthorizationError) continue;
			throw error;
		}
		if (indexHtmlRequiresBuild(entryPath)) continue;
		return serveRoot;
	}
	return undefined;
}

export function findBuildSourceEntry(projectDir: string, candidates: string[]): string | undefined {
	const guard = WorkspacePathGuard.forProjectContent(projectDir);
	for (const candidate of candidates) {
		try {
			const entryPath = guard.authorizeExisting(
				candidate ? join(candidate, "index.html") : "index.html",
				"file",
			).absolutePath;
			if (indexHtmlRequiresBuild(entryPath)) return entryPath;
		} catch (error) {
			if (error instanceof WorkspacePathAuthorizationError) continue;
			throw error;
		}
	}
	return undefined;
}

function indexHtmlRequiresBuild(entryPath: string): boolean {
	const html = readFileSync(entryPath, "utf8");
	for (const source of moduleScriptSources(html)) {
		const normalized = source.split(/[?#]/, 1)[0].toLowerCase();
		if (normalized.endsWith(".ts") || normalized.endsWith(".tsx") || normalized.endsWith(".jsx")) return true;
	}
	return false;
}

function moduleScriptSources(html: string): string[] {
	const sources: string[] = [];
	const scriptPattern = /<script\b[^>]*\btype=(["'])module\1[^>]*>/gi;
	for (const match of html.matchAll(scriptPattern)) {
		const tag = match[0];
		const sourceMatch = tag.match(/\bsrc=(["'])([^"']+)\1/i);
		if (sourceMatch?.[2]) sources.push(sourceMatch[2]);
	}
	return sources;
}
