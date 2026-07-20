import type { AssistantMessage } from "@mariozechner/pi-ai";
import type {
	AgentV2OutputRecordedTransportEvent,
	AgentV2Phase,
	AgentV2RunTransportEvent,
	AgentV2ValidationRecordedTransportEvent,
} from "@mariozechner/pi-web-workspace";
import { type AgentV2UserStage, agentV2StageForPhase } from "./agent-v2-run-presentation.js";

type AgentV2ModelUsageSummary = NonNullable<AgentV2OutputRecordedTransportEvent["usage"]>;
type SupportedNarrationLocale = "zh" | "en" | "de" | "ms";

export interface AgentV2NarrationState {
	seenSemanticKeys: ReadonlySet<string>;
	lastText?: string;
}

interface AgentV2NarrationCandidateBase {
	semanticKey: string;
	text: string;
	at: string;
	alreadyNarrated: boolean;
}

export interface AgentV2PhaseNarrationCandidate extends AgentV2NarrationCandidateBase {
	source: "phase";
	stage: AgentV2UserStage;
	phase: AgentV2Phase;
}

export interface AgentV2OutputNarrationCandidate extends AgentV2NarrationCandidateBase {
	source: "output";
	taskId: string;
	provider: string;
	model: string;
	usage?: AgentV2ModelUsageSummary;
}

export interface AgentV2ValidationNarrationCandidate extends AgentV2NarrationCandidateBase {
	source: "validation";
	validationId: string;
	attempt: number;
	status: AgentV2ValidationRecordedTransportEvent["status"];
}

export type AgentV2NarrationCandidate =
	| AgentV2PhaseNarrationCandidate
	| AgentV2OutputNarrationCandidate
	| AgentV2ValidationNarrationCandidate;

export interface AgentV2NarrationProjection {
	state: AgentV2NarrationState;
	candidate?: AgentV2NarrationCandidate;
}

export interface AgentV2NarrationContext {
	runId: string;
	locale: string;
	event: AgentV2RunTransportEvent;
	objective?: string;
	artifactPaths?: readonly string[];
}

const REPAIR_COPY: Record<SupportedNarrationLocale, string> = {
	zh: "检查发现了可修复的问题。我正在读取校验结果、修正对应代码，然后重新运行检查。",
	en: "The checks found a repairable issue. I’m reviewing the validation result, correcting the affected code, and then running the checks again.",
	de: "Die Prüfung hat ein behebbares Problem gefunden. Ich werte das Ergebnis aus, korrigiere den betroffenen Code und prüfe erneut.",
	ms: "Semakan menemui isu yang boleh dibaiki. Saya sedang meneliti hasil, membetulkan kod berkaitan, kemudian menjalankan semakan semula.",
};

const VALIDATION_COPY: Record<SupportedNarrationLocale, Record<"passed" | "failed" | "warning" | "blocked", string>> = {
	zh: {
		passed: "校验已经通过：页面入口、脚本启动和静态预览检查均正常。",
		failed: "本轮校验发现问题，正在结合诊断结果判断是否可以自动修复。",
		warning: "校验完成，但仍有需要注意的项目；我会在交付结果中明确说明。",
		blocked: "校验当前无法继续，我正在整理阻塞原因和可以采取的下一步。",
	},
	en: {
		passed: "Validation passed: the page entry point, script startup, and static preview checks are all healthy.",
		failed:
			"This validation attempt found an issue. I’m using the diagnostics to determine whether it can be repaired automatically.",
		warning: "Validation completed with an item that still needs attention; I’ll call it out in the delivery result.",
		blocked: "Validation cannot continue yet. I’m preparing the blocking reason and the next available action.",
	},
	de: {
		passed: "Die Validierung war erfolgreich: Einstiegspunkt, Skriptstart und statische Vorschau funktionieren.",
		failed:
			"Dieser Prüflauf hat ein Problem gefunden. Ich ermittle anhand der Diagnose, ob es automatisch behoben werden kann.",
		warning: "Die Validierung ist abgeschlossen, enthält aber einen Hinweis, den ich bei der Übergabe aufführe.",
		blocked: "Die Validierung kann derzeit nicht fortgesetzt werden. Ich bereite Ursache und nächsten Schritt vor.",
	},
	ms: {
		passed: "Pengesahan lulus: titik masuk halaman, permulaan skrip dan pratonton statik semuanya berfungsi.",
		failed:
			"Cubaan pengesahan ini menemui isu. Saya sedang menggunakan diagnostik untuk menentukan sama ada ia boleh dibaiki secara automatik.",
		warning:
			"Pengesahan selesai dengan perkara yang masih perlu diberi perhatian dan akan dijelaskan semasa penyerahan.",
		blocked: "Pengesahan belum dapat diteruskan. Saya sedang menyediakan sebab halangan dan langkah seterusnya.",
	},
};

