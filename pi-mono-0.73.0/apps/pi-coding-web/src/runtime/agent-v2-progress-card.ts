import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import type {
	AgentV2RunPresentation,
	AgentV2UserStage,
	SerializedAgentV2TerminalRunPresentation,
} from "./agent-v2-run-presentation.js";

export type AgentV2ProgressPresentation = AgentV2RunPresentation | SerializedAgentV2TerminalRunPresentation;
export type AgentV2ProgressSection = "tasks" | "files" | "validation" | "skills" | "technical";
export type AgentV2ProgressTone = "active" | "success" | "warning" | "error" | "muted";

export interface AgentV2ProgressStatusView {
	text: string;
	icon: "circle" | "spinner" | "check" | "warning" | "error";
	tone: AgentV2ProgressTone;
}

export interface AgentV2ProgressStageView {
	id: AgentV2UserStage;
	label: string;
	state: "pending" | "active" | "complete" | "error";
}

export interface AgentV2ProgressSectionView {
	id: AgentV2ProgressSection;
	label: string;
	controlId: string;
	expanded: boolean;
	rows: string[];
}

export interface AgentV2ProgressCardView {
	status: AgentV2ProgressStatusView;
	stages: AgentV2ProgressStageView[];
	currentAction: string;
	elapsedLabel: string;
	sections: AgentV2ProgressSectionView[];
	deliveryHref?: string;
	failure?: { cause: string; retrySafety: string };
}

export interface AgentV2ProgressCardViewOptions {
	expandedSection: AgentV2ProgressSection | null;
	now: number;
}

const STAGES: ReadonlyArray<{ id: AgentV2UserStage; label: string }> = [
	{ id: "understanding", label: "Understanding" },
	{ id: "planning", label: "Planning" },
	{ id: "implementation", label: "Implementation" },
	{ id: "validation", label: "Validation" },
	{ id: "delivery", label: "Delivery" },
];

const SECTION_LABELS: Record<AgentV2ProgressSection, string> = {
	tasks: "Tasks",
	files: "Files",
	validation: "Validation",
	skills: "Skills",
	technical: "Technical",
};

@customElement("agent-v2-progress-card")
export class AgentV2ProgressCard extends LitElement {
	@property({ attribute: false }) presentation!: AgentV2ProgressPresentation;
	@property({ type: Boolean }) terminal = false;
	@property({ attribute: false }) expandedSection: AgentV2ProgressSection | null = null;
	@property({ attribute: false }) onSectionChange?: (section: AgentV2ProgressSection | null) => void;
	@property({ attribute: false }) now = Date.now();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render(): TemplateResult {
		const view = createAgentV2ProgressCardView(this.presentation, {
			expandedSection: this.expandedSection,
			now: this.now,
		});
		return html`
			<section
				class="agent-v2-progress-card ${this.terminal ? "agent-v2-progress-card--terminal" : ""}"
				data-run-id=${this.presentation.runId}
				aria-label="Agent progress"
			>
				<header class="agent-v2-progress-card__header">
					<div class="agent-v2-progress-card__announcement" aria-live=${this.terminal ? "off" : "polite"} aria-atomic="true">
						<div class="agent-v2-progress-card__status agent-v2-progress-card__status--${view.status.tone}">
							<span class="agent-v2-progress-card__status-icon" aria-hidden="true">${statusGlyph(view.status.icon)}</span>
							<span>${view.status.text}</span>
						</div>
						<p class="agent-v2-progress-card__action">${view.currentAction}</p>
					</div>
					<span class="agent-v2-progress-card__elapsed" aria-hidden="true">${view.elapsedLabel}</span>
				</header>

				<ol class="agent-v2-progress-card__stages" aria-label="Run phases">
					${view.stages.map(
						(stage) => html`
							<li class="agent-v2-progress-card__stage agent-v2-progress-card__stage--${stage.state}">
								<span aria-hidden="true">${stageGlyph(stage.state)}</span>
								<span>${stage.label}</span>
							</li>
						`,
					)}
				</ol>

				${
					view.failure
						? html`
							<div class="agent-v2-progress-card__failure">
								<strong>Failure:</strong> ${view.failure.cause}
								<span>${view.failure.retrySafety}</span>
							</div>
						`
						: ""
				}

				<div class="agent-v2-progress-card__sections">
					${view.sections.map((section) => this.renderSection(section))}
				</div>

				${
					view.deliveryHref
						? html`<a
								class="agent-v2-progress-card__delivery"
								href=${view.deliveryHref}
								target="_blank"
								rel="noopener noreferrer"
							>
								Open delivered app in a new page
							</a>`
						: ""
				}
			</section>
		`;
	}

