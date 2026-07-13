import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BuildRunnerError } from "../src/build-runner.js";
import {
	BuildRunnerCleanupError,
	type ContainerCommand,
	type ContainerCommandExecutor,
	type ContainerCommandResult,
	EphemeralContainerBuildRunner,
	SpawnContainerCommandExecutor,
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
	id = "fixed-id",
) {
	return new EphemeralContainerBuildRunner({
		executor,
		id: () => id,
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
	const containers = executor.commands.filter(
		({ command }) => command.args[0] === "run" || command.args[0] === "create",
	);
	for (const entry of containers) {
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
				"--tmpfs",
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

it("generates exact host and port pairs without cross-pair authorization", async () => {
	const executor = new FakeExecutor();
	await runner(executor, {
		registryOrigins: ["https://registry.npmjs.org", "https://a.example", "https://b.example:8443"],
	}).build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] });
	const bytes = executor.commands.find(({ command }) => command.stdin)?.command.stdin;
	const config = bytes ? new TextDecoder().decode(bytes) : "";
	expect(config).toContain("acl origin_1_host dstdomain a.example");
	expect(config).toContain("acl origin_1_port port 443");
	expect(config).toContain("http_access allow CONNECT origin_1_host origin_1_port");
	expect(config).toContain("acl origin_2_host dstdomain b.example");
	expect(config).toContain("acl origin_2_port port 8443");
	expect(config).toContain("http_access allow CONNECT origin_2_host origin_2_port");
	expect(config).not.toContain("allowed_hosts");
	expect(config).not.toContain("allowed_ports");
	const numericError = await runner(new FakeExecutor(), { registryOrigins: ["https://127.0.0.1"] })
		.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(numericError).toMatchObject({ code: "build.policy_rejected" });
});

it("emits an exact dstdomain ACL without sibling or subdomain wildcard semantics", async () => {
	const executor = new FakeExecutor();
	await runner(executor, { registryOrigins: ["https://registry.npmjs.org"] }).build({
		projectId: "p",
		...fixture(),
		allowedOutputs: ["dist"],
	});
	const bytes = executor.commands.find(({ command }) => command.stdin)?.command.stdin;
	const config = bytes ? new TextDecoder().decode(bytes) : "";

	expect(config).toContain("acl origin_0_host dstdomain registry.npmjs.org");
	expect(config).not.toContain("dstdomain .registry.npmjs.org");
	expect(config).not.toContain("dstdomain npmjs.org");
});

it("rejects a suffix-wildcard registry hostname before invoking the engine", async () => {
	const executor = new FakeExecutor();
	const error = await runner(executor, { registryOrigins: ["https://.example.com"] })
		.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);

	expect(error).toMatchObject({
		code: "build.policy_rejected",
		message: "Registry origins must be exact HTTPS DNS hostname origins.",
	});
	expect(executor.commands).toEqual([]);
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
			? {
					exitCode: 124,
					stdout: "",
					stderr: `NPM_TOKEN=npm-secret API_KEY=api-secret Authorization: Bearer bearer-secret https://user:url-secret@registry.npmjs.org/${"x".repeat(500)}`,
				}
			: { exitCode: 0, stdout: "", stderr: "" },
	);
	const error = await runner(executor)
		.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(error).toBeInstanceOf(BuildRunnerError);
	expect((error as BuildRunnerError).code).toBe("build.timeout");
	for (const secret of ["npm-secret", "api-secret", "bearer-secret", "url-secret"]) {
		expect((error as BuildRunnerError).logs?.join("\n")).not.toContain(secret);
	}
	expect((error as BuildRunnerError).logs?.join("\n")).toContain("[redacted]");
	expect((error as BuildRunnerError).logs?.join("\n").length).toBeLessThanOrEqual(256);
	const cleanup = executor.commands.filter(({ command }) => command.args.includes("rm"));
	expect(cleanup.some(({ command }) => command.args[0] === "network")).toBe(true);
	expect(cleanup.some(({ command }) => command.args[0] === "volume")).toBe(true);
});