export function createAgentV2NarrationState(): AgentV2NarrationState {
	return { seenSemanticKeys: new Set() };
}

export function projectAgentV2Narration(
	state: AgentV2NarrationState,
	input: AgentV2NarrationContext,
): AgentV2NarrationProjection {
	const candidate = narrationCandidate(input);
	if (!candidate) return { state };

	const seenSemanticKeys = new Set(state.seenSemanticKeys);
	if (seenSemanticKeys.has(candidate.semanticKey)) return { state };
	seenSemanticKeys.add(candidate.semanticKey);
	const nextState: AgentV2NarrationState = {
		seenSemanticKeys,
		...(state.lastText ? { lastText: state.lastText } : {}),
	};
	if (candidate.text === state.lastText) return { state: nextState };

	return { state: { seenSemanticKeys, lastText: candidate.text }, candidate };
}

export function markAgentV2NarrationCandidateNarrated(candidate: AgentV2NarrationCandidate): AgentV2NarrationCandidate {
	return { ...candidate, alreadyNarrated: true };
}

export function narrationCandidateToAssistantMessage(candidate: AgentV2NarrationCandidate): AssistantMessage {
	const usage = candidate.source === "output" ? candidate.usage : undefined;
	return {
		role: "assistant",
		content: [{ type: "text", text: candidate.text }],
		api: "agent-v2",
		provider: candidate.source === "output" ? candidate.provider : "agent-v2",
		model: candidate.source === "output" ? candidate.model : "event",
		usage: {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: usage?.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage?.costTotal ?? 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(candidate.at),
	};
}

function narrationCandidate(input: AgentV2NarrationContext): AgentV2NarrationCandidate | undefined {
	if (input.event.type === "agent_v2.output_recorded") {
		return outputCandidate(input.runId, input.locale, input.event, input.artifactPaths ?? []);
	}
	if (input.event.type === "agent_v2.validation_recorded") {
		return validationCandidate(input.runId, input.locale, input.event);
	}
	if (
		input.event.type !== "agent_v2.run_created" &&
		input.event.type !== "agent_v2.planning_ready" &&
		input.event.type !== "agent_v2.phase_changed"
	) {
		return undefined;
	}
	const stage = agentV2StageForPhase(input.event.phase);
	const normalizedLocale = normalizeLocale(input.locale);
	return {
		source: "phase",
		semanticKey:
			input.event.phase === "repair"
				? `phase\u0000${input.runId}\u0000repair\u0000${input.event.at}`
				: `phase\u0000${input.runId}\u0000${stage}`,
		text:
			input.event.phase === "repair"
				? REPAIR_COPY[normalizedLocale]
				: stageCopy(normalizedLocale, stage, sanitizeObjective(input.objective)),
		at: input.event.at,
		stage,
		phase: input.event.phase,
		alreadyNarrated: false,
	};
}

function outputCandidate(
	runId: string,
	locale: string,
	event: AgentV2OutputRecordedTransportEvent,
	artifactPaths: readonly string[],
): AgentV2OutputNarrationCandidate {
	const normalizedLocale = normalizeLocale(locale);
	const paths = uniqueArtifactPaths(artifactPaths);
	return {
		source: "output",
		semanticKey: `output\u0000${runId}\u0000${event.taskId}\u0000${event.provider}\u0000${event.model}\u0000${event.at}\u0000${event.summary}\u0000${paths.join("\u0000")}`,
		text: outputCopy(normalizedLocale, event.summary, paths),
		at: event.at,
		taskId: event.taskId,
		provider: event.provider,
		model: event.model,
		...(event.usage ? { usage: event.usage } : {}),
		alreadyNarrated: false,
	};
}

function validationCandidate(
	runId: string,
	locale: string,
	event: AgentV2ValidationRecordedTransportEvent,
): AgentV2ValidationNarrationCandidate {
	return {
		source: "validation",
		semanticKey: `validation\u0000${runId}\u0000${event.validationId}\u0000${event.attempt}\u0000${event.status}`,
		text: VALIDATION_COPY[normalizeLocale(locale)][event.status],
		at: event.at,
		validationId: event.validationId,
		attempt: event.attempt,
		status: event.status,
		alreadyNarrated: false,
	};
}

function stageCopy(locale: SupportedNarrationLocale, stage: AgentV2UserStage, objective?: string): string {
	if (locale === "zh") {
		switch (stage) {
			case "understanding":
				return `我正在按以下方式理解这次任务：\n\n- 目标：${objective ?? "生成一个符合当前需求、可直接预览的 Web 应用"}\n- 交付：一个可以直接在浏览器运行和预览的应用\n- 重点：完成页面结构、核心交互、内容语言和响应式体验\n\n接下来我会确定实现结构，再生成文件并运行校验。`;
			case "planning":
				return "实施步骤已经整理好：\n\n1. 创建浏览器可直接运行的页面入口和界面结构。\n2. 实现需求中的核心功能与交互。\n3. 检查脚本启动、页面状态和响应式表现。\n4. 校验通过后发布可访问的预览。";
			case "implementation":
				return "现在开始实现：\n\n- 生成页面结构、样式和交互代码；\n- 保持应用可以独立运行，避免不必要的依赖；\n- 完成后立即检查文件、脚本和浏览器启动状态。";
			case "validation":
				return "代码已经进入检查阶段。我会验证页面入口、脚本启动、关键浏览器能力和加载状态；如果发现可修复问题，会自动修复后重新检查。";
			case "delivery":
				return "检查已经完成，正在整理交付结果、生成文件清单和可访问的预览地址。";
		}
	}
	if (locale === "de") {
		return {
			understanding: `Ich verstehe die Aufgabe so:\n\n- Ziel: ${objective ?? "eine anforderungsgerechte, direkt prüfbare Web-App erstellen"}\n- Ergebnis: eine direkt im Browser ausführbare Vorschau\n- Schwerpunkt: Seitenstruktur, Kerninteraktionen, Sprache und responsives Verhalten\n\nAls Nächstes lege ich die Struktur fest, erstelle die Dateien und führe die Validierung aus.`,
			planning:
				"Der Umsetzungsplan steht:\n\n1. Einstiegspunkt und Seitenstruktur erstellen.\n2. Kernfunktionen und Interaktionen umsetzen.\n3. Skriptstart, Zustände und responsives Verhalten prüfen.\n4. Nach erfolgreicher Prüfung die Vorschau bereitstellen.",
			implementation:
				"Ich beginne mit der Umsetzung:\n\n- Struktur, Gestaltung und Interaktionen erzeugen;\n- die Anwendung eigenständig lauffähig halten;\n- anschließend Dateien, Skripte und Browserstart prüfen.",
			validation:
				"Der Code wird jetzt geprüft. Ich kontrolliere Einstiegspunkt, Skriptstart, Browserfunktionen und Ladezustand und behebe reparierbare Probleme automatisch.",
			delivery: "Die Prüfung ist abgeschlossen. Ich bereite Ergebnis, Dateiliste und Vorschauadresse vor.",
		}[stage];
	}
	if (locale === "ms") {
		return {
			understanding: `Saya memahami tugasan ini seperti berikut:\n\n- Matlamat: ${objective ?? "membina aplikasi web yang menepati keperluan dan boleh dipratonton terus"}\n- Hasil: aplikasi yang boleh dijalankan terus dalam pelayar\n- Fokus: struktur halaman, interaksi utama, bahasa kandungan dan responsif\n\nSeterusnya saya akan menetapkan struktur, menjana fail dan menjalankan pengesahan.`,
			planning:
				"Langkah pelaksanaan telah disusun:\n\n1. Bina titik masuk dan struktur halaman.\n2. Laksanakan fungsi serta interaksi utama.\n3. Semak permulaan skrip, keadaan halaman dan paparan responsif.\n4. Terbitkan pratonton selepas pengesahan lulus.",
			implementation:
				"Pelaksanaan bermula sekarang:\n\n- Jana struktur, gaya dan kod interaksi;\n- pastikan aplikasi boleh berjalan sendiri;\n- kemudian semak fail, skrip dan permulaan pelayar.",
			validation:
				"Kod kini dalam peringkat semakan. Saya akan mengesahkan titik masuk, permulaan skrip, keupayaan pelayar dan keadaan pemuatan serta membaiki isu yang boleh dibaiki.",
			delivery: "Semakan selesai. Saya sedang menyediakan hasil, senarai fail dan alamat pratonton.",
		}[stage];
	}
	return {
		understanding: `Here is how I understand the task:\n\n- Goal: ${objective ?? "build a requirements-aligned web app that can be previewed directly"}\n- Deliverable: an application that runs directly in the browser\n- Focus: page structure, core interactions, content language, and responsive behavior\n\nNext I’ll establish the implementation structure, generate the files, and run validation.`,
		planning:
			"The implementation steps are ready:\n\n1. Create a browser-ready entry point and page structure.\n2. Implement the required core behavior and interactions.\n3. Check script startup, page states, and responsive behavior.\n4. Publish an accessible preview after validation passes.",
		implementation:
			"Implementation is now underway:\n\n- Generate the page structure, styles, and interaction code;\n- keep the application independently runnable without unnecessary dependencies;\n- check the files, scripts, and browser startup as soon as generation completes.",
		validation:
			"The code is now being checked. I’ll validate the entry point, script startup, required browser capabilities, and loading state, then automatically repair issues that can be fixed safely.",
		delivery:
			"The checks are complete. I’m preparing the delivery summary, generated-file list, and accessible preview address.",
	}[stage];
}

function outputCopy(locale: SupportedNarrationLocale, summary: string, paths: readonly string[]): string {
	const safeSummary = localizedSummary(locale, summary);
	const pathList = paths.slice(0, 6).join("、");
	const remaining = Math.max(0, paths.length - 6);
	if (locale === "zh") {
		const fileLine = paths.length
			? `已生成或更新 ${paths.length} 个文件：${pathList}${remaining ? `，以及另外 ${remaining} 个文件` : ""}。`
			: "应用代码已经生成并写入工作区。";
		return `${safeSummary ? `${safeSummary}\n\n` : ""}${fileLine}\n\n下一步将运行静态启动检查和预览验证。`;
	}
	const joined = paths.slice(0, 6).join(", ");
	const more = remaining ? `, plus ${remaining} more` : "";
	if (locale === "de") {
		const fileLine = paths.length
			? `${paths.length} Dateien wurden erstellt oder aktualisiert: ${joined}${more}.`
			: "Der Anwendungscode wurde erzeugt und in den Arbeitsbereich geschrieben.";
		return `${safeSummary ? `${safeSummary}\n\n` : ""}${fileLine}\n\nAls Nächstes folgen Start- und Vorschauprüfung.`;
	}
	if (locale === "ms") {
		const fileLine = paths.length
			? `${paths.length} fail telah dijana atau dikemas kini: ${joined}${more}.`
			: "Kod aplikasi telah dijana dan ditulis ke ruang kerja.";
		return `${safeSummary ? `${safeSummary}\n\n` : ""}${fileLine}\n\nSeterusnya saya akan menjalankan semakan permulaan statik dan pratonton.`;
	}
	const fileLine = paths.length
		? paths.length === 1
			? `1 file was created or updated: ${joined}.`
			: `${paths.length} files were created or updated: ${joined}${more}.`
		: "The application code has been generated and written to the workspace.";
	return `${safeSummary ? `${safeSummary}\n\n` : ""}${fileLine}\n\nNext I’ll run the static startup and preview checks.`;
}

function localizedSummary(locale: SupportedNarrationLocale, summary: string): string | undefined {
	const normalized = summary.trim();
	if (!normalized) return undefined;
	if (locale === "zh" && !/\p{Script=Han}/u.test(normalized)) return undefined;
	return normalized.slice(0, 800);
}

function uniqueArtifactPaths(paths: readonly string[]): string[] {
	return [...new Set(paths.map((path) => path.trim()).filter(Boolean))];
}

function sanitizeObjective(objective: string | undefined): string | undefined {
	if (!objective) return undefined;
	const normalized = objective.replace(/\s+/gu, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > 500 ? `${normalized.slice(0, 497)}…` : normalized;
}

function normalizeLocale(locale: string): SupportedNarrationLocale {
	const language = locale.trim().toLowerCase().split(/[-_]/u)[0];
	return language === "zh" || language === "de" || language === "ms" ? language : "en";
}
