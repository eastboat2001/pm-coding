import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { loadStorageConfig } from "../src/config.js";
import type {
	ContainerCommand,
	ContainerCommandExecutor,
	ContainerCommandResult,
} from "../src/ephemeral-container-build-runner.js";
import { projectDirectory } from "../src/workspace-paths.js";
import { createWorkspaceTaskService } from "../src/workspace-task-factory.js";

const engine = required("PI_TEST_BUILD_CONTAINER_ENGINE");
const image = required("PI_TEST_BUILD_CONTAINER_IMAGE");
const proxyImage = required("PI_TEST_BUILD_PROXY_IMAGE");
const root = mkdtempSync(join(tmpdir(), "pi-real-container-runner-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

it("denies direct, off-allowlist, and literal-IP egress then restores and builds through the allowlisted registry", async () => {
	const config = integrationConfig();
	const projectRoot = projectDirectory(config.clientsRootDir, "real", "integration");
	mkdirSync(projectRoot, { recursive: true });
	const packageJson = JSON.stringify({
		name: "isolated-fixture",
		version: "1.0.0",
		scripts: { build: "node build.mjs" },
		dependencies: { "is-number": "7.0.0" },
	});
	const packageLock = JSON.stringify({
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
	});
	const buildSource = [
		'import { mkdirSync, writeFileSync } from "node:fs";',
		'import { createRequire } from "node:module";',
		'if (!createRequire(import.meta.url)("is-number")(7)) process.exit(2);',
		'mkdirSync("dist");',
		'writeFileSync("dist/index.html", "<!doctype html><script src=\\"./app.js\\"></script>");',
		'writeFileSync("dist/app.js", "document.body.dataset.ready = \'true\';");',
	].join("\n");
	writeFileSync(join(projectRoot, "package.json"), packageJson);
	writeFileSync(join(projectRoot, "package-lock.json"), packageLock);
	writeFileSync(join(projectRoot, "build.mjs"), buildSource);
	const probingExecutor = new ProxyProbingExecutor();
	const service = createWorkspaceTaskService(config, {
		containerBuildRunnerOptions: { id: () => "integration-fixed", executor: probingExecutor },
	});

	const result = await service.run({
		task: "build_static",
		clientId: "integration",
		sessionId: "real",
		title: "Real isolated build",
	});

	expect(result.status, `${result.failureCode}: ${(result.logs ?? []).join("\n")}`).toBe("passed");
	expect(result.serveRoot).toBe(join(projectRoot, "dist"));
	expect(readFileSync(join(projectRoot, "dist", "index.html"), "utf8")).toContain("app.js");
	expect(readFileSync(join(projectRoot, "dist", "app.js"), "utf8")).toContain("dataset.ready");
	expect(readFileSync(join(projectRoot, "package.json"), "utf8")).toBe(packageJson);
	expect(readFileSync(join(projectRoot, "package-lock.json"), "utf8")).toBe(packageLock);
	expect(readFileSync(join(projectRoot, "build.mjs"), "utf8")).toBe(buildSource);
	expect(existsSync(join(projectRoot, "node_modules"))).toBe(false);
	expect(probingExecutor.evidence).toEqual({
		allowedThroughProxy: true,
		directDenied: true,
		offAllowlistDenied: true,
		literalIpDenied: true,
	});
	const buildCommand = probingExecutor.commands.find((args) => args[0] === "run" && args.includes("build"));
	expect(buildCommand).toEqual(expect.arrayContaining(["--network", "none"]));
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

it("cleans every named resource after a real build failure", async () => {
	const config = integrationConfig();
	const projectRoot = projectDirectory(config.clientsRootDir, "failure", "integration");
	mkdirSync(projectRoot, { recursive: true });
	writeFileSync(
		join(projectRoot, "package.json"),
		JSON.stringify({ scripts: { build: 'node -e "process.exit(23)"' } }),
	);
	const service = createWorkspaceTaskService(config, {
		containerBuildRunnerOptions: { id: () => "integration-failure" },
	});
	const result = await service.run({
		task: "build_static",
		clientId: "integration",
		sessionId: "failure",
		title: "Real failing build",
	});
	expect(result).toMatchObject({ status: "failed", failureCode: "build.execution_failed" });
	assertNoResources("pi-build-integration-failure");
}, 180_000);

function integrationConfig() {
	const config = loadStorageConfig(root);
	return {
		...config,
		containerBuild: {
			...config.containerBuild,
			engine: requiredEngine(),
			image,
			proxyImage,
			maxLogChars: 4_096,
		},
	};
}

class ProxyProbingExecutor implements ContainerCommandExecutor {
	readonly commands: readonly string[][] = [];
	readonly evidence = {
		allowedThroughProxy: false,
		directDenied: false,
		offAllowlistDenied: false,
		literalIpDenied: false,
	};

	execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
		(this.commands as string[][]).push([...command.args]);
		const result = runCommand(executable, command);
		if (result.exitCode === 0 && command.args[0] === "network" && command.args[1] === "connect") {
			this.probe(executable, command.timeoutMs);
		}
		return Promise.resolve(result);
	}

	private probe(executable: string, timeoutMs: number): void {
		const proxyEnvironment = [
			"-e",
			"HTTPS_PROXY=http://proxy:3128",
			"-e",
			"HTTP_PROXY=http://proxy:3128",
			"-e",
			"NO_PROXY=",
		];
		const allowed = this.probeRequest(
			executable,
			timeoutMs,
			"https://registry.npmjs.org/is-number",
			proxyEnvironment,
			true,
		);
		if (allowed.exitCode !== 0) throw new Error(`allowlisted proxy readiness probe failed: ${allowed.stderr}`);
		this.evidence.allowedThroughProxy = true;
		this.evidence.offAllowlistDenied =
			this.probeRequest(executable, timeoutMs, "https://example.org", proxyEnvironment, false).exitCode === 0;
		this.evidence.literalIpDenied =
			this.probeRequest(executable, timeoutMs, "https://1.1.1.1", proxyEnvironment, false).exitCode === 0;
		this.evidence.directDenied =
			this.probeRequest(executable, timeoutMs, "https://registry.npmjs.org/is-number", [], false).exitCode === 0;
	}

	private probeRequest(
		executable: string,
		timeoutMs: number,
		url: string,
		environment: string[],
		expectSuccess: boolean,
	): ContainerCommandResult {
		const script = expectSuccess
			? `let last; for(let i=0;i<20;i++){try{const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(3000)});if(r.ok)process.exit(0);last=new Error(String(r.status))}catch(e){last=e}await new Promise(r=>setTimeout(r,250))}console.error(last);process.exit(20)`
			: `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(4000)}).then(()=>process.exit(21),()=>process.exit(0))`;
		return runCommand(executable, {
			args: [
				"run",
				"--rm",
				"--network",
				"pi-build-integration-fixed-internal",
				"--user",
				"1000:1000",
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--cpus",
				"1",
				"--memory",
				"128m",
				"--pids-limit",
				"32",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,nodev,size=16m",
				...environment,
				image,
				"node",
				"--use-env-proxy",
				"--input-type=module",
				"-e",
				script,
			],
			timeoutMs,
		});
	}
}

function runCommand(executable: string, command: ContainerCommand): ContainerCommandResult {
	const result = spawnSync(executable, [...command.args], {
		input: command.stdin,
		timeout: command.timeoutMs,
		windowsHide: true,
		encoding: "utf8",
	});
	if (result.error) throw result.error;
	return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function assertNoResources(prefix: string): void {
	for (const [kind, suffix] of [
		["container", "proxy"],
		["container", "seed"],
		["container", "exporter"],
		["container", "restore"],
		["container", "build"],
		["network", "internal"],
		["network", "egress"],
		["volume", "workspace"],
		["volume", "cache"],
		["volume", "config"],
	] as const)
		expect(spawnSync(engine, [kind, "inspect", `${prefix}-${suffix}`], { windowsHide: true }).status).not.toBe(0);
}

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} is required; this integration test must not be skipped.`);
	return value;
}

function requiredEngine(): "docker" | "podman" {
	if (engine === "docker" || engine === "podman") return engine;
	throw new Error("PI_TEST_BUILD_CONTAINER_ENGINE must be docker or podman.");
}
