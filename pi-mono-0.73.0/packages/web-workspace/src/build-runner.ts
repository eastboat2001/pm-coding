export type BuildOutputDirectory = "dist" | "build" | "public";

export type BuildRunnerFailureCode =
	| "build.config_missing"
	| "build.engine_unavailable"
	| "build.policy_rejected"
	| "build.dependency_restore_failed"
	| "build.execution_failed"
	| "build.output_missing"
	| "build.output_escape"
	| "build.timeout"
	| "build.cancelled"
	| "build.cleanup_failed";

export interface BuildRunnerInput {
	projectId: string;
	projectRoot: string;
	artifactRoot: string;
	allowedOutputs: readonly BuildOutputDirectory[];
	signal?: AbortSignal;
}

export interface BuildRunnerResult {
	serveRoot: string;
	outputDirectory: BuildOutputDirectory;
	files: string[];
	logs: string[];
	durationMs: number;
}

export interface BuildRunner {
	build(input: BuildRunnerInput): Promise<BuildRunnerResult>;
}

export class BuildRunnerError extends Error {
	constructor(
		readonly code: BuildRunnerFailureCode,
		message: string,
		readonly logs?: readonly string[],
	) {
		super(message);
		this.name = "BuildRunnerError";
	}
}
