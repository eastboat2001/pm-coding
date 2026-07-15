import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const compilerOptions = {
	module: ts.ModuleKind.ESNext,
	target: ts.ScriptTarget.ES2022,
	sourceMap: true,
	inlineSources: true,
};

/**
 * @param {{ rootDir: string; files: string[] }} options
 */
export function syncSourceMirrors(options) {
	for (const source of resolveSources(options)) {
		const generated = transpileSource(source);
		writeFileSync(source.jsPath, generated.outputText, "utf8");
		writeFileSync(source.mapPath, generated.sourceMapText, "utf8");
	}
}

/**
 * @param {{ rootDir: string; files: string[]; rejectOrphans?: boolean }} options
 * @returns {string[]}
 */
export function auditSourceMirrors(options) {
	const drift = [];
	const sources = resolveSources(options);
	for (const source of sources) {
		const generated = transpileSource(source);
		if (!existsSync(source.jsPath)) {
			drift.push(`${source.name}: missing JavaScript mirror`);
		} else if (readFileSync(source.jsPath, "utf8") !== generated.outputText) {
			drift.push(`${source.name}: JavaScript drift`);
		}

		if (!existsSync(source.mapPath)) {
			drift.push(`${source.name}: missing source map`);
			continue;
		}

		const actualMapText = readFileSync(source.mapPath, "utf8");
		let actualMap;
		try {
			actualMap = JSON.parse(actualMapText);
		} catch {
			drift.push(`${source.name}: invalid source map`);
			continue;
		}
		if (!Array.isArray(actualMap.sourcesContent) || actualMap.sourcesContent[0] !== source.content) {
			drift.push(`${source.name}: sourcesContent drift`);
		}
		if (actualMapText !== generated.sourceMapText) drift.push(`${source.name}: source map drift`);
	}
	if (options.rejectOrphans) drift.push(...auditOrphanOutputs(resolve(options.rootDir, "src"), sources));
	return drift;
}

function auditOrphanOutputs(srcDir, sources) {
	const expectedJavaScript = new Set(sources.map((source) => source.name.slice(0, -3) + ".js"));
	const expectedMaps = new Set([...expectedJavaScript].map((name) => `${name}.map`));
	const orphaned = [];
	for (const name of collectMirrorOutputs(srcDir)) {
		if (name.endsWith(".js.map") && !expectedMaps.has(name)) {
			orphaned.push(`${name}: orphan source map`);
			continue;
		}
		if (name.endsWith(".js") && !expectedJavaScript.has(name)) {
			orphaned.push(`${name}: orphan JavaScript mirror`);
		}
	}
	return orphaned.sort();
}

function collectMirrorOutputs(srcDir, relativeDir = "") {
	const outputs = [];
	const currentDir = join(srcDir, relativeDir);
	for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
		const name = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			outputs.push(...collectMirrorOutputs(srcDir, name));
			continue;
		}
		if (entry.isFile() && (entry.name.endsWith(".js") || entry.name.endsWith(".js.map"))) outputs.push(name);
	}
	return outputs;
}

/**
 * @param {{ rootDir: string; files: string[] }} options
 */
function resolveSources({ rootDir, files }) {
	if (!Array.isArray(files) || files.length === 0) throw new Error("At least one explicit TypeScript file is required.");
	const srcDir = resolve(rootDir, "src");
	assertNoLinkedPathComponents(srcDir, srcDir, "src");
	if (!statSync(srcDir).isDirectory()) throw new Error("Source root is not a directory: src");
	const canonicalSrcDir = realpathSync.native(srcDir);
	const seen = new Set();
	return files.map((name) => {
		if (typeof name !== "string" || !name || isAbsolute(name) || extname(name) !== ".ts") {
			throw new Error(`Invalid TypeScript source path: ${String(name)}`);
		}
		const tsPath = resolve(srcDir, name);
		const relativePath = relative(srcDir, tsPath);
		if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error(`TypeScript source must be inside src: ${name}`);
		}
		assertNoLinkedPathComponents(srcDir, tsPath, name);
		if (!existsSync(tsPath) || !statSync(tsPath).isFile()) throw new Error(`TypeScript source does not exist: ${name}`);
		const canonicalTsPath = realpathSync.native(tsPath);
		assertCanonicalContainment(canonicalSrcDir, canonicalTsPath, name);
		const key = comparablePath(canonicalTsPath);
		if (seen.has(key)) throw new Error(`Duplicate TypeScript source: ${name}`);
		seen.add(key);
		const stem = tsPath.slice(0, -extname(tsPath).length);
		const jsPath = `${stem}.js`;
		const mapPath = `${stem}.js.map`;
		assertSafeOutputPath(srcDir, canonicalSrcDir, jsPath, name);
		assertSafeOutputPath(srcDir, canonicalSrcDir, mapPath, name);
		return {
			name: relativePath.replaceAll("\\", "/"),
			tsPath,
			jsPath,
			mapPath,
			content: readFileSync(tsPath, "utf8"),
		};
	});
}

