import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, join, relative, sep } from "node:path";
import { inspectBuildManifest } from "./build-manifest-policy.js";
import {
	type BuildOutputDirectory,
	type BuildRunner,
	BuildRunnerError,
	type BuildRunnerInput,
	type BuildRunnerResult,
} from "./build-runner.js";

export interface ContainerCommand {
	args: readonly string[];
	stdin?: Uint8Array;
	timeoutMs: number;
	signal?: AbortSignal;
}

export interface ContainerCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface ContainerCommandExecutor {
	execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult>;
}

export interface ContainerBuildRunnerConfig {
	engine: "docker" | "podman";
	image: string;
	proxyImage: string;
	timeoutMs: number;
	cpus: number;
	memoryMb: number;
	pidsLimit: number;
	maxLogChars: number;
	registryOrigins: string[];
}

export interface EphemeralContainerBuildRunnerOptions {
	config: ContainerBuildRunnerConfig;
	executor?: ContainerCommandExecutor;
	now?: () => number;
	id?: () => string;
}

interface Resources {
	prefix: string;
	workspace: string;
	cache: string;
	config: string;
	internalNetwork: string;
	egressNetwork: string;
	proxy: string;
	seed: string;
	exporter: string;
}

const DIGEST_IMAGE = /^[^\s@]+@sha256:[0-9a-f]{64}$/;
const publicationLocks = new Map<string, Promise<void>>();

export class BuildRunnerCleanupError extends BuildRunnerError {
	readonly cause: BuildRunnerError | undefined;

	constructor(
		readonly primary: BuildRunnerError | undefined,
		readonly cleanupErrors: readonly string[],
		logs: readonly string[],
	) {
		super("build.cleanup_failed", "Container build cleanup failed.", logs);
		this.name = "BuildRunnerCleanupError";
		this.cause = primary;
	}
}

export class EphemeralContainerBuildRunner implements BuildRunner {
	private readonly config: ContainerBuildRunnerConfig;
	private readonly executor: ContainerCommandExecutor;
	private readonly now: () => number;
	private readonly id: () => string;

	constructor(options: EphemeralContainerBuildRunnerOptions) {
		this.config = options.config;
		this.executor = options.executor ?? new SpawnContainerCommandExecutor(this.config.maxLogChars);
		this.now = options.now ?? Date.now;
		this.id = options.id ?? (() => crypto.randomUUID());
	}

	async build(input: BuildRunnerInput): Promise<BuildRunnerResult> {
		this.validateConfig();
		if (input.signal?.aborted) throw new BuildRunnerError("build.cancelled", "Build was cancelled.");
		const plan = inspectBuildManifest({
			projectRoot: input.projectRoot,
			registryOrigins: this.config.registryOrigins,
		});
		const outputDirectories = plan.outputDirectories.filter((output) => input.allowedOutputs.includes(output));
		if (outputDirectories.length === 0)
			throw new BuildRunnerError("build.policy_rejected", "No authorized build output is available.");
		const startedAt = this.now();
		const resources = names(this.id());
		const logs: string[] = [];
		let result: BuildRunnerResult | undefined;
		let primaryError: BuildRunnerError | undefined;
		try {
			await this.createResources(resources, input.signal);
			await this.seedProject(resources, input, input.signal);
			await this.startProxy(resources, input.signal);
			if (plan.restoreCommand) {
				await this.runBuildContainer(resources, plan.restoreCommand, "restore", input.signal, logs);
			}
			await this.runBuildContainer(resources, plan.buildCommand, "build", input.signal, logs);
			const exported = await this.exportOutput(resources, input, outputDirectories, input.signal);
			result = {
				serveRoot: exported.serveRoot,
				outputDirectory: exported.outputDirectory,
				files: exported.files,
				logs: this.sanitizeLogs(logs),
				durationMs: Math.max(0, this.now() - startedAt),
			};
		} catch (error) {
			primaryError = this.normalizeError(error, logs, input.signal);
		}
		const cleanupErrors = await this.cleanup(resources);
		if (cleanupErrors.length > 0) {
			const sanitizedCleanupErrors = cleanupErrors.flatMap((error) => this.sanitizeLogs([error]));
			throw new BuildRunnerCleanupError(primaryError, sanitizedCleanupErrors, this.sanitizeLogs(cleanupErrors));
		}
		if (primaryError) throw primaryError;
		if (!result) throw new BuildRunnerError("build.execution_failed", "Container build did not produce a result.");
		return result;
	}

