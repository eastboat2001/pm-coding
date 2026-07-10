import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, relative, resolve } from "node:path";
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
 * @param {{ rootDir: string; files: string[] }} options
 * @returns {string[]}
 */
export function auditSourceMirrors(options) {
	const drift = [];
	for (const source of resolveSources(options)) {
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
	return drift;
}

/**
 * @param {{ rootDir: string; files: string[] }} options
 */
function resolveSources({ rootDir, files }) {
	if (!Array.isArray(files) || files.length === 0) throw new Error("At least one explicit TypeScript file is required.");
	const srcDir = resolve(rootDir, "src");
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
		const key = process.platform === "win32" ? relativePath.toLowerCase() : relativePath;
		if (seen.has(key)) throw new Error(`Duplicate TypeScript source: ${name}`);
		seen.add(key);
		if (!existsSync(tsPath) || !statSync(tsPath).isFile()) throw new Error(`TypeScript source does not exist: ${name}`);
		const stem = tsPath.slice(0, -extname(tsPath).length);
		return {
			name: relativePath.replaceAll("\\", "/"),
			tsPath,
			jsPath: `${stem}.js`,
			mapPath: `${stem}.js.map`,
			content: readFileSync(tsPath, "utf8"),
		};
	});
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
