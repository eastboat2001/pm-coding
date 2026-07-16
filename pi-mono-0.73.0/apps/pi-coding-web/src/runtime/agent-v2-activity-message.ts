import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
	AgentV2ArtifactIndexedPayload,
	AgentV2DeliveryReportPayload,
	AgentV2DiagnosticRecordedPayload,
	AgentV2OutputRecordedPayload,
	AgentV2SkillAppliedPayload,
	AgentV2SkillResourceLoadedPayload,
	AgentV2TaskUpdatedPayload,
	AgentV2ValidationRecordedPayload,
} from "./agent-v2-browser-controller.js";

export type AgentV2ActivityEvent =
	| AgentV2TaskUpdatedPayload
	| AgentV2ArtifactIndexedPayload
	| AgentV2ValidationRecordedPayload
	| AgentV2DiagnosticRecordedPayload
	| AgentV2OutputRecordedPayload
	| AgentV2SkillAppliedPayload
	| AgentV2SkillResourceLoadedPayload
	| AgentV2DeliveryReportPayload;

export interface AgentV2ActivityMessage {
	role: "agent-v2-activity";
	id: string;
	runId?: string;
	activity: AgentV2ActivityEvent;
	timestamp: number;
}

declare module "@mariozechner/pi-agent-core" {
	interface CustomAgentMessages {
		"agent-v2-activity": AgentV2ActivityMessage;
	}
}

export interface AgentV2FailureReportData {
	failureStage: string;
	failureTask: string;
	completedItems: string[];
	failureCause: string;
	repairAttempts: number;
	diagnostics: string[];
	unpassedValidations: string[];
	safeToRetry: boolean;
	remainingItems: string[];
	nextSuggestions: string[];
	appliedSkills: string[];
	createdFiles: string[];
	updatedFiles: string[];
}

type SupportedLanguage = "en" | "zh" | "de" | "ms";

const TEXT = {
	en: {
		activity: "Activity",
		task: "Task",
		artifact: "Artifact",
		validation: "Validation",
		diagnostic: "Diagnostic",
		output: "Output",
		skill: "Skill applied",
		resource: "Skill resource",
		delivery: "Delivery report",
		completedSummary: "Completed summary",
		appliedSkills: "Skills used",
		createdFiles: "Files created",
		updatedFiles: "Files updated",
		validationStatus: "Validation status",
		buildStatus: "Build status",
		previewUrl: "Preview URL",
		usageInstructions: "Usage",
		openPreview: "Open the preview URL to use and review the generated application.",
		passed: "passed",
		notRequired: "not required",
		running: "running",
		none: "none",
		failure: "Execution failed",
		failureStage: "Failure stage",
		failureTask: "Failure task",
		progress: "Completed progress",
		cause: "Failure cause",
		repairAttempts: "Repair attempts",
		diagnostics: "Diagnostics",
		unpassedValidations: "Unpassed validations",
		safeToRetry: "Safe to retry",
		yes: "yes",
		no: "no",
		remaining: "Remaining work",
		suggestions: "Next suggestions",
	},
	zh: {
		activity: "活动",
		task: "任务",
		artifact: "产物",
		validation: "校验",
		diagnostic: "诊断",
		output: "输出",
		skill: "已应用 Skill",
		resource: "Skill 资源",
		delivery: "交付报告",
		completedSummary: "完成摘要",
		appliedSkills: "所用 Skills",
		createdFiles: "创建文件",
		updatedFiles: "修改文件",
		validationStatus: "校验状态",
		buildStatus: "构建状态",
		previewUrl: "预览 URL",
		usageInstructions: "使用说明",
		openPreview: "打开预览 URL 即可使用和检查已生成的应用。",
		passed: "通过",
		notRequired: "无需构建",
		running: "运行中",
		none: "无",
		failure: "执行失败",
		failureStage: "失败阶段",
		failureTask: "失败任务",
		progress: "已完成进度",
		cause: "失败原因",
		repairAttempts: "Repair 次数",
		diagnostics: "具体诊断",
		unpassedValidations: "未通过验证",
		safeToRetry: "可安全重试",
		yes: "是",
		no: "否",
		remaining: "剩余事项",
		suggestions: "后续建议",
	},
	de: {
		activity: "Aktivität",
		task: "Aufgabe",
		artifact: "Artefakt",
		validation: "Validierung",
		diagnostic: "Diagnose",
		output: "Ausgabe",
		skill: "Skill angewendet",
		resource: "Skill-Ressource",
		delivery: "Lieferbericht",
		completedSummary: "Zusammenfassung",
		appliedSkills: "Verwendete Skills",
		createdFiles: "Erstellte Dateien",
		updatedFiles: "Geänderte Dateien",
		validationStatus: "Validierungsstatus",
		buildStatus: "Build-Status",
		previewUrl: "Vorschau-URL",
		usageInstructions: "Verwendung",
		openPreview: "Öffnen Sie die Vorschau-URL, um die generierte Anwendung zu verwenden und zu prüfen.",
		passed: "bestanden",
		notRequired: "nicht erforderlich",
		running: "läuft",
		none: "keine",
		failure: "Ausführung fehlgeschlagen",
		failureStage: "Fehlerphase",
		failureTask: "Fehleraufgabe",
		progress: "Abgeschlossener Fortschritt",
		cause: "Fehlerursache",
		repairAttempts: "Reparaturversuche",
		diagnostics: "Diagnosen",
		unpassedValidations: "Nicht bestandene Validierungen",
		safeToRetry: "Sicher wiederholbar",
		yes: "ja",
		no: "nein",
		remaining: "Verbleibende Aufgaben",
		suggestions: "Nächste Schritte",
	},
	ms: {
		activity: "Aktiviti",
		task: "Tugas",
		artifact: "Artifak",
		validation: "Pengesahan",
		diagnostic: "Diagnostik",
		output: "Output",
		skill: "Skill digunakan",
		resource: "Sumber Skill",
		delivery: "Laporan penghantaran",
		completedSummary: "Ringkasan selesai",
		appliedSkills: "Skills digunakan",
		createdFiles: "Fail dicipta",
		updatedFiles: "Fail dikemas kini",
		validationStatus: "Status pengesahan",
		buildStatus: "Status build",
		previewUrl: "URL pratonton",
		usageInstructions: "Cara guna",
		openPreview: "Buka URL pratonton untuk menggunakan dan menyemak aplikasi yang dijana.",
		passed: "lulus",
		notRequired: "tidak diperlukan",
		running: "berjalan",
		none: "tiada",
		failure: "Pelaksanaan gagal",
		failureStage: "Peringkat gagal",
		failureTask: "Tugas gagal",
		progress: "Kemajuan selesai",
		cause: "Punca kegagalan",
		repairAttempts: "Percubaan pembaikan",
		diagnostics: "Diagnostik",
		unpassedValidations: "Pengesahan belum lulus",
		safeToRetry: "Selamat dicuba semula",
		yes: "ya",
		no: "tidak",
		remaining: "Baki kerja",
		suggestions: "Cadangan seterusnya",
	},
} as const;

