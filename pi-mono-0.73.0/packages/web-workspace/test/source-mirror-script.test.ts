import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
