import { createHash } from "node:crypto";
import { createAgentV2DiagnosticEvent, type AgentV2DiagnosticEvent } from "./agent-v2-diagnostics.js";
import { routeAgentV2Capabilities } from "./agent-v2-capability-router.js";
import {
	buildAgentV2PlanDocument,
	buildAgentV2SpecDocument,
	buildAgentV2TaskGraph,
	renderAgentV2DocumentMarkdown,
} from "./agent-v2-documents.js";
import type {
	AgentV2CapabilityDecision,
	AgentV2PlanDocument,
	AgentV2PlatformContract,
	AgentV2RunSnapshot,
	AgentV2SpecDocument,
	AgentV2TaskGraph,
} from "./agent-v2-types.js";
import type { RuntimeStore } from "./runtime-store.js";
import type {
	AgentV2ArtifactRecord,
	AgentV2DocumentRecord,
	UpsertAgentV2ArtifactInput,
	UpsertAgentV2DocumentInput,
	UpsertAgentV2TaskInput,
} from "./agent-v2-store.js";

type TimestampFactory = () => string;

type BootstrapDocumentDescriptor = {
	documentId: UpsertAgentV2DocumentInput["documentId"];
	kind: UpsertAgentV2DocumentInput["kind"];
	sourceTaskId: string;
	path: string;
	contentJson: AgentV2CapabilityDecision | AgentV2SpecDocument | AgentV2PlanDocument | AgentV2TaskGraph;
	contentMarkdown: string;
	mediaType: string;
};

export interface AgentV2PlanningBootstrap {
	run: AgentV2RunSnapshot;
	objective: string;
	decision: AgentV2CapabilityDecision;
	spec: AgentV2SpecDocument;
	plan: AgentV2PlanDocument;
	taskGraph: AgentV2TaskGraph;
	documents: UpsertAgentV2DocumentInput[];
	tasks: UpsertAgentV2TaskInput[];
	artifacts: UpsertAgentV2ArtifactInput[];
	diagnostics: AgentV2DiagnosticEvent[];
}

export function buildAgentV2PlanningBootstrap(input: {
	run: AgentV2RunSnapshot;
	objective?: string;
	platform?: AgentV2PlatformContract;
	now?: TimestampFactory;
}): AgentV2PlanningBootstrap {
	const baseTimestamp = (input.now ?? defaultNow)();
	const nextTimestamp = createTimestampSequence(baseTimestamp);
	const objective = resolveObjective(input.run, input.objective);
	const decision = routeAgentV2Capabilities({ objective, platform: input.platform });
	const spec = buildAgentV2SpecDocument({
		runId: input.run.runId,
		objective,
		decision,
		now: nextTimestamp,
	});
	const plan = buildAgentV2PlanDocument({
		runId: input.run.runId,
		spec,
		decision,
		now: nextTimestamp,
	});
	const taskGraph = buildAgentV2TaskGraph({
		runId: input.run.runId,
		spec,
		plan,
		decision,
		now: nextTimestamp,
	});

	const documentDescriptors: BootstrapDocumentDescriptor[] = [
		{
			documentId: "capability_decision",
			kind: "capability_decision",
			sourceTaskId: "capability",
			path: "agent-v2/capability-decision.json",
			contentJson: decision,
			contentMarkdown: renderAgentV2DocumentMarkdown(decision),
			mediaType: "application/json",
		},
		{
			documentId: "spec",
			kind: "spec",
			sourceTaskId: "spec",
			path: "agent-v2/spec.md",
			contentJson: spec,
			contentMarkdown: renderAgentV2DocumentMarkdown(spec),
			mediaType: "text/markdown",
		},
		{
			documentId: "plan",
			kind: "plan",
			sourceTaskId: "plan",
			path: "agent-v2/plan.md",
			contentJson: plan,
			contentMarkdown: renderAgentV2DocumentMarkdown(plan),
			mediaType: "text/markdown",
		},
		{
			documentId: "tasks",
			kind: "tasks",
			sourceTaskId: "plan",
			path: "agent-v2/tasks.json",
			contentJson: taskGraph,
			contentMarkdown: renderAgentV2DocumentMarkdown(taskGraph),
			mediaType: "application/json",
		},
	];

	const documents = documentDescriptors.map((descriptor) => {
		const createdAt = nextTimestamp();
		return {
			clientId: input.run.clientId,
			runId: input.run.runId,
			documentId: descriptor.documentId,
			kind: descriptor.kind,
			version: "v2",
			contentMarkdown: descriptor.contentMarkdown,
			contentJson: descriptor.contentJson,
			sourceTaskId: descriptor.sourceTaskId,
			createdAt,
			updatedAt: createdAt,
		} satisfies UpsertAgentV2DocumentInput;
	});
	const tasks = taskGraph.tasks.map((task) => {
		const createdAt = nextTimestamp();
		return {
			clientId: input.run.clientId,
			runId: input.run.runId,
			taskId: task.taskId,
			kind: task.kind,
			title: task.title,
			status: task.status,
			dependsOn: [...task.dependsOn],
			acceptanceCriteria: [...task.acceptanceCriteria],
			input: { ...task.input },
			output: { ...task.output },
			createdAt,
			updatedAt: createdAt,
		} satisfies UpsertAgentV2TaskInput;
	});
	const artifacts = documentDescriptors.map((descriptor) => {
		const createdAt = nextTimestamp();
		return {
			clientId: input.run.clientId,
			runId: input.run.runId,
			artifactId: descriptor.documentId,
			kind: "planning_document",
			path: descriptor.path,
			mediaType: descriptor.mediaType,
			checksum: checksumFor(descriptor.contentJson),
			version: "v2",
			sourceTaskId: descriptor.sourceTaskId,
			validationStatus: "accepted",
			metadataJson: {
				documentId: descriptor.documentId,
				documentKind: descriptor.kind,
			},
			createdAt,
			updatedAt: createdAt,
		} satisfies UpsertAgentV2ArtifactInput;
	});
	const diagnostics = [
		createAgentV2DiagnosticEvent({
			diagnosticId: "capability-routing",
			clientId: input.run.clientId,
			runId: input.run.runId,
			severity: "info",
			category: "planning",
			code: "agent_v2.planning.capability_routing",
			phase: "capability_routing",
			taskId: "capability",
			message: decision.summary,
			data: {
				deliveryMode: decision.deliveryMode,
				requiresClarification: decision.requiresClarification,
				requiresSimulation: decision.requiresSimulation,
				unsupportedCapabilities: decision.unsupportedCapabilities,
				objective,
			},
			createdAt: nextTimestamp(),
		}),
	];

	return {
		run: input.run,
		objective,
		decision,
		spec,
		plan,
		taskGraph,
		documents,
		tasks,
		artifacts,
		diagnostics,
	};
}