	private renderSection(section: AgentV2ProgressSectionView): TemplateResult {
		return html`
			<div class="agent-v2-progress-card__section">
				<button
					type="button"
					class="agent-v2-progress-card__section-button"
					aria-expanded=${String(section.expanded)}
					aria-controls=${section.controlId}
					@click=${() => this.onSectionChange?.(section.expanded ? null : section.id)}
				>
					<span>${section.label}</span><span aria-hidden="true">${section.expanded ? "−" : "+"}</span>
				</button>
				<div id=${section.controlId} class="agent-v2-progress-card__section-content" ?hidden=${!section.expanded}>
					${
						section.rows.length > 0
							? html`<ul>${section.rows.map((row) => html`<li>${row}</li>`)}</ul>`
							: html`<p>No recorded items.</p>`
					}
				</div>
			</div>
		`;
	}
}

export function createAgentV2ProgressCardView(
	presentation: AgentV2ProgressPresentation,
	options: AgentV2ProgressCardViewOptions,
): AgentV2ProgressCardView {
	const taskRows = taskEvents(presentation).map((task) => `${task.kind}: ${task.taskId} — ${task.status}`);
	const fileRows = artifactEvents(presentation).map(
		(artifact) => `${artifact.path} — ${artifact.action}, ${artifact.validationStatus}`,
	);
	const validationRows = validationEvents(presentation).map(
		(validation) => `${validation.validationId} #${validation.attempt} — ${validation.status}: ${validation.summary}`,
	);
	const skillRows = [
		...skillEvents(presentation).map((skill) => skill.name),
		...resourceEvents(presentation).map((resource) => `${resource.name}: ${resource.path}`),
	];
	const technicalRows = [
		...outputEvents(presentation).map((output) => `${output.provider}/${output.model}: ${output.summary}`),
		...diagnosticEvents(presentation).map(
			(diagnostic) => `${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
		),
	];
	const rows: Record<AgentV2ProgressSection, string[]> = {
		tasks: taskRows,
		files: fileRows,
		validation: validationRows,
		skills: skillRows,
		technical: technicalRows,
	};
	const safeRunId = presentation.runId.replace(/[^a-zA-Z0-9_-]/gu, "-");
	const deliveryHref = safeDeliveryHref(presentation);
	const failure =
		presentation.status === "failed" && presentation.error
			? {
					cause: presentation.error.message,
					retrySafety: presentation.error.retryable ? "Safe to retry" : "Do not retry without changes",
				}
			: undefined;

	return {
		status: statusView(presentation.status),
		stages: stageViews(presentation),
		currentAction: currentAction(presentation),
		elapsedLabel: elapsedLabel(presentation, options.now),
		sections: (Object.keys(SECTION_LABELS) as AgentV2ProgressSection[]).map((id) => ({
			id,
			label: SECTION_LABELS[id],
			controlId: `agent-v2-progress-${safeRunId}-${id}`,
			expanded: options.expandedSection === id,
			rows: rows[id],
		})),
		...(deliveryHref ? { deliveryHref } : {}),
		...(failure ? { failure } : {}),
	};
}

function statusView(status: AgentV2ProgressPresentation["status"]): AgentV2ProgressStatusView {
	switch (status) {
		case "queued":
			return { text: "Queued", icon: "circle", tone: "muted" };
		case "running":
			return { text: "In progress", icon: "spinner", tone: "active" };
		case "cancelling":
			return { text: "Cancelling", icon: "warning", tone: "warning" };
		case "succeeded":
			return { text: "Completed", icon: "check", tone: "success" };
		case "failed":
			return { text: "Failed", icon: "error", tone: "error" };
		case "cancelled":
			return { text: "Cancelled", icon: "warning", tone: "warning" };
		case "interrupted":
			return { text: "Interrupted", icon: "warning", tone: "warning" };
	}
}

function stageViews(presentation: AgentV2ProgressPresentation): AgentV2ProgressStageView[] {
	const currentIndex = STAGES.findIndex((stage) => stage.id === presentation.stage);
	return STAGES.map((stage, index) => {
		let state: AgentV2ProgressStageView["state"] = "pending";
		if (presentation.status === "succeeded" || index < currentIndex) state = "complete";
		else if (index === currentIndex) state = presentation.status === "failed" ? "error" : "active";
		return { ...stage, state };
	});
}

function currentAction(presentation: AgentV2ProgressPresentation): string {
	if (presentation.status === "failed" && presentation.error) return presentation.error.message;
	if (presentation.status === "succeeded" && presentation.deliveryReport) {
		return presentation.deliveryReport.completedSummary;
	}
	const outputs = outputEvents(presentation);
	const latestOutput = outputs.at(-1);
	if (latestOutput) return latestOutput.summary;
	const runningTask = taskEvents(presentation).find((task) => task.status === "running");
	if (runningTask) return `${runningTask.kind}: ${runningTask.taskId}`;
	return STAGES.find((stage) => stage.id === presentation.stage)?.label ?? "Working";
}

function elapsedLabel(presentation: AgentV2ProgressPresentation, now: number): string {
	const times = eventTimes(presentation);
	if (times.length === 0) return "0s";
	const start = Math.min(...times);
	const end = presentation.active ? now : Math.max(...times);
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}

function safeDeliveryHref(presentation: AgentV2ProgressPresentation): string | undefined {
	if (presentation.status !== "succeeded") return undefined;
	const href = presentation.deliveryReport?.previewUrl.trim();
	if (!href) return undefined;
	if (href.startsWith("/") && !href.startsWith("//")) return href;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? href : undefined;
	} catch {
		return undefined;
	}
}

function taskEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.tasks) ? presentation.tasks : Array.from(presentation.tasks.values());
}

function artifactEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.artifacts) ? presentation.artifacts : Array.from(presentation.artifacts.values());
}

function validationEvents(presentation: AgentV2ProgressPresentation) {
	if (Array.isArray(presentation.validations)) {
		return presentation.validations.flatMap((validation) => validation.attempts);
	}
	return Array.from(presentation.validations.values()).flatMap((attempts) => Array.from(attempts.values()));
}

function diagnosticEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.diagnostics)
		? presentation.diagnostics
		: Array.from(presentation.diagnostics.values());
}

function outputEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.outputs) ? presentation.outputs : Array.from(presentation.outputs.values());
}

function skillEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.skills) ? presentation.skills : Array.from(presentation.skills.values());
}

function resourceEvents(presentation: AgentV2ProgressPresentation) {
	return Array.isArray(presentation.resources) ? presentation.resources : Array.from(presentation.resources.values());
}

function eventTimes(presentation: AgentV2ProgressPresentation): number[] {
	return [
		presentation.startedAt,
		presentation.updatedAt,
		...(presentation.endedAt ? [presentation.endedAt] : []),
		...taskEvents(presentation),
		...artifactEvents(presentation),
		...validationEvents(presentation),
		...diagnosticEvents(presentation),
		...outputEvents(presentation),
		...skillEvents(presentation),
		...resourceEvents(presentation),
		...(presentation.deliveryReport ? [presentation.deliveryReport] : []),
	]
		.map((event) => Date.parse(typeof event === "string" ? event : event.at))
		.filter(Number.isFinite);
}

function statusGlyph(icon: AgentV2ProgressStatusView["icon"]): string {
	return { circle: "○", spinner: "◌", check: "✓", warning: "!", error: "×" }[icon];
}

function stageGlyph(state: AgentV2ProgressStageView["state"]): string {
	return { pending: "○", active: "●", complete: "✓", error: "×" }[state];
}
