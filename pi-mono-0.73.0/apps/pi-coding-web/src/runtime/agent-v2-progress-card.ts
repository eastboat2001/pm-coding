import type { AgentV2ResponseLanguage } from "@mariozechner/pi-web-workspace";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property } from "lit/decorators.js";
import { agentV2UserFacingError } from "./agent-v2-error-copy.js";
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
	emptyText: string;
}

export interface AgentV2ProgressMetricView {
	id: Exclude<AgentV2ProgressSection, "technical">;
	label: string;
	value: string;
}

export interface AgentV2ProgressCardView {
	status: AgentV2ProgressStatusView;
	stages: AgentV2ProgressStageView[];
	currentStage: string;
	currentAction: string;
	elapsedLabel: string;
	activityLabel: string;
	metrics: AgentV2ProgressMetricView[];
	sections: AgentV2ProgressSectionView[];
	deliveryHref?: string;
	completion?: { validation: string; build: string; files: string; usageInstructions: string };
	failure?: { cause: string; retrySafety: string; completedWork: string; nextAction: string };
}

export interface AgentV2ProgressCardViewOptions {
	expandedSection: AgentV2ProgressSection | null;
	now: number;
	responseLanguage?: AgentV2ResponseLanguage;
}

const STAGE_IDS: readonly AgentV2UserStage[] = [
	"understanding",
	"planning",
	"implementation",
	"validation",
	"delivery",
];
const SECTION_IDS: readonly AgentV2ProgressSection[] = ["tasks", "files", "validation", "skills", "technical"];

interface AgentV2ProgressCopy {
	ariaLabel: string;
	hideDetails: string;
	viewDetails: string;
	runPhases: string;
	validationLabel: string;
	buildLabel: string;
	filesLabel: string;
	failureLabel: string;
	openDeliveredApp: string;
	noRecordedItems: string;
	liveActivity: string;
	evidence: string;
	passed: string;
	notRequired: string;
	fileChanges(created: number, updated: number): string;
	safeToRetry: string;
	doNotRetry: string;
	completedWork(completedTasks: number, changedFiles: number): string;
	retryRun: string;
	reviewDiagnostics: string;
	sections: Record<AgentV2ProgressSection, string>;
	emptySections: Record<AgentV2ProgressSection, string>;
	metrics: Record<Exclude<AgentV2ProgressSection, "technical">, string>;
	status: Record<
		"repairing" | "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled" | "interrupted",
		string
	>;
	stages: Record<AgentV2UserStage, string>;
	repairingAction(attempt: number | undefined, reason: string): string;
	validationIssue: string;
	working: string;
	queuedAction: string;
	phaseActions: Record<AgentV2UserStage, string>;
	stageLabel(label: string, index: number, total: number): string;
}

