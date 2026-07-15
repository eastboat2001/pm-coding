export interface AgentV2ReadinessDependency {
	readonly name: string;
	check(signal: AbortSignal): Promise<void>;
}

export interface AgentV2ReadinessReport {
	ready: boolean;
	checkedAt: string;
	dependencies: Array<{ name: string; ready: boolean; code?: string; message?: string }>;
}

export interface AgentV2ReadinessOptions {
	timeoutMs?: number;
}

const DEFAULT_DEPENDENCY_TIMEOUT_MS = 5_000;

export class AgentV2Readiness {
	private readonly timeoutMs: number;

	constructor(
		private readonly dependencies: readonly AgentV2ReadinessDependency[],
		options: AgentV2ReadinessOptions = {},
	) {
		this.timeoutMs = options.timeoutMs ?? DEFAULT_DEPENDENCY_TIMEOUT_MS;
		if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new Error("Agent v2 readiness dependency timeout must be positive.");
		}
	}

	async check(input: { signal: AbortSignal; checkedAt: string }): Promise<AgentV2ReadinessReport> {
		const dependencies = await Promise.all(
			this.dependencies.map((dependency) => checkDependency(dependency, input.signal, this.timeoutMs)),
		);
		return {
			ready: dependencies.every((dependency) => dependency.ready),
			checkedAt: input.checkedAt,
			dependencies,
		};
	}
}

type DependencyReadiness = AgentV2ReadinessReport["dependencies"][number];

function checkDependency(
	dependency: AgentV2ReadinessDependency,
	parentSignal: AbortSignal,
	timeoutMs: number,
): Promise<DependencyReadiness> {
	if (parentSignal.aborted) return Promise.resolve(unavailableDependency(dependency.name, "aborted"));
	const controller = new AbortController();
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const finish = (result: DependencyReadiness): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			parentSignal.removeEventListener("abort", onParentAbort);
			resolve(result);
		};
		const onParentAbort = (): void => {
			controller.abort(parentSignal.reason);
			finish(unavailableDependency(dependency.name, "aborted"));
		};
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort("agent_v2.readiness_timeout");
			finish(unavailableDependency(dependency.name, "timeout"));
		}, timeoutMs);
		timer.unref?.();
		parentSignal.addEventListener("abort", onParentAbort, { once: true });
		void Promise.resolve()
			.then(() => dependency.check(controller.signal))
			.then(
				() => {
					if (timedOut) finish(unavailableDependency(dependency.name, "timeout"));
					else if (parentSignal.aborted || controller.signal.aborted) {
						finish(unavailableDependency(dependency.name, "aborted"));
					} else finish({ name: dependency.name, ready: true });
				},
				() => {
					if (timedOut) finish(unavailableDependency(dependency.name, "timeout"));
					else finish(unavailableDependency(dependency.name, parentSignal.aborted ? "aborted" : "failed"));
				},
			);
		if (parentSignal.aborted) onParentAbort();
	});
}

export interface AgentV2ReadinessGateOptions {
	now?: () => number;
	successTtlMs?: number;
}

export class AgentV2ReadinessGate {
	private cachedSuccess?: { report: AgentV2ReadinessReport; checkedAtMs: number };
	private inFlight?: Promise<AgentV2ReadinessReport>;
	private readonly now: () => number;
	private readonly successTtlMs: number;

	constructor(
		private readonly readiness: AgentV2Readiness,
		options: AgentV2ReadinessGateOptions = {},
	) {
		this.now = options.now ?? (() => Date.now());
		this.successTtlMs = Math.min(1_000, Math.max(0, options.successTtlMs ?? 1_000));
	}

	check(signal: AbortSignal, options: { force?: boolean } = {}): Promise<AgentV2ReadinessReport> {
		const now = this.now();
		if (
			!options.force &&
			this.cachedSuccess !== undefined &&
			now - this.cachedSuccess.checkedAtMs <= this.successTtlMs
		) {
			return Promise.resolve(this.cachedSuccess.report);
		}
		if (this.inFlight) return this.inFlight;
		const checkedAtMs = now;
		const checking = this.readiness
			.check({ signal, checkedAt: new Date(checkedAtMs).toISOString() })
			.then((report) => {
				if (report.ready) this.cachedSuccess = { report, checkedAtMs };
				else this.cachedSuccess = undefined;
				return report;
			})
			.finally(() => {
				if (this.inFlight === checking) this.inFlight = undefined;
			});
		this.inFlight = checking;
		return checking;
	}

	get ready(): boolean {
		return this.cachedSuccess !== undefined && this.now() - this.cachedSuccess.checkedAtMs <= this.successTtlMs;
	}
}

function unavailableDependency(
	name: string,
	reason: "aborted" | "failed" | "timeout",
): { name: string; ready: false; code: string; message: string } {
	if (reason === "timeout") {
		return {
			name,
			ready: false,
			code: "agent_v2.readiness_timeout",
			message: `Agent v2 dependency ${name} readiness check timed out.`,
		};
	}
	return {
		name,
		ready: false,
		code: reason === "aborted" ? "agent_v2.readiness_aborted" : "agent_v2.readiness_dependency_failed",
		message:
			reason === "aborted"
				? `Agent v2 dependency ${name} readiness check was aborted.`
				: `Agent v2 dependency ${name} is unavailable.`,
	};
}
