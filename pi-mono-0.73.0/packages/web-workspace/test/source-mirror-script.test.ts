import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error The source mirror CLI is an ESM JavaScript module.
import { auditSourceMirrors, syncSourceMirrors } from "../scripts/source-mirrors.mjs";

const fixtureRoots: string[] = [];

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureProject(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-source-mirrors-"));
	fixtureRoots.push(root);
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src/alpha.ts"), "export const alpha = 1;\n");
	writeFileSync(join(root, "src/beta.ts"), "export const beta = 1;\n");
	return root;
}

function createDirectoryLink(target: string, path: string): void {
	symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

function createFileLink(target: string, path: string): void {
	if (process.platform === "win32") {
		linkSync(target, path);
		return;
	}
	symlinkSync(target, path, "file");
}

it("syncs only explicit TypeScript files and detects sourcesContent drift", async () => {
	const rootDir = fixtureProject();
	await syncSourceMirrors({ rootDir, files: ["alpha.ts"] });
	const output = readFileSync(join(rootDir, "src/alpha.js"), "utf8");
	expect(output).toContain("export const alpha");
	expect(output).not.toMatch(/exports\.|Object\.defineProperty\(exports/);
	expect(auditSourceMirrors({ rootDir, files: ["alpha.ts"] })).toEqual([]);
	writeFileSync(join(rootDir, "src/alpha.ts"), "export const alpha = 2;\n");
	expect(auditSourceMirrors({ rootDir, files: ["alpha.ts"] })).toContain("alpha.ts: sourcesContent drift");
	expect(existsSync(join(rootDir, "src/beta.js"))).toBe(false);
});

it("rejects invalid explicit file lists before writing mirrors", () => {
	const rootDir = fixtureProject();
	writeFileSync(join(rootDir, "outside.ts"), "export const outside = true;\n");
	const invalidLists = [
		[],
		[join(rootDir, "src/alpha.ts")],
		["../outside.ts"],
		["alpha.ts", "./alpha.ts"],
		["alpha.js"],
		["missing.ts"],
	];

	for (const files of invalidLists) {
		expect(() => syncSourceMirrors({ rootDir, files })).toThrow();
		expect(() => auditSourceMirrors({ rootDir, files })).toThrow();
	}
	expect(existsSync(join(rootDir, "src/alpha.js"))).toBe(false);
	expect(existsSync(join(rootDir, "src/alpha.js.map"))).toBe(false);
	expect(existsSync(join(rootDir, "outside.js"))).toBe(false);
	expect(existsSync(join(rootDir, "outside.js.map"))).toBe(false);
});

it("rejects a linked source and output parent that escapes src", () => {
	const rootDir = fixtureProject();
	const outsideDir = join(rootDir, "outside-source");
	mkdirSync(outsideDir);
	writeFileSync(join(outsideDir, "linked.ts"), "export const linked = true;\n");
	createDirectoryLink(outsideDir, join(rootDir, "src/escape"));

	expect(() => auditSourceMirrors({ rootDir, files: ["escape/linked.ts"] })).toThrow();
	expect(() => syncSourceMirrors({ rootDir, files: ["escape/linked.ts"] })).toThrow();
	expect(existsSync(join(outsideDir, "linked.js"))).toBe(false);
	expect(existsSync(join(outsideDir, "linked.js.map"))).toBe(false);
});

it("rejects pre-existing linked JavaScript and map outputs without overwriting their targets", () => {
	const rootDir = fixtureProject();
	const outsideDir = join(rootDir, "outside-output");
	mkdirSync(outsideDir);
	const outsideJs = join(outsideDir, "outside.js");
	const outsideMap = join(outsideDir, "outside.js.map");
	writeFileSync(outsideJs, "outside JavaScript sentinel\n");
	writeFileSync(outsideMap, "outside map sentinel\n");
	createFileLink(outsideJs, join(rootDir, "src/alpha.js"));
	createFileLink(outsideMap, join(rootDir, "src/alpha.js.map"));

	expect(() => syncSourceMirrors({ rootDir, files: ["alpha.ts"] })).toThrow();
	expect(() => auditSourceMirrors({ rootDir, files: ["alpha.ts"] })).toThrow();
	expect(readFileSync(outsideJs, "utf8")).toBe("outside JavaScript sentinel\n");
	expect(readFileSync(outsideMap, "utf8")).toBe("outside map sentinel\n");
});