	private validateConfig(): void {
		if (!this.config.image || !this.config.proxyImage) {
			throw new BuildRunnerError("build.config_missing", "Build and proxy images are required.");
		}
		if (!DIGEST_IMAGE.test(this.config.image) || !DIGEST_IMAGE.test(this.config.proxyImage)) {
			throw new BuildRunnerError("build.policy_rejected", "Build and proxy images must be pinned by sha256 digest.");
		}
		if (
			!(this.config.timeoutMs > 0) ||
			!(this.config.cpus > 0) ||
			!(this.config.memoryMb > 0) ||
			!(this.config.pidsLimit > 0) ||
			!(this.config.maxLogChars > 0)
		) {
			throw new BuildRunnerError("build.config_missing", "Positive container resource limits are required.");
		}
		proxyConfiguration(this.config.registryOrigins);
	}

	private async createResources(resources: Resources, signal?: AbortSignal): Promise<void> {
		for (const volume of [resources.workspace, resources.cache, resources.config]) {
			await this.required(["volume", "create", "--label", `pi.build=${resources.prefix}`, volume], signal);
		}
		await this.required(
			["network", "create", "--internal", "--label", `pi.build=${resources.prefix}`, resources.internalNetwork],
			signal,
		);
		await this.required(
			["network", "create", "--label", `pi.build=${resources.prefix}`, resources.egressNetwork],
			signal,
		);
	}

	private async seedProject(resources: Resources, input: BuildRunnerInput, signal?: AbortSignal): Promise<void> {
		await this.required(
			[
				"create",
				"--name",
				resources.seed,
				"--network",
				"none",
				...this.containerHardening("1000:1000", "16m"),
				"--mount",
				`type=volume,src=${resources.workspace},dst=/workspace`,
				this.config.image,
				"sh",
				"-c",
				"true",
			],
			signal,
		);
		await this.required(["cp", `${input.projectRoot}${sep}.`, `${resources.seed}:/workspace`], signal);
		await this.required(["start", "-a", resources.seed], signal);
		await this.required(
			[
				"run",
				"--rm",
				"--network",
				"none",
				...this.containerHardening("0:0", "16m"),
				"--cap-add",
				"CHOWN",
				"--mount",
				`type=volume,src=${resources.workspace},dst=/workspace`,
				"--mount",
				`type=volume,src=${resources.cache},dst=/cache`,
				"--entrypoint",
				"chown",
				this.config.image,
				"-R",
				"1000:1000",
				"/workspace",
				"/cache",
			],
			signal,
		);
		const config = new TextEncoder().encode(proxyConfiguration(this.config.registryOrigins));
		await this.required(
			[
				"run",
				"--rm",
				"-i",
				"--network",
				"none",
				...this.containerHardening("0:0", "16m"),
				"--cap-add",
				"CHOWN",
				"--mount",
				`type=volume,src=${resources.config},dst=/config`,
				"--entrypoint",
				"sh",
				this.config.proxyImage,
				"-c",
				"umask 077 && cat > /config/squid.conf && chown 13:13 /config/squid.conf",
			],
			signal,
			config,
		);
	}

	private async startProxy(resources: Resources, signal?: AbortSignal): Promise<void> {
		await this.required(
			[
				"run",
				"-d",
				"--name",
				resources.proxy,
				"--hostname",
				"proxy",
				"--network",
				resources.internalNetwork,
				...this.containerHardening("13:13", "16m"),
				"--mount",
				`type=volume,src=${resources.config},dst=/config,readonly`,
				"--entrypoint",
				"squid",
				this.config.proxyImage,
				"-f",
				"/config/squid.conf",
				"-NYC",
			],
			signal,
		);
		await this.required(["network", "connect", resources.egressNetwork, resources.proxy], signal);
	}