function assertSafeOutputPath(srcDir, canonicalSrcDir, outputPath, sourceName) {
	assertNoLinkedPathComponents(srcDir, outputPath, sourceName);
	let existingPath = outputPath;
	while (!existsSync(existingPath)) {
		const parent = dirname(existingPath);
		if (parent === existingPath) throw new Error(`Cannot resolve output path for ${sourceName}`);
		existingPath = parent;
	}
	assertCanonicalContainment(canonicalSrcDir, realpathSync.native(existingPath), sourceName);
}

function assertNoLinkedPathComponents(srcDir, targetPath, sourceName) {
	const relativePath = relative(srcDir, targetPath);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`TypeScript source must be inside src: ${sourceName}`);
	}
	let currentPath = srcDir;
	assertSafePathEntry(currentPath, sourceName);
	for (const component of relativePath.split(/[\\/]+/).filter(Boolean)) {
		currentPath = join(currentPath, component);
		try {
			assertSafePathEntry(currentPath, sourceName);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
			throw error;
		}
	}
}

function assertSafePathEntry(path, sourceName) {
	const stats = lstatSync(path);
	if (stats.isSymbolicLink()) throw new Error(`Linked paths are not allowed for ${sourceName}`);
	if (stats.isFile() && stats.nlink > 1) throw new Error(`Linked files are not allowed for ${sourceName}`);
}

function assertCanonicalContainment(canonicalSrcDir, canonicalPath, sourceName) {
	const relativePath = relative(comparablePath(canonicalSrcDir), comparablePath(canonicalPath));
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		throw new Error(`Canonical path escapes src for ${sourceName}`);
	}
}

function comparablePath(path) {
	const absolutePath = resolve(path);
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath;
}

/**
 * @param {{ name: string; content: string }} source
 */
function transpileSource(source) {
	const sourceName = basename(source.name);
	const result = ts.transpileModule(source.content, {
		compilerOptions,
		fileName: sourceName,
	});
	if (!result.sourceMapText) throw new Error(`TypeScript did not emit a source map for ${source.name}`);
	if (/exports\.|Object\.defineProperty\(exports/.test(result.outputText)) {
		throw new Error(`TypeScript emitted a CommonJS wrapper for ${source.name}`);
	}
	const sourceMap = JSON.parse(result.sourceMapText);
	sourceMap.file = `${sourceName.slice(0, -3)}.js`;
	sourceMap.sourceRoot = "";
	sourceMap.sources = [sourceName];
	sourceMap.sourcesContent = [source.content];
	return {
		outputText: result.outputText,
		sourceMapText: JSON.stringify(sourceMap),
	};
}

async function main() {
	const [, , command, ...files] = process.argv;
	const options = { rootDir: process.cwd(), files };
	if (command === "sync") {
		syncSourceMirrors(options);
		return;
	}
	if (command === "audit") {
		const drift = auditSourceMirrors(options);
		if (drift.length === 0) return;
		for (const message of drift) console.error(message);
		process.exitCode = 1;
		return;
	}
	throw new Error("Usage: node scripts/source-mirrors.mjs <sync|audit> <explicit.ts...>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