export function createAgentV2ActivityMessage(activity: AgentV2ActivityEvent, runId?: string): AgentV2ActivityMessage {
	return {
		role: "agent-v2-activity",
		id: activityIdentity(activity, runId),
		...(runId ? { runId } : {}),
		activity,
		timestamp: Date.parse(activity.at),
	};
}

export function appendAgentV2ActivityMessage(
	messages: readonly AgentMessage[],
	message: AgentV2ActivityMessage,
): AgentMessage[] {
	if (messages.some((candidate) => candidate.role === "agent-v2-activity" && candidate.id === message.id)) {
		return messages as AgentMessage[];
	}
	return [...messages, message];
}

export function formatAgentV2DeliveryReport(report: AgentV2DeliveryReportPayload, language: string): string {
	const t = TEXT[normalizeLanguage(language)];
	const usageInstructions = report.usageInstructions.startsWith("Open the preview URL")
		? t.openPreview
		: report.usageInstructions;
	return [
		`## ${t.delivery}`,
		`${t.completedSummary}：${report.completedSummary}`,
		`${t.appliedSkills}：${joined(report.appliedSkills, t.none)}`,
		`${t.createdFiles}：${joined(report.createdFiles, t.none)}`,
		`${t.updatedFiles}：${joined(report.updatedFiles, t.none)}`,
		`${t.validationStatus}：${t.passed}`,
		`${t.buildStatus}：${report.buildStatus === "passed" ? t.passed : t.notRequired}`,
		`${t.previewUrl}：${report.previewUrl}`,
		`${t.usageInstructions}：${usageInstructions}`,
	].join("\n\n");
}

