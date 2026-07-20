import type {
	AgentV2CapabilityDecision,
	AgentV2PlanDocument,
	AgentV2PlanStepId,
	AgentV2PlatformContract,
	AgentV2ProductBlueprint,
	AgentV2ProductBlueprintItem,
	AgentV2SpecDocument,
	AgentV2TaskGraph,
	AgentV2TaskKind,
	AgentV2TaskNode,
} from "./agent-v2-types.js";

type TimestampFactory = () => string;

interface SpecDocumentInput {
	runId: string;
	blueprint: AgentV2ProductBlueprint;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

interface PlanDocumentInput {
	runId: string;
	spec: AgentV2SpecDocument;
	blueprint: AgentV2ProductBlueprint;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

interface TaskGraphInput {
	runId: string;
	spec: AgentV2SpecDocument;
	plan: AgentV2PlanDocument;
	blueprint: AgentV2ProductBlueprint;
	decision: AgentV2CapabilityDecision;
	now?: TimestampFactory;
}

const defaultNow: TimestampFactory = () => new Date().toISOString();

export function buildAgentV2SpecDocument(input: SpecDocumentInput): AgentV2SpecDocument {
	const now = input.now ?? defaultNow;
	const objective = normalizeSentence(input.blueprint.summary);
	const platformContract = buildPlatformContract(input.decision);
	const scope = buildScope(input.blueprint, input.decision);
	const nonGoals = buildNonGoals(input.decision);
	const assumptions = buildAssumptions(input.decision);
	const requirements = buildRequirements(input.blueprint, input.decision);
	const capabilityBoundaries = buildCapabilityBoundaries(input.decision);
	const acceptanceCriteria = buildAcceptanceCriteria(input.blueprint, input.decision);

	return {
		kind: "spec",
		title: `Spec: ${objective}`,
		objective,
		summary: input.decision.summary,
		scope,
		goals: [
			...blueprintCategoryReferences(input.blueprint, "page", 8),
			`Deliver the source-backed product blueprint: ${objective}`,
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
		technicalApproach: buildTechnicalApproach(input.spec, input.blueprint, input.decision),
		fileStructure: buildFileStructure(input.spec, input.decision),
		dataModel: buildDataModel(input.spec, input.blueprint, input.decision),
		interactionFlow: buildInteractionFlow(input.spec, input.blueprint, input.decision),
		validationStrategy: buildValidationStrategy(input.spec, input.blueprint, input.decision),
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
				description:
					"Materialize the implementation scope, assumptions, boundaries, and acceptance criteria from the objective.",
				dependsOn: ["capability"],
				deliverables: ["Spec document", "Acceptance criteria"],
			},
			{
				stepId: "plan" as const,
				title: "Sequence the work",
				description:
					"Break the approved spec into deterministic execution phases for implementation and validation.",
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
		risks: buildRisks(input.blueprint, input.decision),
		metadata: {
			runId: input.runId,
			createdAt: now(),
			specTitle: input.spec.title,
		},
	};
}

export function buildAgentV2TaskGraph(input: TaskGraphInput): AgentV2TaskGraph {
	const now = input.now ?? defaultNow;
	const tasks = input.plan.steps.map((step) =>
		buildTaskNode({
			taskId: step.stepId,
			kind: toTaskKind(step.stepId),
			title: step.title,
			dependsOn: step.dependsOn,
			acceptanceCriteria: buildTaskAcceptanceCriteria(
				step.stepId,
				input.spec,
				input.plan,
				input.blueprint,
				input.decision,
			),
			input: buildTaskInput(step.stepId, input.spec, input.plan, input.blueprint, input.decision),
			output: buildTaskOutputTemplate(step.stepId, input.decision),
			createdAt: now(),
		}),
	);

	return {
		kind: "tasks",
		tasks,
		edges: tasks.flatMap((task) =>
			task.dependsOn.map((dependency) => ({ fromTaskId: dependency, toTaskId: task.taskId })),
		),
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
	document:
		| AgentV2CapabilityDecision
		| AgentV2ProductBlueprint
		| AgentV2SpecDocument
		| AgentV2PlanDocument
		| AgentV2TaskGraph,
): string {
	switch (document.kind) {
		case "capability_decision":
			return [
				"# Capability Decision",
				"",
				`- Delivery mode: ${document.deliveryMode}`,
				`- Summary: ${document.summary}`,
				`- Requires simulation: ${document.requiresSimulation ? "yes" : "no"}`,
				"",
				"## Rationale",
				document.rationale,
				"",
				"## User Contract",
				document.userVisibleContract,
				"",
				"## Unsupported Capabilities",
				...renderList(document.unsupportedCapabilities.length > 0 ? document.unsupportedCapabilities : ["None"]),
				"",
				"## Evidence",
				...renderList(
					document.evidence.map((entry) => `${entry.capability}: ${entry.matchedText} (${entry.reason})`),
				),
				"",
				"## Alternatives",
				...renderList(document.alternatives.map((entry) => `${entry.capability}: ${entry.reason}`)),
			].join("\n");
		case "product_blueprint":
			return [
				`# ${document.title}`,
				"",
				`Summary: ${document.summary}`,
				"",
				"## Source Documents",
				...renderList(
					document.sourceDocuments.map(
						(source) => `${source.path} (${source.checksum}, ${source.lineCount} lines)`,
					),
				),
				...renderBlueprintSection("Requirements", blueprintItems(document, "requirement")),
				...renderBlueprintSection("Pages and Product Surfaces", blueprintItems(document, "page")),
				...renderBlueprintSection("Interactions", blueprintItems(document, "interaction")),
				...renderBlueprintSection("States", blueprintItems(document, "state")),
				...renderBlueprintSection("Permissions", blueprintItems(document, "permission")),
				...renderBlueprintSection("Visual Direction", blueprintItems(document, "visual")),
				...renderBlueprintSection("Acceptance Criteria", blueprintItems(document, "acceptance")),
			].join("\n");
		case "spec":
			return [
				`# ${document.title}`,
				"",
				`Summary: ${document.summary}`,
				"",
				`Objective: ${document.objective}`,
				"",
				"## Goals",
				...renderList(document.goals),
				"",
				"## Scope",
				...renderList(document.scope),
				"",
				"## Non-Goals",
				...renderList(document.nonGoals),
				"",
				"## Assumptions",
				...renderList(document.assumptions),
				"",
				"## Requirements",
				...renderList(document.requirements),
				"",
				"## Capability Boundaries",
				...renderList(document.capabilityBoundaries),
				"",
				"## Platform Contract",
				...renderKeyValueList({
					runtime: document.platformContract.runtime,
					framework: document.platformContract.framework,
					deliveryMode: document.platformContract.deliveryMode,
					entrypoints: document.platformContract.entrypoints,
					deliverables: document.platformContract.deliverables,
					supportedDeliveryModes: document.platformContract.supportedDeliveryModes ?? [],
					constraints: document.platformContract.constraints,
				}),
				"",
				"## Acceptance Criteria",
				...renderList(document.acceptanceCriteria),
			].join("\n");
		case "plan":
			return [
				`# ${document.title}`,
				"",
				`Summary: ${document.summary}`,
				"",
				"## Technical Approach",
				...renderList(document.technicalApproach),
				"",
				"## File Structure",
				...renderList(document.fileStructure),
				"",
				"## Data Model",
				...renderList(document.dataModel),
				"",
				"## Interaction Flow",
				...renderList(document.interactionFlow),
				"",
				"## Validation Strategy",
				...renderList(document.validationStrategy),
				"",
				"## Steps",
				...document.steps.map(
					(step) =>
						`- ${step.stepId}: ${step.title} | dependsOn=${step.dependsOn.join(", ") || "none"} | deliverables=${step.deliverables.join(
							", ",
						)}`,
				),
				"",
				"## Risks",
				...renderList(document.risks),
			].join("\n");
		case "tasks":
			return [
				"# Task Graph",
				"",
				...document.tasks.flatMap((task) => [
					`## ${task.taskId}`,
					`- Kind: ${task.kind}`,
					`- Status: ${task.status}`,
					`- Dependencies: ${task.dependsOn.join(", ") || "none"}`,
					"- Acceptance Criteria",
					...renderList(task.acceptanceCriteria),
					"- Output Slots",
					...renderKeyValueList(task.output),
					"",
				]),
			].join("\n");
	}
}

function buildPlatformContract(decision: AgentV2CapabilityDecision): AgentV2PlatformContract {
	return {
		runtime: decision.platformContract.runtime,
		framework: decision.platformContract.framework,
		deliveryMode: decision.deliveryMode,
		entrypoints: [...decision.platformContract.entrypoints],
		deliverables: [...decision.platformContract.deliverables],
		constraints: [...decision.platformContract.constraints],
		...(decision.platformContract.supportedDeliveryModes
			? { supportedDeliveryModes: [...decision.platformContract.supportedDeliveryModes] }
			: {}),
		...(decision.platformContract.unsupportedCapabilities
			? { unsupportedCapabilities: [...decision.platformContract.unsupportedCapabilities] }
			: {}),
		...(decision.platformContract.userVisibleContract
			? { userVisibleContract: decision.platformContract.userVisibleContract }
			: {}),
		metadata: decision.platformContract.metadata ? { ...decision.platformContract.metadata } : undefined,
	};
}

function buildScope(blueprint: AgentV2ProductBlueprint, decision: AgentV2CapabilityDecision): string[] {
	const scope = [
		...blueprintCategoryReferences(blueprint, "page", 12),
		`Implement the source-backed product blueprint: ${blueprint.summary}`,
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

function buildRequirements(blueprint: AgentV2ProductBlueprint, decision: AgentV2CapabilityDecision): string[] {
	return [
		...blueprintCategoryReferences(blueprint, "requirement", 32),
		`Preserve the selected delivery mode: ${decision.deliveryMode}`,
		...decision.constraints,
	];
}

function buildCapabilityBoundaries(decision: AgentV2CapabilityDecision): string[] {
	const boundaries = [decision.userVisibleContract, `Delivery mode is fixed to ${decision.deliveryMode}.`];
	if (decision.requiresSimulation) {
		boundaries.push("Unsupported backend requirements must remain a static simulation, never a hidden downgrade.");
	}
	if (decision.unsupportedCapabilities.length > 0) {
		boundaries.push(`Unsupported capabilities: ${decision.unsupportedCapabilities.join(", ")}.`);
	}
	return boundaries;
}

function buildAcceptanceCriteria(blueprint: AgentV2ProductBlueprint, decision: AgentV2CapabilityDecision): string[] {
	const criteria = [
		...blueprintCategoryReferences(blueprint, "acceptance", 24),
		...blueprintCategoryReferences(blueprint, "interaction", 16).map(
			(item) => `Interaction is implemented and observable: ${item}`,
		),
		`User-visible behavior matches the ${decision.deliveryMode} delivery contract.`,
		"Source citations remain traceable through the product blueprint.",
	];
	if (decision.requiresSimulation) {
		criteria.push("Simulated backend behavior is called out directly in the spec and delivery notes.");
	}
	return criteria;
}

function buildRisks(blueprint: AgentV2ProductBlueprint, decision: AgentV2CapabilityDecision): string[] {
	const risks = ["Scope may drift if the implementation ignores the documented acceptance criteria."];
	if (blueprint.categoryItemIds.state.length === 0) {
		risks.push("Source documents do not define loading, empty, or error states explicitly.");
	}
	if (blueprint.categoryItemIds.permission.length === 0) {
		risks.push("Source documents do not define role or permission behavior explicitly.");
	}
	if (decision.requiresSimulation) {
		risks.push("Users may expect a live backend; delivery notes must restate that backend behavior is simulated.");
	}
	if (decision.unsupportedCapabilities.includes("backend_server")) {
		risks.push("The requested backend runtime is unsupported and must not leak into implementation promises.");
	}
	return risks;
}

function buildTechnicalApproach(
	spec: AgentV2SpecDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): string[] {
	return [
		`Use a deterministic ${decision.deliveryMode} builder flow rooted in the ${spec.platformContract.framework} platform contract.`,
		...blueprintCategoryReferences(blueprint, "visual", 12).map((item) => `Honor visual direction: ${item}`),
		"Keep the product blueprint, spec, plan, and task graph deterministic for identical source bytes.",
		decision.requiresSimulation
			? "Represent backend-only behavior as an explicit static simulation with user-visible notes."
			: "Keep the implementation inside the static frontend boundary without introducing hidden backend behavior.",
	];
}

function buildFileStructure(spec: AgentV2SpecDocument, decision: AgentV2CapabilityDecision): string[] {
	return [
		...spec.platformContract.entrypoints,
		"src/features",
		decision.requiresSimulation ? "src/mocks" : "src/data",
		"public/assets",
	];
}

function buildDataModel(
	spec: AgentV2SpecDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): string[] {
	return [
		...blueprintCategoryReferences(blueprint, "requirement", 12).map((item) => `Source-backed requirement: ${item}`),
		`capability decision model: deliveryMode=${decision.deliveryMode}, unsupportedCapabilities=${decision.unsupportedCapabilities.join(", ") || "none"}.`,
		`spec document model: objective, scope, requirements, acceptanceCriteria, and platformContract for ${spec.objective}`,
		"plan document model: technicalApproach, fileStructure, dataModel, interactionFlow, validationStrategy, risks, and ordered steps.",
		"task node model: taskId, status, dependencies, acceptanceCriteria, artifactIds, changedFiles, validationIds, failureReason, and repairActions.",
	];
}

function buildInteractionFlow(
	spec: AgentV2SpecDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): string[] {
	return [
		...blueprintCategoryReferences(blueprint, "interaction", 24),
		...blueprintCategoryReferences(blueprint, "state", 12).map((item) => `State behavior: ${item}`),
		`capability -> product_blueprint -> spec -> plan -> implement -> validate -> deliver for ${spec.objective}`,
		`Implement uses delivery mode ${decision.deliveryMode} before validate checks each acceptance criterion.`,
		"Deliver packages artifacts and constraints after validate records structured evidence.",
	];
}

function buildValidationStrategy(
	spec: AgentV2SpecDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): string[] {
	return [
		...blueprintCategoryReferences(blueprint, "acceptance", 24).map((item) => `Verify with source evidence: ${item}`),
		"Re-check every acceptance criteria item during validate and carry the evidence into task outputs.",
		`Verify the platform contract entrypoints remain aligned with ${decision.deliveryMode}.`,
		decision.requiresSimulation
			? "Confirm simulation copy clearly states mocked backend behavior and its limits."
			: "Confirm delivery stays within the static frontend contract without backend promises.",
		`Use the spec acceptance criteria as the validation baseline for ${spec.objective}`,
	];
}

function buildTaskAcceptanceCriteria(
	stepId: AgentV2PlanStepId,
	spec: AgentV2SpecDocument,
	plan: AgentV2PlanDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): string[] {
	switch (stepId) {
		case "capability":
			return [
				`Capture the routed delivery mode ${decision.deliveryMode} and preserve the selected platform contract.`,
				"Record unsupported capabilities, alternatives, and the user-visible contract for downstream execution.",
			];
		case "spec":
			return [
				"Spec includes objective, scope, non-goals, assumptions, requirements, capability boundaries, and platform contract.",
				"Spec acceptance criteria stay deterministic for identical objective and decision inputs.",
			];
		case "plan":
			return [
				"Plan includes technical approach, file structure, data model, interaction flow, validation strategy, risks, and ordered steps.",
				"Plan ordering remains dependency-safe for capability -> spec -> plan -> implement -> validate -> deliver.",
			];
		case "implement":
			return [
				...blueprintCategoryReferences(blueprint, "acceptance", 16),
				...blueprintCategoryReferences(blueprint, "interaction", 12).map(
					(item) => `Implement observable interaction: ${item}`,
				),
				`Implementation work maps to the selected platform contract entrypoints: ${spec.platformContract.entrypoints.join(", ")}`,
				decision.requiresSimulation
					? "Implementation notes call out explicit static simulation behavior for unsupported backend needs."
					: "Implementation stays inside the static frontend contract without hidden backend requirements.",
			];
		case "validate":
			return [
				...spec.acceptanceCriteria,
				"Validation output records evidence ids, failures, and repair actions for later execution.",
			];
		case "deliver":
			return [
				`Delivery packages preview-ready outputs for the ${decision.deliveryMode} contract.`,
				`Delivery notes restate key risks from the plan: ${plan.risks.join(" ")}`,
			];
	}
}

function buildTaskInput(
	stepId: AgentV2PlanStepId,
	spec: AgentV2SpecDocument,
	plan: AgentV2PlanDocument,
	blueprint: AgentV2ProductBlueprint,
	decision: AgentV2CapabilityDecision,
): Record<string, unknown> {
	return {
		stepId,
		objective: spec.objective,
		deliveryMode: decision.deliveryMode,
		dependencies: plan.steps.find((step) => step.stepId === stepId)?.dependsOn ?? [],
		platformEntrypoints: [...spec.platformContract.entrypoints],
		productBlueprintId: "product_blueprint",
		sourceDocuments: blueprint.sourceDocuments.map((source) => source.path),
	};
}

function blueprintTexts(items: readonly AgentV2ProductBlueprintItem[], limit: number): string[] {
	return items.slice(0, limit).map((item) => `${item.text} [${item.sourcePath}:${item.line}]`);
}

function blueprintItems(
	blueprint: AgentV2ProductBlueprint,
	category: AgentV2ProductBlueprintItem["categories"][number],
): AgentV2ProductBlueprintItem[] {
	const ids = new Set(blueprint.categoryItemIds[category]);
	return blueprint.items.filter((item) => ids.has(item.id));
}

function blueprintCategoryReferences(
	blueprint: AgentV2ProductBlueprint,
	category: AgentV2ProductBlueprintItem["categories"][number],
	limit: number,
): string[] {
	return blueprintItems(blueprint, category)
		.slice(0, limit)
		.map((item) => `Product blueprint item ${item.id} [${item.sourcePath}:${item.line}]`);
}

function renderBlueprintSection(title: string, items: readonly AgentV2ProductBlueprintItem[]): string[] {
	return ["", `## ${title}`, ...renderList(blueprintTexts(items, MAX_SAFE_BLUEPRINT_ITEMS))];
}

const MAX_SAFE_BLUEPRINT_ITEMS = 40;

function buildTaskOutputTemplate(
	stepId: AgentV2PlanStepId,
	decision: AgentV2CapabilityDecision,
): Record<string, unknown> {
	return {
		stepId,
		documentIds: [],
		artifactIds: [],
		changedFiles: [],
		validationIds: [],
		diagnosticIds: [],
		failureReason: null,
		repairActions: [],
		simulationNotes: decision.requiresSimulation ? [decision.userVisibleContract] : [],
	};
}

function buildTaskNode(input: {
	taskId: string;
	kind: AgentV2TaskKind;
	title: string;
	dependsOn: string[];
	acceptanceCriteria: string[];
	input: Record<string, unknown>;
	output: Record<string, unknown>;
	createdAt: string;
}): AgentV2TaskNode {
	return {
		taskId: input.taskId,
		kind: input.kind,
		title: input.title,
		status: input.dependsOn.length === 0 ? "ready" : "pending",
		dependsOn: [...input.dependsOn],
		acceptanceCriteria: [...input.acceptanceCriteria],
		input: { ...input.input },
		output: { ...input.output },
		createdAt: input.createdAt,
		updatedAt: input.createdAt,
	};
}

function renderList(items: string[]): string[] {
	return items.map((item) => `- ${item}`);
}

function renderKeyValueList(values: Record<string, unknown>): string[] {
	return Object.entries(values).map(([key, value]) => `- ${key}: ${formatValue(value)}`);
}

function formatValue(value: unknown): string {
	if (Array.isArray(value)) {
		return value.length > 0 ? value.map((item) => String(item)).join(", ") : "[]";
	}
	if (value && typeof value === "object") {
		return JSON.stringify(value);
	}
	if (value === null) {
		return "null";
	}
	return String(value);
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
