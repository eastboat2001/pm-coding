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
					find: "@mariozechner/pi-web-workspace/agent-v2-response-language",
					replacement: resolve(repoRoot, "packages/web-workspace/src/agent-v2-response-language.ts"),
				},
				{
					find: "@mariozechner/pi-web-workspace/agent-v2-runtime",
					replacement: resolve(repoRoot, "packages/web-workspace/src/agent-v2-runtime.ts"),
				},
				{
					find: "@mariozechner/pi-web-workspace/runtime-infra",
					replacement: resolve(repoRoot, "packages/web-workspace/src/runtime-infra.ts"),
				},
				{
					find: "@mariozechner/pi-web-workspace/skill-tool-contract",
					replacement: resolve(repoRoot, "packages/web-workspace/src/skill-tool-contract.ts"),
				},
				{
					find: /^@mariozechner\/pi-web-workspace$/u,
					replacement: resolve(repoRoot, "packages/web-workspace/src/index.ts"),
				},
			]),
		);
		const aliases = viteConfig.resolve?.alias;
		expect(Array.isArray(aliases)).toBe(true);
		if (!Array.isArray(aliases)) return;
		const rootAliasIndex = aliases.findIndex(
			(alias) => alias.find instanceof RegExp && alias.find.source === "^@mariozechner\\/pi-web-workspace$",
		);
		expect(
			aliases.findIndex((alias) => alias.find === "@mariozechner/pi-web-workspace/agent-v2-response-language"),
		).toBeLessThan(rootAliasIndex);
		const languageSource = readFileSync(
			resolve(repoRoot, "packages/web-workspace/src/agent-v2-response-language.ts"),
			"utf8",
		);
		expect(languageSource).not.toMatch(/from ["']node:/u);
	});

	it("aliases the exact web-ui package root to source so active run progress is rendered", () => {
		const aliases = viteConfig.resolve?.alias;
		expect(Array.isArray(aliases)).toBe(true);
		if (!Array.isArray(aliases)) return;
		const webUiAlias = aliases.find(
			(alias) => alias.find instanceof RegExp && alias.find.source === "^@mariozechner\\/pi-web-ui$",
		);
		expect(webUiAlias).toEqual({
			find: /^@mariozechner\/pi-web-ui$/u,
			replacement: resolve(repoRoot, "packages/web-ui/src/index.ts"),
		});
		const agentInterfaceSource = readFileSync(
			resolve(repoRoot, "packages/web-ui/src/components/AgentInterface.ts"),
			"utf8",
		);
		expect(agentInterfaceSource).toContain("renderActiveRunSlot");
		expect(agentInterfaceSource).toContain("activeRunContent");
	});

	it("loads the Vite storage plugin from web-workspace source", () => {
		const source = readFileSync(resolve(appRoot, "vite.config.ts"), "utf8");

		expect(source).toContain("../../packages/web-workspace/src/vite-plugin");
		expect(source).not.toContain('from "@mariozechner/pi-web-workspace"');
	});

	it("emits web-workspace with stable tsc before compiling the worker entry", () => {
		const packageJson = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as {
			scripts?: Record<string, string>;
		};
		const script = packageJson.scripts?.["build:worker"] ?? "";

		const workspaceBuildIndex = script.indexOf("npm run build:emit --workspace=@mariozechner/pi-web-workspace");
		const workerBuildIndex = script.indexOf("tsc -p tsconfig.worker.json");

		expect(workspaceBuildIndex).toBeGreaterThanOrEqual(0);
		expect(workerBuildIndex).toBeGreaterThan(workspaceBuildIndex);
		expect(script).not.toContain("tsgo");
	});

	it("resolves worker web-workspace imports through emitted declarations", () => {
		const workerConfig = readFileSync(resolve(appRoot, "tsconfig.worker.json"), "utf8");

		expect(workerConfig).toContain("../../packages/web-workspace/dist/index.d.ts");
		expect(workerConfig).not.toContain("../../packages/web-workspace/src/");
	});
});