export async function persistAgentV2PlanningBootstrap(
	store: Pick<
		RuntimeStore,
		| "upsertAgentV2Document"
		| "upsertAgentV2Task"
		| "upsertAgentV2Artifact"
		| "appendAgentV2Diagnostic"
		| "listAgentV2Diagnostics"
	>,
	bootstrap: AgentV2PlanningBootstrap,
): Promise<{
	documents: AgentV2DocumentRecord[];
	artifacts: AgentV2ArtifactRecord[];
}> {
	const persistedDocuments: AgentV2DocumentRecord[] = [];
	const persistedArtifacts: AgentV2ArtifactRecord[] = [];

	for (const document of bootstrap.documents) {
		persistedDocuments.push(await Promise.resolve(store.upsertAgentV2Document(document)));
	}
	for (const task of bootstrap.tasks) {
		await Promise.resolve(store.upsertAgentV2Task(task));
	}
	for (const artifact of bootstrap.artifacts) {
		persistedArtifacts.push(await Promise.resolve(store.upsertAgentV2Artifact(artifact)));
	}
	const existingDiagnosticIds = new Set(
		(
			await Promise.resolve(
				store.listAgentV2Diagnostics(bootstrap.run.clientId, bootstrap.run.runId),
			)
		).map((diagnostic) => diagnostic.diagnosticId),
	);
	for (const diagnostic of bootstrap.diagnostics) {
		if (existingDiagnosticIds.has(diagnostic.diagnosticId)) {
			continue;
		}
		await Promise.resolve(store.appendAgentV2Diagnostic(diagnostic));
		existingDiagnosticIds.add(diagnostic.diagnosticId);
	}

	return {
		documents: persistedDocuments,
		artifacts: persistedArtifacts,
	};
}

const defaultNow: TimestampFactory = () => new Date().toISOString();

function resolveObjective(run: AgentV2RunSnapshot, override?: string): string {
	if (override?.trim()) return override.trim();
	const prompt = run.input.prompt;
	if (typeof prompt === "string" && prompt.trim()) return prompt.trim();
	const objective = run.input.objective;
	if (typeof objective === "string" && objective.trim()) return objective.trim();
	return "";
}

function checksumFor(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function createTimestampSequence(baseTimestamp: string): TimestampFactory {
	const baseMs = Date.parse(baseTimestamp);
	if (Number.isNaN(baseMs)) {
		let counter = 0;
		return () => `${baseTimestamp}#${String(counter++).padStart(4, "0")}`;
	}
	let counter = 0;
	return () => new Date(baseMs + counter++).toISOString();
}