function progressCopy(language: AgentV2ResponseLanguage): AgentV2ProgressCopy {
	if (language === "zh") {
		return {
			ariaLabel: "应用生成进度",
			hideDetails: "收起详情",
			viewDetails: "查看详情",
			runPhases: "运行阶段",
			validationLabel: "验证",
			buildLabel: "构建",
			filesLabel: "文件",
			failureLabel: "失败原因",
			openDeliveredApp: "打开生成的应用",
			noRecordedItems: "暂无记录",
			liveActivity: "实时动态",
			evidence: "运行记录",
			passed: "已通过",
			notRequired: "无需执行",
			fileChanges: (created, updated) => `新建 ${created} 个，更新 ${updated} 个`,
			safeToRetry: "可以安全重试",
			doNotRetry: "请勿在未修改的情况下重试",
			completedWork: (completedTasks, changedFiles) =>
				`已完成 ${completedTasks} 个任务，创建或更新了 ${changedFiles} 个文件`,
			retryRun: "请重试本次运行",
			reviewDiagnostics: "请查看诊断详情，然后修改需求或项目文件",
			sections: { tasks: "任务", files: "文件", validation: "验证", skills: "技能与资源", technical: "技术详情" },
			emptySections: {
				tasks: "任务图正在准备，进入执行后会在这里持续更新。",
				files: "模型完成当前步骤后，文件变更会显示在这里。",
				validation: "文件生成后将自动开始校验，并记录每次结果。",
				skills: "使用到的技能和资源会在加载后显示。",
				technical: "暂无需要关注的技术诊断。",
			},
			metrics: { tasks: "任务", files: "文件", validation: "校验", skills: "技能" },
			status: {
				repairing: "正在修复",
				queued: "已排队",
				running: "正在运行",
				cancelling: "正在取消",
				succeeded: "已完成",
				failed: "失败",
				cancelled: "已取消",
				interrupted: "已中断",
			},
			stages: {
				understanding: "理解需求",
				planning: "规划",
				implementation: "实现",
				validation: "验证",
				delivery: "交付",
			},
			repairingAction: (attempt, reason) => `正在修复验证问题${attempt ? `（第 ${attempt} 次）` : ""}：${reason}`,
			validationIssue: "验证问题",
			working: "处理中",
			queuedAction: "任务已进入队列，正在等待可用的 Worker。",
			phaseActions: {
				understanding: "正在分析需求、会话上下文与可用能力。",
				planning: "正在整理实现计划、文件结构与验证目标。",
				implementation: "正在生成应用代码并准备写入项目文件。",
				validation: "正在检查页面结构、交互行为与预览状态。",
				delivery: "正在整理交付结果、文件清单与预览地址。",
			},
			stageLabel: (label, index, total) => `${label} · 第 ${index}/${total} 阶段`,
		};
	}
	if (language === "de") {
		return {
			ariaLabel: "Fortschritt der App-Erstellung",
			hideDetails: "Details ausblenden",
			viewDetails: "Details anzeigen",
			runPhases: "Ausführungsphasen",
			validationLabel: "Validierung",
			buildLabel: "Build",
			filesLabel: "Dateien",
			failureLabel: "Fehler",
			openDeliveredApp: "Erstellte App öffnen",
			noRecordedItems: "Keine Einträge",
			liveActivity: "Live-Aktivität",
			evidence: "Ausführungsprotokoll",
			passed: "Bestanden",
			notRequired: "Nicht erforderlich",
			fileChanges: (created, updated) => `${created} erstellt, ${updated} aktualisiert`,
			safeToRetry: "Sicher wiederholbar",
			doNotRetry: "Nicht unverändert wiederholen",
			completedWork: (completedTasks, changedFiles) =>
				`${completedTasks} Aufgaben abgeschlossen; ${changedFiles} Dateien erstellt oder aktualisiert`,
			retryRun: "Ausführung erneut starten",
			reviewDiagnostics: "Diagnosedetails prüfen und Anfrage oder Projektdateien aktualisieren",
			sections: {
				tasks: "Aufgaben",
				files: "Dateien",
				validation: "Validierung",
				skills: "Fähigkeiten und Ressourcen",
				technical: "Technische Details",
			},
			emptySections: {
				tasks: "Der Aufgabenplan wird vorbereitet und hier laufend aktualisiert.",
				files: "Dateiänderungen erscheinen nach Abschluss des aktuellen Modellschritts.",
				validation: "Die Validierung beginnt automatisch, sobald Dateien verfügbar sind.",
				skills: "Verwendete Fähigkeiten und Ressourcen erscheinen nach dem Laden.",
				technical: "Keine technischen Hinweise vorhanden.",
			},
			metrics: { tasks: "Aufgaben", files: "Dateien", validation: "Prüfungen", skills: "Fähigkeiten" },
			status: {
				repairing: "Reparatur läuft",
				queued: "In Warteschlange",
				running: "Läuft",
				cancelling: "Wird abgebrochen",
				succeeded: "Abgeschlossen",
				failed: "Fehlgeschlagen",
				cancelled: "Abgebrochen",
				interrupted: "Unterbrochen",
			},
			stages: {
				understanding: "Verstehen",
				planning: "Planung",
				implementation: "Umsetzung",
				validation: "Validierung",
				delivery: "Bereitstellung",
			},
			repairingAction: (attempt, reason) =>
				`Validierungsproblem wird repariert${attempt ? ` (Versuch ${attempt})` : ""}: ${reason}`,
			validationIssue: "Validierungsproblem",
			working: "In Bearbeitung",
			queuedAction: "Die Aufgabe wartet auf einen verfügbaren Worker.",
			phaseActions: {
				understanding: "Anforderungen, Kontext und verfügbare Fähigkeiten werden analysiert.",
				planning: "Umsetzungsplan, Dateistruktur und Prüfziele werden vorbereitet.",
				implementation: "Anwendungscode wird erzeugt und für das Projekt vorbereitet.",
				validation: "Seitenstruktur, Interaktionen und Vorschau werden geprüft.",
				delivery: "Ergebnisse, Dateien und Vorschauadresse werden zusammengestellt.",
			},
			stageLabel: (label, index, total) => `${label} · Phase ${index} von ${total}`,
		};
	}
	if (language === "ms") {
		return {
			ariaLabel: "Kemajuan penjanaan aplikasi",
			hideDetails: "Sembunyikan butiran",
			viewDetails: "Lihat butiran",
			runPhases: "Fasa pelaksanaan",
			validationLabel: "Pengesahan",
			buildLabel: "Binaan",
			filesLabel: "Fail",
			failureLabel: "Kegagalan",
			openDeliveredApp: "Buka aplikasi yang dijana",
			noRecordedItems: "Tiada rekod",
			liveActivity: "Aktiviti langsung",
			evidence: "Rekod pelaksanaan",
			passed: "Lulus",
			notRequired: "Tidak diperlukan",
			fileChanges: (created, updated) => `${created} dicipta, ${updated} dikemas kini`,
			safeToRetry: "Selamat untuk dicuba semula",
			doNotRetry: "Jangan cuba semula tanpa perubahan",
			completedWork: (completedTasks, changedFiles) =>
				`${completedTasks} tugas selesai; ${changedFiles} fail dicipta atau dikemas kini`,
			retryRun: "Cuba semula pelaksanaan",
			reviewDiagnostics: "Semak butiran diagnostik dan kemas kini permintaan atau fail projek",
			sections: {
				tasks: "Tugas",
				files: "Fail",
				validation: "Pengesahan",
				skills: "Kemahiran dan sumber",
				technical: "Butiran teknikal",
			},
			emptySections: {
				tasks: "Pelan tugas sedang disediakan dan akan dikemas kini di sini.",
				files: "Perubahan fail akan muncul selepas langkah model semasa selesai.",
				validation: "Pengesahan bermula secara automatik selepas fail tersedia.",
				skills: "Kemahiran dan sumber yang digunakan akan muncul selepas dimuatkan.",
				technical: "Tiada diagnostik teknikal untuk diberi perhatian.",
			},
			metrics: { tasks: "Tugas", files: "Fail", validation: "Semakan", skills: "Kemahiran" },
			status: {
				repairing: "Sedang membaiki",
				queued: "Dalam baris gilir",
				running: "Sedang berjalan",
				cancelling: "Sedang membatalkan",
				succeeded: "Selesai",
				failed: "Gagal",
				cancelled: "Dibatalkan",
				interrupted: "Terganggu",
			},
			stages: {
				understanding: "Memahami",
				planning: "Perancangan",
				implementation: "Pelaksanaan",
				validation: "Pengesahan",
				delivery: "Penghantaran",
			},
			repairingAction: (attempt, reason) =>
				`Sedang membaiki isu pengesahan${attempt ? ` (cubaan ${attempt})` : ""}: ${reason}`,
			validationIssue: "Isu pengesahan",
			working: "Sedang diproses",
			queuedAction: "Tugas sedang menunggu Worker yang tersedia.",
			phaseActions: {
				understanding: "Keperluan, konteks dan keupayaan tersedia sedang dianalisis.",
				planning: "Pelan pelaksanaan, struktur fail dan sasaran semakan sedang disediakan.",
				implementation: "Kod aplikasi sedang dijana dan disediakan untuk projek.",
				validation: "Struktur halaman, interaksi dan pratonton sedang diperiksa.",
				delivery: "Hasil, fail dan alamat pratonton sedang disusun.",
			},
			stageLabel: (label, index, total) => `${label} · fasa ${index} daripada ${total}`,
		};
	}
	return {
		ariaLabel: "App generation progress",
		hideDetails: "Hide details",
		viewDetails: "View details",
		runPhases: "Run phases",
		validationLabel: "Validation",
		buildLabel: "Build",
		filesLabel: "Files",
		failureLabel: "Failure",
		openDeliveredApp: "Open delivered app",
		noRecordedItems: "No recorded items",
		liveActivity: "Live activity",
		evidence: "Run evidence",
		passed: "Passed",
		notRequired: "Not required",
		fileChanges: (created, updated) => `${created} created, ${updated} modified`,
		safeToRetry: "Safe to retry",
		doNotRetry: "Do not retry without changes",
		completedWork: (completedTasks, changedFiles) =>
			`${completedTasks} ${completedTasks === 1 ? "task" : "tasks"} completed; ${changedFiles} ${changedFiles === 1 ? "file" : "files"} created or updated.`,
		retryRun: "Retry this run.",
		reviewDiagnostics: "Review the diagnostic details, then update the request or project files.",
		sections: {
			tasks: "Tasks",
			files: "Files",
			validation: "Validation",
			skills: "Skills and resources",
			technical: "Technical details",
		},
		emptySections: {
			tasks: "The task graph is being prepared and will update here as work starts.",
			files: "File changes will appear after the current model step completes.",
			validation: "Validation starts automatically when generated files are available.",
			skills: "Applied skills and resources will appear after they are loaded.",
			technical: "There are no technical diagnostics to review.",
		},
		metrics: { tasks: "Tasks", files: "Files", validation: "Checks", skills: "Skills" },
		status: {
			repairing: "Repairing",
			queued: "Queued",
			running: "Running",
			cancelling: "Cancelling",
			succeeded: "Completed",
			failed: "Failed",
			cancelled: "Cancelled",
			interrupted: "Interrupted",
		},
		stages: {
			understanding: "Understanding",
			planning: "Planning",
			implementation: "Implementation",
			validation: "Validation",
			delivery: "Delivery",
		},
		repairingAction: (attempt, reason) => `Repairing${attempt ? ` (attempt ${attempt})` : ""}: ${reason}`,
		validationIssue: "Validation issue",
		working: "Working",
		queuedAction: "This task is queued and waiting for an available Worker.",
		phaseActions: {
			understanding: "Analyzing the request, conversation context, and available capabilities.",
			planning: "Preparing the implementation plan, file structure, and validation targets.",
			implementation: "Generating application code and preparing project files.",
			validation: "Checking page structure, interactions, and preview readiness.",
			delivery: "Preparing the delivery summary, file list, and preview address.",
		},
		stageLabel: (label, index, total) => `${label} · stage ${index} of ${total}`,
	};
}

