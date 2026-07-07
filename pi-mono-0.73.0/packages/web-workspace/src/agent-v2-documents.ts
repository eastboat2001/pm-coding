import type {
	AgentV2CapabilityDecision,
	AgentV2PlanDocument,
	AgentV2PlanStepId,
	AgentV2PlatformContract,
	AgentV2SpecDocument,
	AgentV2TaskGraph,
	AgentV2TaskKind,
	AgentV2TaskNode,
} from "./agent-v2-types.js";

type TimestampFactory = () => string;

interface SpecDocumentInput {
	runId: string;
	objective: string;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

interface PlanDocumentInput {
	runId: string;
	spec: AgentV2SpecDocument;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

interface TaskGraphInput {
	runId: string;
	spec: AgentV2SpecDocument;
	plan: AgentV2PlanDocument;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

const defaultNow: TimestampFactory = () => new Date().toISOString();

export function buildAgentV2SpecDocument(input: SpecDocumentInput): AgentV2SpecDocument {
	const now = input.now ?? defaultNow;
	const objective = normalizeSentence(input.objective);
	const platformContract = buildPlatformContract(input.decision);
	const scope = buildScope(objective, input.decision);
	const nonGoals = buildNonGoals(input.decision);
	const assumptions = buildAssumptions(input.decision);
	const requirements = buildRequirements(objective, input.decision);
	const capabilityBoundaries = buildCapabilityBoundaries(input.decision);
	const acceptanceCriteria = buildAcceptanceCriteria(objective, input.decision);

	return {
		kind: "spec",
		title: `Spec: ${objective}`,
		objective,
		summary: input.decision.summary,
		scope,
		goals: [
			`Deliver the core objective: ${objective}`,
			`Respect the selected delivery mode: ${input.decision.deliveryMode}.`,
		],
		nonGoals,
		assumptions,
		requirements,
		capabilityBoundaries,
		acceptanceCriteria,
		platformContract,
		metadata: {
			runId: input.runId,
			createdAt: now(),
			selectedCapability: input.decision.selectedCapability,
		},
	};
}

export function buildAgentV2PlanDocument(input: PlanDocumentInput): AgentV2PlanDocument {
	const now = input.now ?? defaultNow;
	return {
		kind: "plan",
		title: `Plan: ${input.spec.objective}`,
		summary: `Implement ${input.spec.objective} as a deterministic ${input.decision.deliveryMode} workflow.`,
		steps: [
			{
				stepId: "capability" as const,
				title: "Confirm capability contract",
				description: "Carry the selected delivery mode, platform contract, and user-visible limits into execution.",
				dependsOn: [],
				deliverables: ["Capability decision captured", "Execution constraints recorded"],
			},
			{
				stepId: "spec" as const,
				title: "Finalize spec",
				description: "Materialize the implementation scope, assumptions, boundaries, and acceptance criteria from the objective.",
				dependsOn: ["capability"],
				deliverables: ["Spec document", "Acceptance criteria"],
			},
			{
				stepId: "plan" as const,
				title: "Sequence the work",
				description: "Break the approved spec into deterministic execution phases for implementation and validation.",
				dependsOn: ["spec"],
				deliverables: ["Plan document", "Ordered execution steps"],
			},
			{
				stepId: "implement" as const,
				title: "Implement the product surface",
				description: "Build the user-facing experience within the platform contract and simulation limits.",
				dependsOn: ["plan"],
				deliverables: ["Implementation tasks", "Static assets or simulation flows"],
			},
			{
				stepId: "validate" as const,
				title: "Validate acceptance criteria",
				description: "Verify the delivered experience against scope, boundaries, and acceptance criteria.",
				dependsOn: ["implement"],
				deliverables: ["Validation evidence", "Resolved delivery gaps"],
			},
			{
				stepId: "deliver" as const,
				title: "Package delivery output",
				description: "Prepare the final preview-ready deliverable and restate any user-visible constraints.",
				dependsOn: ["validate"],
				deliverables: ["Preview-ready output", "Delivery notes"],
			},
		],
		risks: buildRisks(input.decision),
		metadata: {
			runId: input.runId,
			createdAt: now(),
			specTitle: input.spec.title,
		},
	};
}

export function buildAgentV2TaskGraph(input: TaskGraphInput): AgentV2TaskGraph {
	const now = input.now ?? defaultNow;
	const tasks = input.plan.steps.map((step, index) =>
		buildTaskNode({
			taskId: step.stepId,
			kind: toTaskKind(step.stepId),
			title: step.title,
			dependsOn: step.dependsOn,
			acceptanceCriteria:
				step.stepId === "validate" ? input.spec.acceptanceCriteria : [`Complete step ${index + 1}: ${step.title}.`],
			createdAt: now(),
		}),
	);

	return {
		kind: "tasks",
		tasks,
		edges: tasks.flatMap((task) => task.dependsOn.map((dependency) => ({ fromTaskId: dependency, toTaskId: task.taskId }))),
		metadata: {
			runId: input.runId,
			createdAt: now(),
			specTitle: input.spec.title,
			planTitle: input.plan.title,
			deliveryMode: input.decision.deliveryMode,
		},
	};
}

export function renderAgentV2DocumentMarkdown(
	document: AgentV2CapabilityDecision | AgentV2SpecDocument | AgentV2PlanDocument | AgentV2TaskGraph,
): string {
	switch (document.kind) {
		case "capability_decision":
			return [
				"# Capability Decision",
				`- Delivery mode: ${document.deliveryMode}`,
				`- Summary: ${document.summary}`,
				`- Contract: ${document.userVisibleContract}`,
			].join("\n");
		case "spec":
			return [
				`# ${document.title}`,
				"",
				`Objective: ${document.objective}`,
				"",
				"## Scope",
				...document.scope.map((item) => `- ${item}`),
				"",
				"## Non-Goals",
				...document.nonGoals.map((item) => `- ${item}`),
				"",
				"## Assumptions",
				...document.assumptions.map((item) => `- ${item}`),
				"",
				"## Acceptance Criteria",
				...document.acceptanceCriteria.map((item) => `- ${item}`),
			].join("\n");
		case "plan":
			return [
				`# ${document.title}`,
				"",
				`Summary: ${document.summary}`,
				"",
				"## Steps",
				...document.steps.map((step) => `- ${step.stepId}: ${step.title}`),
				"",
				"## Risks",
				...document.risks.map((risk) => `- ${risk}`),
			].join("\n");
		case "tasks":
			return [
				"# Task Graph",
				"",
				...document.tasks.map((task) => `- ${task.taskId} -> [${task.dependsOn.join(", ")}]`),
			].join("\n");
	}
}

function buildPlatformContract(decision: AgentV2CapabilityDecision): AgentV2PlatformContract {
	const runtime = typeof decision.metadata?.platformRuntime === "string" ? decision.metadata.platformRuntime : "static_browser_app";
	const framework = typeof decision.metadata?.platformFramework === "string" ? decision.metadata.platformFramework : "vite";
	return {
		runtime,
		framework,
		deliveryMode: decision.deliveryMode,
		entrypoints: ["index.html", "src/main.ts", "src/main.tsx"],
		deliverables: decision.requiresSimulation
			? ["static frontend app", "simulated backend flows", "preview-ready assets"]
			: ["static frontend app", "preview-ready assets"],
		constraints: [...decision.constraints],
		unsupportedCapabilities: [...decision.unsupportedCapabilities],
		userVisibleContract: decision.userVisibleContract,
		metadata: {
			source: "agent-v2-documents",
		},
	};
}

function buildScope(objective: string, decision: AgentV2CapabilityDecision): string[] {
	const scope = [
		`Implement the requested experience described by: ${objective}`,
		`Deliver using the ${decision.deliveryMode} platform contract.`,
	];
	if (decision.requiresSimulation) {
		scope.push("Represent unsupported runtime features with explicit static simulation behavior.");
	}
	return scope;
}

function buildNonGoals(decision: AgentV2CapabilityDecision): string[] {
	const nonGoals = [
		"Do not introduce a live backend runtime.",
		"Do not persist data outside the static preview contract.",
	];
	if (decision.unsupportedCapabilities.length > 0) {
		nonGoals.push(`Do not claim production support for ${decision.unsupportedCapabilities.join(", ")}.`);
	}
	return nonGoals;
}

function buildAssumptions(decision: AgentV2CapabilityDecision): string[] {
	const assumptions = [
		"Implementation runs inside the existing static-preview workspace runtime.",
		"Deterministic builders derive planning artifacts directly from the objective and routed capability decision.",
	];
	if (decision.requiresSimulation) {
		assumptions.push("Users can accept mocked or simulated backend flows in place of live services.");
	}
	return assumptions;
}

function buildRequirements(objective: string, decision: AgentV2CapabilityDecision): string[] {
	return [
		`Keep the delivered product aligned with the objective: ${objective}`,
		`Preserve the selected delivery mode: ${decision.deliveryMode}`,
		...decision.constraints,
	];
}

function buildCapabilityBoundaries(decision: AgentV2CapabilityDecision): string[] {
	const boundaries = [
		decision.userVisibleContract,
		`Delivery mode is fixed to ${decision.deliveryMode}.`,
	];
	if (decision.requiresSimulation) {
		boundaries.push("Unsupported backend requirements must remain a static simulation, never a hidden downgrade.");
	}
	if (decision.unsupportedCapabilities.length > 0) {
		boundaries.push(`Unsupported capabilities: ${decision.unsupportedCapabilities.join(", ")}.`);
	}
	return boundaries;
}

function buildAcceptanceCriteria(objective: string, decision: AgentV2CapabilityDecision): string[] {
	const criteria = [
		`The delivered experience clearly satisfies the objective: ${objective}`,
		`User-visible behavior matches the ${decision.deliveryMode} delivery contract.`,
		"Generated artifacts are deterministic for identical inputs.",
		"Scope, assumptions, and non-goals are explicitly documented.",
	];
	if (decision.requiresSimulation) {
		criteria.push("Simulated backend behavior is called out directly in the spec and delivery notes.");
	}
	return criteria;
}

function buildRisks(decision: AgentV2CapabilityDecision): string[] {
	const risks = ["Scope may drift if the implementation ignores the documented acceptance criteria."];
	if (decision.requiresSimulation) {
		risks.push("Users may expect a live backend; delivery notes must restate that backend behavior is simulated.");
	}
	if (decision.unsupportedCapabilities.includes("backend_server")) {
		risks.push("The requested backend runtime is unsupported and must not leak into implementation promises.");
	}
	return risks;
}

function buildTaskNode(input: {
	taskId: string;
	kind: AgentV2TaskKind;
	title: string;
	dependsOn: string[];
	acceptanceCriteria: string[];
	createdAt: string;
}): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		kind: input.kind,
		title: input.title,
		status: input.dependsOn.length === 0 ? "ready" : "pending",
		dependsOn: [...input.dependsOn],
		acceptanceCriteria: [...input.acceptanceCriteria],
		input: {},
		output: {},
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
	};
}

function toTaskKind(stepId: AgentV2PlanStepId): AgentV2TaskKind {
	switch (stepId) {
		case "capability":
			return "capability";
		case "spec":
			return "spec";
		case "plan":
			return "plan";
		case "implement":
			return "implementation";
		case "validate":
			return "validation";
		case "deliver":
			return "delivery";
	}
}

function normalizeSentence(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return "";
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