	private async runBuildContainer(
		resources: Resources,
		command: readonly string[],
		phase: "restore" | "build",
		signal: AbortSignal | undefined,
		logs: string[],
	): Promise<void> {
		const args = [
			"run",
			"--rm",
			"--name",
			`${resources.prefix}-${phase}`,
			"--network",
			phase === "restore" ? resources.internalNetwork : "none",
			...this.containerHardening("1000:1000", "64m"),
			"--mount",
			`type=volume,src=${resources.workspace},dst=/workspace`,
			"--mount",
			`type=volume,src=${resources.cache},dst=/home/node/.npm`,
			"--workdir",
			"/workspace",
			"-e",
			"HOME=/home/node",
			"-e",
			"NO_PROXY=",
			...(phase === "restore" ? ["-e", "HTTPS_PROXY=http://proxy:3128", "-e", "HTTP_PROXY=http://proxy:3128"] : []),
			this.config.image,
			...command,
		];
		const result = await this.execute(args, signal);
		logs.push(result.stdout, result.stderr);
		if (result.exitCode === 0) return;
		if (result.exitCode === 124)
			throw new BuildRunnerError("build.timeout", "Container build timed out.", this.sanitizeLogs(logs));
		throw new BuildRunnerError(
			phase === "restore" ? "build.dependency_restore_failed" : "build.execution_failed",
			`${phase} container failed.`,
			this.sanitizeLogs(logs),
		);
	}

	private async exportOutput(
		resources: Resources,
		input: BuildRunnerInput,
		outputs: readonly BuildOutputDirectory[],
		signal?: AbortSignal,
	): Promise<{ serveRoot: string; outputDirectory: BuildOutputDirectory; files: string[] }> {
		assertSimpleProjectId(input.projectId);
		if (lstatSync(input.artifactRoot).isSymbolicLink())
			throw new BuildRunnerError("build.output_escape", "Artifact root cannot be a symbolic link.");
		const artifactRoot = realpathSync(input.artifactRoot);
		if (!lstatSync(artifactRoot).isDirectory())
			throw new BuildRunnerError("build.output_escape", "Artifact root is not a directory.");
		return withPublicationLock(publicationKey(artifactRoot, input.projectId), async () => {
			await this.required(
				[
					"create",
					"--name",
					resources.exporter,
					"--network",
					"none",
					...this.containerHardening("1000:1000", "16m"),
					"--mount",
					`type=volume,src=${resources.workspace},dst=/workspace,readonly`,
					this.config.image,
					"true",
				],
				signal,
			);
			for (const output of outputs) {
				const stage = join(artifactRoot, `.${input.projectId}-${resources.prefix}-stage`);
				const destination = join(artifactRoot, input.projectId);
				const backup = join(artifactRoot, `.${input.projectId}-${resources.prefix}-backup`);
				let movedExisting = false;
				let published = false;
				try {
					rmSync(stage, { recursive: true, force: true });
					rmSync(backup, { recursive: true, force: true });
					mkdirSync(stage);
					const copied = await this.execute(["cp", `${resources.exporter}:/workspace/${output}/.`, stage], signal);
					if (copied.exitCode !== 0) continue;
					const files = authorizeTree(stage);
					if (lstatOrUndefined(destination)) {
						renameSync(destination, backup);
						movedExisting = true;
					}
					renameSync(stage, destination);
					published = true;
					return { serveRoot: destination, outputDirectory: output, files };
				} catch (error) {
					if (movedExisting && lstatOrUndefined(backup) && !lstatOrUndefined(destination))
						renameSync(backup, destination);
					throw error;
				} finally {
					rmSync(stage, { recursive: true, force: true });
					if (published || !movedExisting || lstatOrUndefined(destination))
						rmSync(backup, { recursive: true, force: true });
				}
			}
			throw new BuildRunnerError("build.output_missing", "No authorized build output was produced.");
		});
	}

	private hardening(user: string): string[] {
		return [
			"--user",
			user,
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--cpus",
			String(this.config.cpus),
			"--memory",
			`${this.config.memoryMb}m`,
			"--pids-limit",
			String(this.config.pidsLimit),
		];
	}