export function formatAgentV2FailureReport(report: AgentV2FailureReportData, language: string): string {
	const t = TEXT[normalizeLanguage(language)];
	return [
		`## ${t.failure}`,
		`${t.failureStage}：${report.failureStage}`,
		`${t.failureTask}：${report.failureTask}`,
		`${t.progress}：${joined(report.completedItems, t.none)}`,
		`${t.cause}：${report.failureCause}`,
		`${t.repairAttempts}：${report.repairAttempts}`,
		`${t.diagnostics}：${joined(report.diagnostics, t.none)}`,
		`${t.unpassedValidations}：${joined(report.unpassedValidations, t.none)}`,
		`${t.safeToRetry}：${report.safeToRetry ? t.yes : t.no}`,
		`${t.remaining}：${joined(report.remainingItems, t.none)}`,
		`${t.suggestions}：${joined(report.nextSuggestions, t.none)}`,
		`${t.appliedSkills}：${joined(report.appliedSkills, t.none)}`,
		`${t.createdFiles}：${joined(report.createdFiles, t.none)}`,
		`${t.updatedFiles}：${joined(report.updatedFiles, t.none)}`,
	].join("\n\n");
}

function activityIdentity(activity: AgentV2ActivityEvent, runId?: string): string {
	const primary =
		"taskId" in activity
			? activity.taskId
			: "artifactId" in activity
				? activity.artifactId
				: "validationId" in activity
					? activity.validationId
					: "diagnosticId" in activity
						? activity.diagnosticId
						: "path" in activity
							? `${activity.name}:${activity.path}`
							: "name" in activity
								? activity.name
								: "event";
	return [runId ?? "run", activity.type, String(primary), activity.at]
		.map((value) => encodeURIComponent(value))
		.join(":");
}

export function agentV2ActivityView(activity: AgentV2ActivityEvent, language: string) {
	const normalizedLanguage = normalizeLanguage(language);
	const t = TEXT[normalizedLanguage];
	const row = (label: string, value: unknown) => ({ label, value: String(value) });
	switch (activity.type) {
		case "agent_v2.task_updated":
			return {
				title: t.task,
				summary: `${activity.kind} · ${activity.status}`,
				tone: activity.status === "failed" ? "error" : activity.status === "succeeded" ? "success" : "active",
				open: false,
				rows: [row("taskId", activity.taskId), row("phase", activity.phase), row("status", activity.status)],
			};
		case "agent_v2.artifact_indexed":
			return {
				title: t.artifact,
				summary: `${activity.action} · ${activity.path}`,
				tone: activity.validationStatus === "failed" ? "error" : "success",
				open: false,
				rows: [
					row("path", activity.path),
					row("validation", activity.validationStatus),
					row("checksum", activity.checksum),
				],
			};
		case "agent_v2.validation_recorded":
			return {
				title: t.validation,
				summary: `${activity.status} · ${activity.summary}`,
				tone: activity.status === "failed" || activity.status === "blocked" ? "error" : "success",
				open: activity.status === "failed" || activity.status === "blocked",
				rows: [row("attempt", activity.attempt), row("taskId", activity.taskId)],
			};
		case "agent_v2.diagnostic_recorded":
			return {
				title: t.diagnostic,
				summary: activity.message,
				tone: activity.severity === "error" ? "error" : activity.severity === "warn" ? "warning" : "active",
				open: activity.severity === "error",
				rows: [row("code", activity.code), row("severity", activity.severity)],
			};
		case "agent_v2.output_recorded":
			return {
				title: t.output,
				summary: activity.summary,
				tone: "success",
				open: false,
				rows: [row("provider", activity.provider), row("model", activity.model)],
			};
		case "agent_v2.skill_applied":
			return {
				title: t.skill,
				summary: activity.name,
				tone: "active",
				open: false,
				rows: [row("location", activity.location)],
			};
		case "agent_v2.skill_resource_loaded":
			return {
				title: t.resource,
				summary: `${activity.name} · ${activity.path}`,
				tone: "active",
				open: false,
				rows: [row("path", activity.path), row("checksum", activity.checksum)],
			};
		case "agent_v2.delivery_reported":
			return {
				title: t.delivery,
				summary: activity.completedSummary,
				tone: "success",
				open: true,
				rows: [
					row(t.previewUrl, activity.previewUrl),
					row(t.validationStatus, t.passed),
					row(t.buildStatus, activity.buildStatus),
				],
			};
	}
}

function normalizeLanguage(value: string): SupportedLanguage {
	const language = value.toLowerCase().split(/[-_]/u)[0];
	return language === "zh" || language === "de" || language === "ms" ? language : "en";
}

function joined(items: readonly string[], fallback: string): string {
	return items.length > 0 ? items.join("、") : fallback;
}
