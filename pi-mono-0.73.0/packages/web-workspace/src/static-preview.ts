import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export function staticServeRootCandidates(hasPackageJson: boolean): string[] {
	return hasPackageJson ? ["dist", "build", "public", ""] : ["", "dist", "build", "public"];
}

export function findStaticServeRoot(projectDir: string, candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		const serveRoot = candidate ? join(projectDir, candidate) : projectDir;
		const entryPath = join(serveRoot, "index.html");
		if (!existsSync(entryPath) || !statSync(entryPath).isFile()) continue;
		if (indexHtmlRequiresBuild(entryPath)) continue;
		return serveRoot;
	}
	return undefined;
}

export function findBuildSourceEntry(projectDir: string, candidates: string[]): string | undefined {
	for (const candidate of candidates) {
		const serveRoot = candidate ? join(projectDir, candidate) : projectDir;
		const entryPath = join(serveRoot, "index.html");
		if (existsSync(entryPath) && statSync(entryPath).isFile() && indexHtmlRequiresBuild(entryPath)) return entryPath;
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