	private containerHardening(user: string, tmpSize: string): string[] {
		return [...this.hardening(user), "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${tmpSize}`];
	}

	private async required(args: readonly string[], signal?: AbortSignal, stdin?: Uint8Array): Promise<void> {
		const result = await this.execute(args, signal, stdin);
		if (result.exitCode !== 0)
			throw new BuildRunnerError(
				"build.engine_unavailable",
				"Container engine command failed.",
				this.sanitizeLogs([result.stderr]),
			);
	}

	private async execute(
		args: readonly string[],
		signal?: AbortSignal,
		stdin?: Uint8Array,
	): Promise<ContainerCommandResult> {
		try {
			return await this.executor.execute(this.config.engine, {
				args,
				stdin,
				timeoutMs: this.config.timeoutMs,
				signal,
			});
		} catch (error) {
			if (
				error instanceof BuildRunnerError ||
				(error instanceof Error && (error.name === "AbortError" || error.name === "ContainerTimeoutError"))
			)
				throw error;
			throw new BuildRunnerError("build.engine_unavailable", "Container engine could not be executed.");
		}
	}

	private async cleanup(resources: Resources): Promise<string[]> {
		const errors: string[] = [];
		for (const container of [
			resources.proxy,
			resources.seed,
			resources.exporter,
			`${resources.prefix}-restore`,
			`${resources.prefix}-build`,
		]) {
			const result = await this.execute(["rm", "-f", container]).catch((error: unknown) => ({
				exitCode: 1,
				stdout: "",
				stderr: String(error),
			}));
			if (result.exitCode !== 0 && !/No such (container|object)/i.test(result.stderr)) errors.push(result.stderr);
		}
		for (const network of [resources.internalNetwork, resources.egressNetwork]) {
			const result = await this.execute(["network", "rm", network]).catch((error: unknown) => ({
				exitCode: 1,
				stdout: "",
				stderr: String(error),
			}));
			if (result.exitCode !== 0 && !/not found|No such network/i.test(result.stderr)) errors.push(result.stderr);
		}
		for (const volume of [resources.workspace, resources.cache, resources.config]) {
			const result = await this.execute(["volume", "rm", "-f", volume]).catch((error: unknown) => ({
				exitCode: 1,
				stdout: "",
				stderr: String(error),
			}));
			if (result.exitCode !== 0 && !/not found|No such volume/i.test(result.stderr)) errors.push(result.stderr);
		}
		return errors;
	}

	private normalizeError(error: unknown, logs: string[], signal?: AbortSignal): BuildRunnerError {
		if (error instanceof BuildRunnerError) return error;
		if (signal?.aborted || (error instanceof Error && error.name === "AbortError"))
			return new BuildRunnerError("build.cancelled", "Build was cancelled.", this.sanitizeLogs(logs));
		if (error instanceof Error && error.name === "ContainerTimeoutError")
			return new BuildRunnerError("build.timeout", "Container build timed out.", this.sanitizeLogs(logs));
		return new BuildRunnerError(
			"build.execution_failed",
			"Container build failed.",
			this.sanitizeLogs([...logs, error instanceof Error ? error.message : String(error)]),
		);
	}

	private sanitizeLogs(parts: readonly string[]): string[] {
		let text = parts
			.filter(Boolean)
			.join("\n")
			.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
			.replace(/\bauthorization\s*[=:]\s*(?:(?:bearer|basic)\s+)?[^\s]+/gi, "Authorization=[redacted]")
			.replace(/\b[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*\s*[=:]\s*[^\s]+/gi, "credential=[redacted]");
		if (text.length > this.config.maxLogChars) text = text.slice(0, this.config.maxLogChars);
		return text ? [text] : [];
	}
}

export class SpawnContainerCommandExecutor implements ContainerCommandExecutor {
	constructor(private readonly maxOutputChars: number) {}

	async execute(executable: string, command: ContainerCommand): Promise<ContainerCommandResult> {
		if (command.signal?.aborted) throw abortError();
		return new Promise((resolvePromise, reject) => {
			const child = spawn(executable, [...command.args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, command.timeoutMs);
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = appendBounded(stdout, chunk.toString("utf8"), this.maxOutputChars);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = appendBounded(stderr, chunk.toString("utf8"), this.maxOutputChars);
			});
			const abort = () => child.kill("SIGKILL");
			command.signal?.addEventListener("abort", abort, { once: true });
			if (command.signal?.aborted) abort();
			child.on("error", reject);
			child.on("close", (code) => {
				clearTimeout(timer);
				command.signal?.removeEventListener("abort", abort);
				if (timedOut) {
					const error = new Error("Container command timed out.");
					error.name = "ContainerTimeoutError";
					reject(error);
					return;
				}
				if (command.signal?.aborted) {
					const error = new Error("Container command aborted.");
					error.name = "AbortError";
					reject(error);
					return;
				}
				resolvePromise({ exitCode: code ?? 1, stdout, stderr });
			});
			if (command.stdin) child.stdin.end(command.stdin);
			else child.stdin.end();
		});
	}
}

function appendBounded(current: string, addition: string, limit: number): string {
	if (current.length >= limit) return current;
	return current + addition.slice(0, limit - current.length);
}

function abortError(): Error {
	const error = new Error("Container command aborted.");
	error.name = "AbortError";
	return error;
}

async function withPublicationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
	const previous = publicationLocks.get(key) ?? Promise.resolve();
	let release = (): void => {};
	const gate = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	const tail = previous.catch(() => {}).then(() => gate);
	publicationLocks.set(key, tail);
	await previous.catch(() => {});
	try {
		return await operation();
	} finally {
		release();
		if (publicationLocks.get(key) === tail) publicationLocks.delete(key);
	}
}

