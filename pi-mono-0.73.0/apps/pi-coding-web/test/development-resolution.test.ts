import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import viteConfig from "../vite.config.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(testDir, "..");
const repoRoot = resolve(testDir, "../../..");

describe("development dependency resolution", () => {
	it("aliases web-workspace package imports to source in Vite", () => {
		expect(viteConfig.resolve?.alias).toEqual(
			expect.arrayContaining([
				{
					find: "@mariozechner/pi-web-workspace/skill-tool-contract",
					replacement: resolve(repoRoot, "packages/web-workspace/src/skill-tool-contract.ts"),
				},
				{
					find: "@mariozechner/pi-web-workspace",
					replacement: resolve(repoRoot, "packages/web-workspace/src/index.ts"),
				},
			]),
		);
	});

	it("loads the Vite storage plugin from web-workspace source", () => {
		const source = readFileSync(resolve(appRoot, "vite.config.ts"), "utf8");

		expect(source).toContain("../../packages/web-workspace/src/vite-plugin");
		expect(source).not.toContain('from "@mariozechner/pi-web-workspace"');
	});

	it("builds web-workspace before compiling the worker entry", () => {
		const packageJson = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const script = packageJson.scripts?.["build:worker"] ?? "";

		const workspaceBuildIndex = script.indexOf("npm run build --workspace=@mariozechner/pi-web-workspace");
		const workerBuildIndex = script.indexOf("tsgo -p tsconfig.worker.json");

		expect(workspaceBuildIndex).toBeGreaterThanOrEqual(0);
		expect(workerBuildIndex).toBeGreaterThan(workspaceBuildIndex);
	});
});
