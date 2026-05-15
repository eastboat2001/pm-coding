import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { ProjectBashRequest, ProjectBashResult, StorageConfig } from "./types.js";
import { removeSiblingProjectDirs, workspaceContext } from "./workspace-paths.js";

export class WorkspaceCommandService {
	constructor(private readonly config: StorageConfig) {}

	async run(body: ProjectBashRequest): Promise<ProjectBashResult> {
		const { projectDir, sessionId } = workspaceContext(this.config, body);
		mkdirSync(projectDir, { recursive: true });
		removeSiblingProjectDirs(this.config.projectsRootDir, projectDir, sessionId);
		const command = String(body.command || "").trim();
		if (!command) throw new Error("Field `command` is required.");
		const timeoutMs = Math.max(1000, Math.min(Number(body.timeoutMs || this.config.projectBuildTimeoutMs), 300000));
		const logs: string[] = [];
		try {
			await runCommand(command, projectDir, timeoutMs, logs);
		} catch (error) {
			throw new Error(formatCommandFailure(error, logs));
		}
		return {
			command,
			projectRoot: projectDir,
			output: logs.join("").trim() || "Command completed successfully.",
		};
	}
}

export function runCommand(command: string, cwd: string, timeoutMs: number, logs: string[]): Promise<void> {
	const trimmedCommand = command.trim();
	if (!trimmedCommand) return Promise.resolve();
	logs.push(`$ ${trimmedCommand}`);
	return new Promise((resolveCommand, rejectCommand) => {
		const child = spawn(trimmedCommand, {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, CI: "true" },
			windowsHide: true,
		});
		const timeout = setTimeout(() => {
			child.kill();
			rejectCommand(new Error(`Command timed out after ${timeoutMs}ms: ${trimmedCommand}`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
		child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
		child.on("error", (error) => {
			clearTimeout(timeout);
			rejectCommand(error);
		});
		child.on("close", (code) => {
			clearTimeout(timeout);
			if (code === 0) {
				resolveCommand();
			} else {
				rejectCommand(new Error(`Command failed with exit code ${code}: ${trimmedCommand}`));
			}
		});
	});
}

function formatCommandFailure(error: unknown, logs: string[]): string {
	const message = error instanceof Error ? error.message : String(error);
	const output = logs.join("").trim();
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
