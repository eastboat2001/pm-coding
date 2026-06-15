import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { PROJECT_LOG_MAX_CHARS } from "./constants.js";
import type { ProjectBashRequest, ProjectBashResult, StorageConfig } from "./types.js";
import { migrateLegacyProjectDir, removeSiblingProjectDirs, workspaceContext } from "./workspace-paths.js";

export class WorkspaceCommandService {
	constructor(private readonly config: StorageConfig) {}

	async run(body: ProjectBashRequest): Promise<ProjectBashResult> {
		const { clientId, projectDir, sessionId } = workspaceContext(this.config, body);
		migrateLegacyProjectDir(this.config.projectsRootDir, projectDir, sessionId, clientId);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId, clientId);
		const command = String(body.command || "").trim();
		if (!command) throw new Error("Field `command` is required.");
		const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs || this.config.projectBuildTimeoutMs), 300000));
		const logs: string[] = [];
		try {
			await runCommand(command, projectDir, timeoutMs, logs);
		} catch (error) {
			throw new Error(formatCommandFailure(error, logs));
		}
		const output = truncateProjectLogs(logs).join("").trim();
		return {
			command,
			projectRoot: projectDir,
			output: output || "Command completed successfully.",
		};
	}
}

export function runCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
	logs: string[],
	signal?: AbortSignal,
): Promise<void> {
	const trimmedCommand = command.trim();
	if (!trimmedCommand) return Promise.resolve();
	if (isUnsafeProjectCommand(trimmedCommand)) {
		throw new Error(
			"Refusing to run a command that can stop the PI server. Use project_task preview to manage static previews instead.",
		);
	}
	if (signal?.aborted) return Promise.reject(new Error("Command aborted"));
	appendProjectLog(logs, `$ ${trimmedCommand}`);
	return new Promise((resolveCommand, rejectCommand) => {
		let child: ChildProcess | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		const settle = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const stopChild = (): void => {
			if (!child?.pid) return;
			killProcessTree(child);
		};
		const onAbort = () => {
			settle(() => {
				stopChild();
				rejectCommand(new Error("Command aborted"));
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) {
			onAbort();
			return;
		}
		const spawned = spawn(trimmedCommand, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "true" },
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		child = spawned;
		timeout = setTimeout(() => {
			settle(() => {
				stopChild();
				rejectCommand(new Error(`Command timed out after ${timeoutMs}ms: ${trimmedCommand}`));
			});
		}, timeoutMs);
		spawned.stdout?.on("data", (chunk) => appendProjectLog(logs, String(chunk)));
		spawned.stderr?.on("data", (chunk) => appendProjectLog(logs, String(chunk)));
		spawned.on("error", (error) => {
			settle(() => rejectCommand(error));
		});
		spawned.on("close", (code) => {
			settle(() => {
				if (code === 0) {
					resolveCommand();
				} else {
					rejectCommand(new Error(`Command failed with exit code ${code}: ${trimmedCommand}`));
				}
			});
		});
	});
}

export function appendProjectLog(logs: string[], value: string, maxChars = PROJECT_LOG_MAX_CHARS): void {
	if (!value || logs.some((entry) => entry.includes("[truncated project log"))) return;
	const currentLength = logs.reduce((total, entry) => total + entry.length, 0);
	if (currentLength + value.length <= maxChars) {
		logs.push(value);
		return;
	}
	const remaining = Math.max(0, maxChars - currentLength);
	logs.push(`${value.slice(0, remaining)}\n[truncated project log after ${maxChars} chars]\n`);
}

export function truncateProjectLogs(logs: string[], maxChars = PROJECT_LOG_MAX_CHARS): string[] {
	const text = logs.join("");
	if (text.length <= maxChars) return logs;
	return [`${text.slice(0, maxChars)}\n[truncated project log after ${maxChars} chars]\n`];
}

function killProcessTree(child: ChildProcess): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
			stdio: "ignore",
			windowsHide: true,
		}).on("error", () => child.kill());
		return;
	}
	try {
		process.kill(-child.pid, "SIGTERM");
	} catch {
		child.kill();
	}
}

export function isUnsafeProjectCommand(command: string): boolean {
	const normalized = command.toLowerCase().replace(/\s+/g, " ");
	return UNSAFE_PROJECT_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
}

const UNSAFE_PROJECT_COMMAND_PATTERNS = [
	/\btaskkill\b(?=.*\/im\s+node(?:\.exe)?\b)/,
	/\bstop-process\b(?=.*(?:-name|-processname)?\s*node(?:\.exe)?\b)/,
	/\bget-process\s+node(?:\.exe)?\b.*\bstop-process\b/,
	/\bpkill\b(?=.*\bnode\b)/,
	/\bkillall\b(?=.*\bnode\b)/,
	/\btskill\s+node(?:\.exe)?\b/,
	/\bwmic\b(?=.*\bprocess\b)(?=.*node(?:\.exe)?)(?=.*\bdelete\b)/,
];

function formatCommandFailure(error: unknown, logs: string[]): string {
	const message = error instanceof Error ? error.message : String(error);
	const output = truncateProjectLogs(logs).join("").trim();
	const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "sh";
	return [
		message,
		output ? `Command output:\n${output}` : undefined,
		`Server environment: platform=${process.platform}; shell=${shell}`,
		"Use a command compatible with this environment and retry if needed.",
	]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}
