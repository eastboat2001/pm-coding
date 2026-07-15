export interface AgentV2CloseOptions {
	signal: AbortSignal;
	deadlineAtMs: number;
}

export interface AgentV2WorkerStopResult {
	completed: boolean;
	timedOutSteps: string[];
	errors: Array<{ step: string; code: string; message: string }>;
}

export interface AgentV2ShutdownDeadline extends AgentV2CloseOptions {
	dispose(): void;
}

export interface AgentV2ShutdownStep {
	step: string;
	run(options: AgentV2CloseOptions): unknown | Promise<unknown>;
	onTimeout?(): void;
}

const SHUTDOWN_ERROR_CODE = "agent_v2.shutdown_step_failed";
const SHUTDOWN_ERROR_MESSAGE = "Agent v2 shutdown step failed";

export function createAgentV2ShutdownDeadline(
	timeoutMs: number,
	now: () => number = Date.now,
): AgentV2ShutdownDeadline {
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Agent v2 shutdown timeout must be non-negative");
	const controller = new AbortController();
	const deadlineAtMs = now() + timeoutMs;
	const timer = setTimeout(() => controller.abort(SHUTDOWN_ERROR_CODE), Math.max(0, timeoutMs));
	timer.unref?.();
	return {
		signal: controller.signal,
		deadlineAtMs,
		dispose() {
			clearTimeout(timer);
		},
	};
}

export function remainingAgentV2ShutdownMs(options: AgentV2CloseOptions, now: () => number = Date.now): number {
	return Math.max(0, options.deadlineAtMs - now());
}

export async function runAgentV2ShutdownSteps(
	steps: readonly AgentV2ShutdownStep[],
	options: AgentV2CloseOptions,
): Promise<AgentV2WorkerStopResult> {
	const timedOutSteps: string[] = [];
	const errors: AgentV2WorkerStopResult["errors"] = [];

	for (const step of steps) {
		const outcome = await settleShutdownStep(step, options);
		if (outcome.kind === "timeout") {
			step.onTimeout?.();
			timedOutSteps.push(step.step);
		} else if (outcome.kind === "error") {
			errors.push({ step: step.step, code: SHUTDOWN_ERROR_CODE, message: SHUTDOWN_ERROR_MESSAGE });
		} else if (isAgentV2WorkerStopResult(outcome.value)) {
			timedOutSteps.push(...outcome.value.timedOutSteps);
			errors.push(...outcome.value.errors);
		}
	}

	return {
		completed: timedOutSteps.length === 0 && errors.length === 0,
		timedOutSteps,
		errors,
	};
}

async function settleShutdownStep(
	step: AgentV2ShutdownStep,
	options: AgentV2CloseOptions,
): Promise<{ kind: "completed"; value: unknown } | { kind: "error" } | { kind: "timeout" }> {
	let settled = false;
	let invoked: unknown;
	try {
		invoked = step.run(options);
	} catch {
		return { kind: "error" };
	}
	const operation = Promise.resolve(invoked).then(
		(value) => {
			settled = true;
			return { kind: "completed" as const, value };
		},
		() => {
			settled = true;
			return { kind: "error" as const };
		},
	);

	// Always invoke every cleanup. Once the shared deadline has elapsed, allow an
	// immediately-settling cleanup a small microtask turn to finish, but never start a new timeout.
	if (options.signal.aborted || remainingAgentV2ShutdownMs(options) === 0) {
		for (let turn = 0; turn < 8 && !settled; turn += 1) await Promise.resolve();
		return settled ? await operation : { kind: "timeout" };
	}

	let removeAbortListener: () => void = () => undefined;
	const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
		const onAbort = () => resolve({ kind: "timeout" });
		options.signal.addEventListener("abort", onAbort, { once: true });
		removeAbortListener = () => options.signal.removeEventListener("abort", onAbort);
	});
	try {
		return await Promise.race([operation, deadline]);
	} finally {
		removeAbortListener();
	}
}

function isAgentV2WorkerStopResult(value: unknown): value is AgentV2WorkerStopResult {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<AgentV2WorkerStopResult>;
	return (
		typeof candidate.completed === "boolean" &&
		Array.isArray(candidate.timedOutSteps) &&
		Array.isArray(candidate.errors)
	);
}
