import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BuildRunnerError } from "../src/build-runner.js";
import {
	type ContainerCommand,
	type ContainerCommandExecutor,
	type ContainerCommandResult,
	EphemeralContainerBuildRunner,
} from "../src/ephemeral-container-build-runner.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class FakeExecutor implements ContainerCommandExecutor {
	readonly commands: Array<{ executable: string; command: ContainerCommand }> = [];
	constructor(private readonly response?: (args: readonly string[]) => ContainerCommandResult) {}
	async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
		this.commands.push({ executable, command });
		if (
			command.args[0] === "cp" &&
			command.args[1]?.includes(":/workspace/") &&
			!command.args.at(-1)?.includes(":")
		) {
			const destination = command.args.at(-1);
			if (destination) {
				mkdirSync(destination, { recursive: true });
				writeFileSync(join(destination, "index.html"), "<h1>ok</h1>");
			}
		}
		return this.response?.(command.args) ?? { exitCode: 0, stdout: "", stderr: "" };
	}
}

function fixture(): { projectRoot: string; artifactRoot: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-container-runner-"));
	roots.push(root);
	const projectRoot = join(root, "project");
	const artifactRoot = join(root, "artifacts");
	mkdirSync(projectRoot);
	mkdirSync(artifactRoot);
	writeFileSync(
		join(projectRoot, "package.json"),
		JSON.stringify({
			scripts: { build: "mkdir -p dist && echo ok > dist/index.html" },
			dependencies: { "is-number": "7.0.0" },
		}),
	);
	writeFileSync(
		join(projectRoot, "package-lock.json"),
		JSON.stringify({
			lockfileVersion: 3,
			packages: {
				"": { dependencies: { "is-number": "7.0.0" } },
				"node_modules/is-number": {
					version: "7.0.0",
					resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
				},
			},
		}),
	);
	return { projectRoot, artifactRoot };
}

function runner(
	executor: ContainerCommandExecutor,
	overrides: Partial<ConstructorParameters<typeof EphemeralContainerBuildRunner>[0]["config"]> = {},
) {
	return new EphemeralContainerBuildRunner({
		executor,
		id: () => "fixed-id",
		now: (() => {
			let value = 0;
			return () => value++;
		})(),
		config: {
			engine: "docker",
			image: "node@sha256:e21fc383b50d5347dc7a9f1cae45b8f4e2f0d39f7ade28e4eef7d2934522b752",
			proxyImage: "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
			timeoutMs: 30_000,
			cpus: 1,
			memoryMb: 256,
			pidsLimit: 64,
			maxLogChars: 256,
			registryOrigins: ["https://registry.npmjs.org"],
			...overrides,
		},
	});
}

it("uses named storage and a proxy-only egress topology with hardened containers", async () => {
	const executor = new FakeExecutor();
	const paths = fixture();
	await runner(executor).build({ projectId: "project", ...paths, allowedOutputs: ["dist"] });

	const allArgs = executor.commands.flatMap(({ command }) => command.args);
	expect(allArgs.join(" ")).not.toContain("/var/run/docker.sock");
	expect(allArgs.filter((arg) => arg.startsWith("type=bind") || arg.startsWith(`${paths.projectRoot}:`))).toEqual([]);
	expect(
		executor.commands.filter(({ command }) => command.args[0] === "volume" && command.args[1] === "create"),
	).toHaveLength(3);
	const runs = executor.commands.filter(({ command }) => command.args[0] === "run");
	const restore = runs.find(({ command }) => command.args.includes("ci"));
	const build = runs.find(({ command }) => command.args.includes("build"));
	const proxy = runs.find(({ command }) => command.args.includes("--hostname") && command.args.includes("proxy"));
	for (const entry of [restore, build, proxy]) {
		expect(entry?.command.args).toEqual(
			expect.arrayContaining([
				"--read-only",
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--cpus",
				"1",
				"--memory",
				"256m",
				"--pids-limit",
				"64",
			]),
		);
	}
	expect(restore?.command.args).toEqual(
		expect.arrayContaining([
			"--network",
			"pi-build-fixed-id-internal",
			"-e",
			"HTTPS_PROXY=http://proxy:3128",
			"-e",
			"NO_PROXY=",
		]),
	);
	expect(build?.command.args).toEqual(expect.arrayContaining(["--network", "none"]));
	expect(proxy?.command.args).toContain("pi-build-fixed-id-internal");
	expect(
		executor.commands.some(
			({ command }) =>
				command.args[0] === "network" &&
				command.args[1] === "connect" &&
				command.args.includes("pi-build-fixed-id-egress"),
		),
	).toBe(true);
	const config = executor.commands.find(({ command }) => command.stdin)?.command.stdin;
	const configText = config ? new TextDecoder().decode(config) : "";
	expect(configText).toContain("registry.npmjs.org");
	expect(configText).toContain("port 443");
	expect(configText).toContain("deny");
	expect(configText).toContain("cache deny all");
	expect(configText).toMatch(/access_log\s+none/);
});