@customElement("agent-v2-progress-card")
export class AgentV2ProgressCard extends LitElement {
	@property({ attribute: false }) presentation!: AgentV2ProgressPresentation;
	@property({ type: Boolean }) terminal = false;
	@property({ attribute: false }) responseLanguage: AgentV2ResponseLanguage = "en";
	@property({ type: Boolean }) detailsExpanded = false;
	@property({ attribute: false }) expandedSection: AgentV2ProgressSection | null = null;
	@property({ attribute: false }) onDetailChange?: (expanded: boolean) => void;
	@property({ attribute: false }) onSectionChange?: (section: AgentV2ProgressSection | null) => void;
	@property({ attribute: false }) now = Date.now();
	private readonly elapsedTicker = createAgentV2ElapsedTicker((now) => {
		this.now = now;
	});

	override connectedCallback(): void {
		super.connectedCallback();
		this.syncElapsedTicker();
	}

	override disconnectedCallback(): void {
		this.elapsedTicker.stop();
		super.disconnectedCallback();
	}

	protected override updated(): void {
		this.syncElapsedTicker();
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render(): TemplateResult {
		const copy = progressCopy(this.responseLanguage);
		const view = createAgentV2ProgressCardView(this.presentation, {
			expandedSection: this.expandedSection,
			now: this.now,
			responseLanguage: this.responseLanguage,
		});
		return html`
			<section
				class="agent-v2-progress-card ${this.terminal ? "agent-v2-progress-card--terminal" : ""}"
				data-run-id=${this.presentation.runId}
				aria-label=${copy.ariaLabel}
			>
				<header class="agent-v2-progress-card__header">
					<div class="agent-v2-progress-card__identity">
						<div class="agent-v2-progress-card__status agent-v2-progress-card__status--${view.status.tone}">
							<span class="agent-v2-progress-card__status-icon" aria-hidden="true">${statusGlyph(view.status.icon)}</span>
							<span>${view.status.text}</span>
						</div>
						<p class="agent-v2-progress-card__phase">${view.currentStage}</p>
					</div>
					<div class="agent-v2-progress-card__controls">
						<span class="agent-v2-progress-card__elapsed" aria-label=${view.elapsedLabel}>${view.elapsedLabel}</span>
						<button
							type="button"
							class="agent-v2-progress-card__detail-toggle"
							aria-expanded=${String(this.detailsExpanded)}
							@click=${() => this.onDetailChange?.(!this.detailsExpanded)}
						>
							<span>${this.detailsExpanded ? copy.hideDetails : copy.viewDetails}</span>
							<span class="agent-v2-progress-card__toggle-icon" aria-hidden="true">${this.detailsExpanded ? "↑" : "↓"}</span>
						</button>
					</div>
				</header>

				<ol class="agent-v2-progress-card__stages" aria-label=${copy.runPhases}>
					${view.stages.map(
						(stage, index) => html`
							<li class="agent-v2-progress-card__stage agent-v2-progress-card__stage--${stage.state}">
								<span class="agent-v2-progress-card__stage-marker" aria-hidden="true">${stageGlyph(stage.state, index)}</span>
								<span class="agent-v2-progress-card__stage-label">${stage.label}</span>
							</li>
						`,
					)}
				</ol>

				<div class="agent-v2-progress-card__live" aria-live=${this.terminal ? "off" : "polite"} aria-atomic="true">
					<div class="agent-v2-progress-card__announcement">
						<p class="agent-v2-progress-card__activity-label">
							<span class="agent-v2-progress-card__activity-dot" aria-hidden="true"></span>
							${view.activityLabel}
						</p>
						<p class="agent-v2-progress-card__action">${view.currentAction}</p>
					</div>
					<dl class="agent-v2-progress-card__metrics">
						${view.metrics.map(
							(metric) => html`
								<div class="agent-v2-progress-card__metric agent-v2-progress-card__metric--${metric.id}">
									<dt>${metric.label}</dt>
									<dd>${metric.value}</dd>
								</div>
							`,
						)}
					</dl>
				</div>

				${
					view.completion
						? html`
					<div class="agent-v2-progress-card__completion">
						<span>${copy.validationLabel}: ${view.completion.validation}</span>
						<span>${copy.buildLabel}: ${view.completion.build}</span>
						<span>${copy.filesLabel}: ${view.completion.files}</span>
						${this.detailsExpanded ? html`<span>${view.completion.usageInstructions}</span>` : ""}
					</div>`
						: ""
				}

				${
					view.failure
						? html`
							<div class="agent-v2-progress-card__failure">
								<strong>${copy.failureLabel}:</strong> ${view.failure.cause}
								<span>${view.failure.completedWork}</span>
								<span>${view.failure.retrySafety}. ${view.failure.nextAction}</span>
							</div>
						`
						: ""
				}

				${
					this.detailsExpanded
						? html`<div class="agent-v2-progress-card__details">
							<p class="agent-v2-progress-card__details-title">${copy.evidence}</p>
							<div class="agent-v2-progress-card__sections">
								${view.sections.map((section) => this.renderSection(section))}
							</div>
						</div>`
						: ""
				}

				${
					view.deliveryHref
						? html`<a
								class="agent-v2-progress-card__delivery"
								href=${view.deliveryHref}
								target="_blank"
								rel="noopener noreferrer"
							>
								${copy.openDeliveredApp}
							</a>`
						: ""
				}
			</section>
		`;
	}

	private syncElapsedTicker(): void {
		if (!this.terminal && this.presentation?.active) this.elapsedTicker.start();
		else this.elapsedTicker.stop();
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
					<span class="agent-v2-progress-card__section-heading">
						<span>${section.label}</span>
						<span class="agent-v2-progress-card__section-count">${section.rows.length}</span>
					</span>
					<span class="agent-v2-progress-card__section-icon" aria-hidden="true">${section.expanded ? "−" : "+"}</span>
				</button>
				<div id=${section.controlId} class="agent-v2-progress-card__section-content" ?hidden=${!section.expanded}>
					${
						section.rows.length > 0
							? html`<ul>${section.rows.map((row) => html`<li>${row}</li>`)}</ul>`
							: html`<p class="agent-v2-progress-card__empty">${section.emptyText}</p>`
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
	const copy = progressCopy(options.responseLanguage ?? "en");
	const tasks = taskEvents(presentation);
	const artifacts = artifactEvents(presentation);
	const validations = validationEvents(presentation);
	const skills = skillEvents(presentation);
	const resources = resourceEvents(presentation);
	const taskRows = tasks.map((task) => `${task.kind}: ${task.taskId} · ${task.status}`);
	const fileRows = artifactEvents(presentation).map(
		(artifact) => `${artifact.path} · ${artifact.action}, ${artifact.validationStatus}`,
	);
	const validationRows = validationEvents(presentation).map(
		(validation) => `${validation.validationId} #${validation.attempt} · ${validation.status}: ${validation.summary}`,
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
	const delivery = presentation.deliveryReport;
	const completion =
		presentation.status === "succeeded" && delivery
			? {
					validation: copy.passed,
					build: delivery.buildStatus === "passed" ? copy.passed : copy.notRequired,
					files: copy.fileChanges(delivery.createdFiles.length, delivery.updatedFiles.length),
					usageInstructions: delivery.usageInstructions,
				}
			: undefined;
	const completedTasks = taskEvents(presentation).filter((task) => task.status === "succeeded").length;
	const changedFiles = artifactEvents(presentation).length;
	const failure =
		presentation.status === "failed" && presentation.error
			? {
					cause: agentV2UserFacingError(presentation.error, options.responseLanguage ?? "en"),
					retrySafety: presentation.error.retryable ? copy.safeToRetry : copy.doNotRetry,
					completedWork: copy.completedWork(completedTasks, changedFiles),
					nextAction: presentation.error.retryable ? copy.retryRun : copy.reviewDiagnostics,
				}
			: undefined;

	return {
		status: statusView(presentation, copy),
		stages: stageViews(presentation, copy),
		currentStage: currentStageLabel(presentation.status === "succeeded" ? "delivery" : presentation.stage, copy),
		currentAction: currentAction(presentation, copy, options.responseLanguage ?? "en"),
		elapsedLabel: elapsedLabel(presentation, options.now),
		activityLabel: copy.liveActivity,
		metrics: [
			{
				id: "tasks",
				label: copy.metrics.tasks,
				value:
					tasks.length > 0 ? `${tasks.filter((task) => task.status === "succeeded").length}/${tasks.length}` : "0",
			},
			{ id: "files", label: copy.metrics.files, value: String(artifacts.length) },
			{ id: "validation", label: copy.metrics.validation, value: String(validations.length) },
			{ id: "skills", label: copy.metrics.skills, value: String(skills.length + resources.length) },
		],
		sections: SECTION_IDS.map((id) => ({
			id,
			label: copy.sections[id],
			controlId: `agent-v2-progress-${safeRunId}-${id}`,
			expanded: options.expandedSection === id,
			rows: rows[id],
			emptyText: copy.emptySections[id],
		})),
		...(deliveryHref ? { deliveryHref } : {}),
		...(completion ? { completion } : {}),
		...(failure ? { failure } : {}),
	};
}

function statusView(presentation: AgentV2ProgressPresentation, copy: AgentV2ProgressCopy): AgentV2ProgressStatusView {
	if (presentation.repairing) return { text: copy.status.repairing, icon: "spinner", tone: "warning" };
	switch (presentation.status) {
		case "queued":
			return { text: copy.status.queued, icon: "circle", tone: "muted" };
		case "running":
			return { text: copy.status.running, icon: "spinner", tone: "active" };
		case "cancelling":
			return { text: copy.status.cancelling, icon: "warning", tone: "warning" };
		case "succeeded":
			return { text: copy.status.succeeded, icon: "check", tone: "success" };
		case "failed":
			return { text: copy.status.failed, icon: "error", tone: "error" };
		case "cancelled":
			return { text: copy.status.cancelled, icon: "warning", tone: "warning" };
		case "interrupted":
			return { text: copy.status.interrupted, icon: "warning", tone: "warning" };
	}
}

function stageViews(presentation: AgentV2ProgressPresentation, copy: AgentV2ProgressCopy): AgentV2ProgressStageView[] {
	const currentIndex = STAGE_IDS.indexOf(presentation.stage);
	return STAGE_IDS.map((id, index) => {
		let state: AgentV2ProgressStageView["state"] = "pending";
		if (presentation.status === "succeeded" || index < currentIndex) state = "complete";
		else if (index === currentIndex) state = presentation.status === "failed" ? "error" : "active";
		return { id, label: copy.stages[id], state };
	});
}

function currentAction(
	presentation: AgentV2ProgressPresentation,
	copy: AgentV2ProgressCopy,
	responseLanguage: AgentV2ResponseLanguage,
): string {
	if (presentation.repairing) {
		return copy.repairingAction(presentation.repairAttempt, presentation.repairReason ?? copy.validationIssue);
	}
	if (presentation.status === "failed" && presentation.error) {
		return agentV2UserFacingError(presentation.error, responseLanguage);
	}
	if (presentation.status === "succeeded" && presentation.deliveryReport) {
		return presentation.deliveryReport.completedSummary;
	}
	const outputs = outputEvents(presentation);
	const latestOutput = outputs.at(-1);
	if (latestOutput) return latestOutput.summary;
	const runningTask = taskEvents(presentation).find((task) => task.status === "running");
	if (runningTask) return `${copy.phaseActions[presentation.stage]} (${runningTask.taskId})`;
	if (presentation.status === "queued") return copy.queuedAction;
	return copy.phaseActions[presentation.stage] ?? copy.working;
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
	const delivery = presentation.deliveryReport;
	if (
		!delivery ||
		delivery.validationStatus !== "passed" ||
		(delivery.buildStatus !== "passed" && delivery.buildStatus !== "not_required") ||
		delivery.previewStatus !== "running" ||
		delivery.previewReadiness.verified !== true ||
		delivery.previewReadiness.ready !== true ||
		delivery.previewReadiness.reasonCode !== "ready"
	)
		return undefined;
	const href = delivery.previewUrl.trim();
	if (!href) return undefined;
	if (href.startsWith("/") && !href.startsWith("//")) return href;
	try {
		const url = new URL(href);
		return url.protocol === "http:" || url.protocol === "https:" ? href : undefined;
	} catch {
		return undefined;
	}
}

function currentStageLabel(stage: AgentV2UserStage, copy: AgentV2ProgressCopy): string {
	const index = STAGE_IDS.indexOf(stage);
	return copy.stageLabel(copy.stages[stage] ?? copy.working, Math.max(1, index + 1), STAGE_IDS.length);
}

export interface AgentV2ElapsedTicker {
	start(): void;
	stop(): void;
}

export function createAgentV2ElapsedTicker(onTick: (now: number) => void, intervalMs = 1000): AgentV2ElapsedTicker {
	let timer: ReturnType<typeof setInterval> | undefined;
	return {
		start() {
			if (timer !== undefined) return;
			timer = setInterval(() => onTick(Date.now()), intervalMs);
		},
		stop() {
			if (timer === undefined) return;
			clearInterval(timer);
			timer = undefined;
		},
	};
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

function stageGlyph(state: AgentV2ProgressStageView["state"], index: number): string {
	return state === "complete" ? "✓" : state === "error" ? "×" : String(index + 1);
}
