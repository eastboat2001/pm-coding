import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { BuildRunnerError, type BuildRunnerResult } from "../src/build-runner.js";
import { EphemeralContainerBuildRunner } from "../src/ephemeral-container-build-runner.js";

const engine = required("PI_TEST_BUILD_CONTAINER_ENGINE");
const image = required("PI_TEST_BUILD_CONTAINER_IMAGE");
const proxyImage = required("PI_TEST_BUILD_PROXY_IMAGE");
const root = mkdtempSync(join(tmpdir(), "pi-real-container-runner-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("denies direct, off-allowlist, and literal-IP egress then restores and builds through the allowlisted registry", async () => {
	const projectRoot = join(root, "project");
	const artifactRoot = join(root, "artifacts");
	mkdirSync(projectRoot);
	mkdirSync(artifactRoot);
	writeFileSync(
		join(projectRoot, "package.json"),
		JSON.stringify({
			name: "isolated-fixture",
			version: "1.0.0",
			scripts: { build: "node build.mjs" },
			dependencies: { "is-number": "7.0.0" },
		}),
	);
	writeFileSync(
		join(projectRoot, "package-lock.json"),
		JSON.stringify({
			name: "isolated-fixture",
			version: "1.0.0",
			lockfileVersion: 3,
			requires: true,
			packages: {
				"": { name: "isolated-fixture", version: "1.0.0", dependencies: { "is-number": "7.0.0" } },
				"node_modules/is-number": {
					version: "7.0.0",
					resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
					integrity:
						"sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==",
				},
			},
		}),
	);
	writeFileSync(
		join(projectRoot, "build.mjs"),
		[
			'import assert from "node:assert/strict";',
			'import { lookup } from "node:dns/promises";',
			'import { mkdirSync, writeFileSync } from "node:fs";',
			'import { createRequire } from "node:module";',
			'await assert.rejects(lookup("registry.npmjs.org"));',
			'await assert.rejects(fetch("https://example.org", { signal: AbortSignal.timeout(3000) }));',
			'await assert.rejects(fetch("https://1.1.1.1", { signal: AbortSignal.timeout(3000) }));',
			'assert.equal(createRequire(import.meta.url)("is-number")(7), true);',
			'mkdirSync("dist");',
			'writeFileSync("dist/index.html", "ok");',
		].join("\n"),
	);

	let result: BuildRunnerResult;
	try {
		result = await new EphemeralContainerBuildRunner({
			id: () => "integration-fixed",
			config: {
				engine: engine as "docker" | "podman",
				image,
				proxyImage,
				timeoutMs: 120_000,
				cpus: 1,
				memoryMb: 512,
				pidsLimit: 128,
				maxLogChars: 4_096,
				registryOrigins: ["https://registry.npmjs.org"],
			},
		}).build({ projectId: "real", projectRoot, artifactRoot, allowedOutputs: ["dist"] });
	} catch (error) {
		if (error instanceof BuildRunnerError) throw new Error(`${error.code}: ${(error.logs ?? []).join("\n")}`);
		throw error;
	}

	expect(readFileSync(join(result.serveRoot, "index.html"), "utf8")).toBe("ok");
	expect(existsSync(join(projectRoot, "node_modules"))).toBe(false);
	for (const [kind, name] of [
		["container", "pi-build-integration-fixed-proxy"],
		["container", "pi-build-integration-fixed-seed"],
		["container", "pi-build-integration-fixed-exporter"],
		["container", "pi-build-integration-fixed-restore"],
		["container", "pi-build-integration-fixed-build"],
		["network", "pi-build-integration-fixed-internal"],
		["network", "pi-build-integration-fixed-egress"],
		["volume", "pi-build-integration-fixed-workspace"],
		["volume", "pi-build-integration-fixed-cache"],
		["volume", "pi-build-integration-fixed-config"],
	] as const) {
		expect(spawnSync(engine, [kind, "inspect", name], { windowsHide: true }).status).not.toBe(0);
	}
}, 180_000);

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required; this integration test must not be skipped.`);
	return value;
}