it("rejects missing or mutable images before invoking an engine", async () => {
	for (const overrides of [{ image: "" }, { image: "node:22" }, { proxyImage: "ubuntu/squid:latest" }]) {
		const executor = new FakeExecutor();
		const error = await runner(executor, overrides)
			.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(BuildRunnerError);
		expect((error as BuildRunnerError).code).toMatch(/build\.(config_missing|policy_rejected)/);
		expect(executor.commands).toEqual([]);
	}
});

it("cleans every named resource after timeout and redacts bounded logs", async () => {
	const executor = new FakeExecutor((args) =>
		args.includes("ci")
			? { exitCode: 124, stdout: "", stderr: `https://user:secret@registry.npmjs.org/${"x".repeat(500)}` }
			: { exitCode: 0, stdout: "", stderr: "" },
	);
	const error = await runner(executor)
		.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(error).toBeInstanceOf(BuildRunnerError);
	expect((error as BuildRunnerError).code).toBe("build.timeout");
	expect((error as BuildRunnerError).logs?.join("\n")).not.toContain("secret");
	expect((error as BuildRunnerError).logs?.join("\n").length).toBeLessThanOrEqual(256);
	const cleanup = executor.commands.filter(({ command }) => command.args.includes("rm"));
	expect(cleanup.some(({ command }) => command.args[0] === "network")).toBe(true);
	expect(cleanup.some(({ command }) => command.args[0] === "volume")).toBe(true);
});

it("cleans named resources when dependency restore is cancelled", async () => {
	const controller = new AbortController();
	class CancellingExecutor extends FakeExecutor {
		override async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
			if (command.args.includes("ci")) {
				controller.abort();
				const error = new Error("cancelled");
				error.name = "AbortError";
				throw error;
			}
			return super.execute(executable, command);
		}
	}
	const executor = new CancellingExecutor();
	const error = await runner(executor)
		.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"], signal: controller.signal })
		.catch((value: unknown) => value);
	expect(error).toBeInstanceOf(BuildRunnerError);
	expect((error as BuildRunnerError).code).toBe("build.cancelled");
	expect(executor.commands.some(({ command }) => command.args[0] === "network" && command.args[1] === "rm")).toBe(
		true,
	);
	expect(executor.commands.some(({ command }) => command.args[0] === "volume" && command.args[1] === "rm")).toBe(true);
});

it("rejects a linked artifact root instead of publishing through it", async () => {
	const paths = fixture();
	const outside = join(paths.artifactRoot, "..", "outside");
	rmSync(paths.artifactRoot, { recursive: true, force: true });
	mkdirSync(outside);
	symlinkSync(outside, paths.artifactRoot, process.platform === "win32" ? "junction" : "dir");
	const error = await runner(new FakeExecutor())
		.build({ projectId: "p", ...paths, allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(error).toBeInstanceOf(BuildRunnerError);
	expect((error as BuildRunnerError).code).toBe("build.output_escape");
});