function publicationKey(artifactRoot: string, projectId: string): string {
	const key = join(artifactRoot, projectId);
	return process.platform === "win32" ? key.toLowerCase() : key;
}

function names(rawId: string): Resources {
	const id = rawId
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.slice(0, 40);
	if (!id) throw new BuildRunnerError("build.policy_rejected", "Container build identifier is invalid.");
	const prefix = `pi-build-${id}`;
	return {
		prefix,
		workspace: `${prefix}-workspace`,
		cache: `${prefix}-cache`,
		config: `${prefix}-config`,
		internalNetwork: `${prefix}-internal`,
		egressNetwork: `${prefix}-egress`,
		proxy: `${prefix}-proxy`,
		seed: `${prefix}-seed`,
		exporter: `${prefix}-exporter`,
	};
}

function proxyConfiguration(origins: readonly string[]): string {
	if (origins.length === 0)
		throw new BuildRunnerError("build.config_missing", "At least one registry origin is required.");
	const normalized = new Map<string, { hostname: string; port: number }>();
	for (const origin of origins) {
		let url: URL;
		try {
			url = new URL(origin);
		} catch {
			throw new BuildRunnerError("build.policy_rejected", "Registry origin is invalid.");
		}
		if (
			url.protocol !== "https:" ||
			url.pathname !== "/" ||
			url.search ||
			url.hash ||
			url.username ||
			url.password ||
			isNumericHostname(url.hostname)
		) {
			throw new BuildRunnerError("build.policy_rejected", "Registry origins must be pure HTTPS hostname origins.");
		}
		const hostname = url.hostname.toLowerCase();
		const port = url.port ? Number(url.port) : 443;
		normalized.set(`${hostname}:${port}`, { hostname, port });
	}
	const accessRules: string[] = [];
	let index = 0;
	for (const { hostname, port } of normalized.values()) {
		accessRules.push(
			`acl origin_${index}_host dstdomain ${hostname}`,
			`acl origin_${index}_port port ${port}`,
			`http_access allow CONNECT origin_${index}_host origin_${index}_port`,
			`http_access allow origin_${index}_host origin_${index}_port`,
		);
		index++;
	}
	return [
		"http_port 3128",
		"acl CONNECT method CONNECT",
		...accessRules,
		"http_access deny all",
		"cache deny all",
		"access_log none",
		"cache_log /dev/null",
		"cache_store_log none",
		"pid_filename none",
		"coredump_dir /tmp",
		"visible_hostname proxy",
		"",
	].join("\n");
}

function isNumericHostname(hostname: string): boolean {
	const candidate = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return isIP(candidate) !== 0;
}

function assertSimpleProjectId(projectId: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(projectId))
		throw new BuildRunnerError("build.output_escape", "Project identifier is unsafe.");
}

function authorizeTree(root: string): string[] {
	const canonicalRoot = realpathSync(root);
	const files: string[] = [];
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const stats = lstatSync(path);
			if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile()))
				throw new BuildRunnerError("build.output_escape", "Build output contains an unsafe entry.");
			const canonical = realpathSync(path);
			const rel = relative(canonicalRoot, canonical);
			if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
				throw new BuildRunnerError("build.output_escape", "Build output escapes staging.");
			if (stats.isDirectory()) visit(path);
			else files.push(relative(root, path).replaceAll("\\", "/"));
		}
	};
	visit(root);
	return files.sort();
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