it.each([
	[
		"container",
		"pi-build-fixed-id-proxy",
		(args: readonly string[]) => args[0] === "rm" && args.at(-1) === "pi-build-fixed-id-proxy",
	],
	[
		"network",
		"pi-build-fixed-id-internal",
		(args: readonly string[]) =>
			args[0] === "network" && args[1] === "rm" && args.at(-1) === "pi-build-fixed-id-internal",
	],
	[
		"volume",
		"pi-build-fixed-id-workspace",
		(args: readonly string[]) =>
			args[0] === "volume" && args[1] === "rm" && args.at(-1) === "pi-build-fixed-id-workspace",
	],
] as const)(
	"preserves the primary failure and surfaces %s cleanup failures",
	async (_kind, resourceName, failsCleanup) => {
		const executor = new FakeExecutor((args) => {
			if (args.includes("ci")) return { exitCode: 124, stdout: "", stderr: "primary timeout" };
			if (failsCleanup(args)) return { exitCode: 1, stdout: "", stderr: `cleanup failed: ${args.at(-1)}` };
			return { exitCode: 0, stdout: "", stderr: "" };
		});
		const error = await runner(executor)
			.build({ projectId: "p", ...fixture(), allowedOutputs: ["dist"] })
			.catch((value: unknown) => value);
		expect(error).toBeInstanceOf(BuildRunnerCleanupError);
		expect((error as BuildRunnerCleanupError).code).toBe("build.cleanup_failed");
		expect((error as BuildRunnerCleanupError).primary).toMatchObject({ code: "build.timeout" });
		expect((error as BuildRunnerCleanupError).cleanupErrors).not.toHaveLength(0);
		expect((error as BuildRunnerCleanupError).cleanupErrors.join("\n")).toContain(resourceName);
		expect(executor.commands.filter(({ command }) => command.args[0] === "rm")).toHaveLength(5);
		expect(
			executor.commands.filter(({ command }) => command.args[0] === "network" && command.args[1] === "rm"),
		).toHaveLength(2);
		expect(
			executor.commands.filter(({ command }) => command.args[0] === "volume" && command.args[1] === "rm"),
		).toHaveLength(3);
	},
);

it("default executor rejects a pre-aborted signal and an abort immediately after registration", async () => {
	const executor = new SpawnContainerCommandExecutor(256);
	const preAborted = new AbortController();
	preAborted.abort();
	await expect(
		executor.execute(process.execPath, {
			args: ["-e", "process.exit(17)"],
			timeoutMs: 5_000,
			signal: preAborted.signal,
		}),
	).rejects.toMatchObject({ name: "AbortError" });

	const racing = new AbortController();
	const execution = executor.execute(process.execPath, {
		args: ["-e", "setTimeout(() => {}, 10000)"],
		timeoutMs: 15_000,
		signal: racing.signal,
	});
	racing.abort();
	await expect(execution).rejects.toMatchObject({ name: "AbortError" });
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

it("cleans staging and backup paths when output authorization fails", async () => {
	const paths = fixture();
	const outside = join(paths.artifactRoot, "..", "unsafe-output-target");
	mkdirSync(outside);
	class UnsafeOutputExecutor extends FakeExecutor {
		override async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
			const result = await super.execute(executable, command);
			if (command.args[0] === "cp" && command.args[1]?.includes("-exporter:/workspace/")) {
				const destination = command.args.at(-1);
				if (destination)
					symlinkSync(outside, join(destination, "escape"), process.platform === "win32" ? "junction" : "dir");
			}
			return result;
		}
	}
	const error = await runner(new UnsafeOutputExecutor())
		.build({ projectId: "p", ...paths, allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(error).toMatchObject({ code: "build.output_escape" });
	expect(
		readdirSync(paths.artifactRoot).filter((name) => name.includes("-stage") || name.includes("-backup")),
	).toEqual([]);
});

it("preserves published output and cleans temporary paths when replacement rename fails", async () => {
	const paths = fixture();
	const destination = join(paths.artifactRoot, "p");
	mkdirSync(destination);
	writeFileSync(join(destination, "old.html"), "old");
	class RenameFailureExecutor extends FakeExecutor {
		override async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
			const result = await super.execute(executable, command);
			if (command.args[0] === "cp" && command.args[1]?.includes("-exporter:/workspace/")) {
				mkdirSync(join(paths.artifactRoot, ".p-pi-build-fixed-id-backup"));
			}
			return result;
		}
	}
	const error = await runner(new RenameFailureExecutor())
		.build({ projectId: "p", ...paths, allowedOutputs: ["dist"] })
		.catch((value: unknown) => value);
	expect(error).toMatchObject({ code: "build.execution_failed" });
	expect(readdirSync(destination)).toContain("old.html");
	expect(
		readdirSync(paths.artifactRoot).filter((name) => name.includes("-stage") || name.includes("-backup")),
	).toEqual([]);
});

it("serializes publication for concurrent builds of the same project", async () => {
	const paths = fixture();
	let exportCopies = 0;
	let releaseFirst: (() => void) | undefined;
	const firstBlocked = new Promise<void>((resolvePromise) => {
		releaseFirst = resolvePromise;
	});
	let firstReached: (() => void) | undefined;
	const firstAtExport = new Promise<void>((resolvePromise) => {
		firstReached = resolvePromise;
	});
	class BlockingExportExecutor extends FakeExecutor {
		override async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
			const result = await super.execute(executable, command);
			if (command.args[0] === "cp" && command.args[1]?.includes("-exporter:/workspace/")) {
				exportCopies++;
				if (exportCopies === 1) {
					firstReached?.();
					await firstBlocked;
				}
			}
			return result;
		}
	}
	const executor = new BlockingExportExecutor();
	const input = { projectId: "same-project", ...paths, allowedOutputs: ["dist"] as const };
	const first = runner(executor, {}, "publication-a").build(input);
	await firstAtExport;
	const second = runner(executor, {}, "publication-b").build(input);
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	expect(exportCopies).toBe(1);
	releaseFirst?.();
	await Promise.all([first, second]);
	expect(exportCopies).toBe(2);
});
