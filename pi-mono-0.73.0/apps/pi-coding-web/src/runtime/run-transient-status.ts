import type { AgentV2Phase, AgentV2ResponseLanguage } from "@mariozechner/pi-web-workspace";

export type RunTransientStatusSource = "connection" | "retry" | "providerStalled";

export type RunTransientStatusTexts = Partial<Record<RunTransientStatusSource, string>>;

type ProviderStallStatusLabel =
	"Model is still processing. Tool calls or long context steps may pause visible output briefly.";

const PROVIDER_STALL_STATUS_MIN_DELAY_MS = 5_000;
const PROVIDER_STALL_STATUS_MAX_DELAY_MS = 30_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 60_000;
export const AGENT_V2_RUN_NO_PROGRESS_WARNING_MS = 180_000;

const RUN_NO_PROGRESS_COPY: Record<AgentV2ResponseLanguage, string> = {
	zh: "已超过 3 分钟没有收到新的执行进度。Worker 或模型连接可能已经中断，请查看详情；必要时停止后重试。",
	en: "No new execution progress has arrived for over 3 minutes. The worker or model connection may have stopped; review details and stop to retry if needed.",
	de: "Seit über 3 Minuten ist kein neuer Ausführungsfortschritt eingegangen. Worker oder Modellverbindung könnten unterbrochen sein; Details prüfen und bei Bedarf stoppen und erneut versuchen.",
	ms: "Tiada kemajuan pelaksanaan baharu diterima selama lebih 3 minit. Worker atau sambungan model mungkin terhenti; semak butiran dan hentikan untuk mencuba semula jika perlu.",
};

const RUN_ACTIVITY_COPY: Record<
	AgentV2ResponseLanguage,
	Record<"understanding" | "implementation" | "validation" | "delivery", string>
> = {
	zh: {
		understanding: "正在分析需求并规划应用结构…",
		implementation: "模型正在处理应用生成请求…",
		validation: "正在检查生成结果并处理问题…",
		delivery: "正在准备应用预览与交付结果…",
	},
	en: {
		understanding: "Analyzing the request and planning the app structure…",
		implementation: "The model is processing the app generation request…",
		validation: "Checking the generated result and addressing issues…",
		delivery: "Preparing the app preview and delivery result…",
	},
	de: {
		understanding: "Die Anfrage wird analysiert und die App-Struktur geplant…",
		implementation: "Das Modell verarbeitet die Anfrage zur App-Erstellung…",
		validation: "Das Ergebnis wird geprüft und Probleme werden behoben…",
		delivery: "App-Vorschau und Übergabe werden vorbereitet…",
	},
	ms: {
		understanding: "Menganalisis permintaan dan merancang struktur aplikasi…",
		implementation: "Model sedang memproses permintaan penjanaan aplikasi…",
		validation: "Menyemak hasil dan menangani isu yang ditemui…",
		delivery: "Menyediakan pratonton aplikasi dan hasil penyerahan…",
	},
};

const IMPLEMENTATION_ACTIVITY_COPY: Record<AgentV2ResponseLanguage, readonly [string, string, string, string]> = {
	zh: [
		"模型正在生成页面结构和核心内容…",
		"模型正在补充样式、模拟数据和交互逻辑…",
		"模型正在整理完整文件并检查输出格式…",
		"页面内容较多，模型仍在生成完整结果…",
	],
	en: [
		"The model is generating the page structure and core content…",
		"The model is adding styles, sample data, and interaction logic…",
		"The model is assembling complete files and checking the output format…",
		"This page has substantial content; the model is still completing the result…",
	],
	de: [
		"Das Modell erzeugt Seitenstruktur und Kerninhalte…",
		"Das Modell ergänzt Gestaltung, Beispieldaten und Interaktionen…",
		"Das Modell stellt vollständige Dateien zusammen und prüft das Ausgabeformat…",
		"Die Seite enthält viele Inhalte; das Modell vervollständigt das Ergebnis…",
	],
	ms: [
		"Model sedang menjana struktur halaman dan kandungan utama…",
		"Model sedang menambah gaya, data contoh dan logik interaksi…",
		"Model sedang menyusun fail lengkap dan menyemak format output…",
		"Halaman ini mempunyai banyak kandungan; model masih melengkapkan hasil…",
	],
};

export const AGENT_V2_RUN_ACTIVITY_TICK_MS = 1_000;

export function agentV2RunActivityStatusText(
	phase: AgentV2Phase | undefined,
	elapsedMs: number,
	language: AgentV2ResponseLanguage,
): string {
	const copy = RUN_ACTIVITY_COPY[language];
	const elapsedSeconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1_000));
	if (elapsedSeconds * 1_000 >= AGENT_V2_RUN_NO_PROGRESS_WARNING_MS) {
		return `${RUN_NO_PROGRESS_COPY[language]} (${elapsedSeconds}s)`;
	}
	const stage = activityStage(phase);
	const label =
		stage === "implementation"
			? IMPLEMENTATION_ACTIVITY_COPY[language][implementationActivityIndex(elapsedSeconds)]
			: copy[stage];
	return `${label} (${elapsedSeconds}s)`;
}

export function providerStallStatusText(
	translate: (label: ProviderStallStatusLabel) => string = (label) => label,
): string {
	return translate("Model is still processing. Tool calls or long context steps may pause visible output briefly.");
}

export function selectRunTransientStatusText(statuses: RunTransientStatusTexts): string {
	return statuses.connection || statuses.retry || statuses.providerStalled || "";
}

export function providerStallStatusDelayMs(streamIdleTimeoutMs: number | undefined): number {
	const timeoutMs =
		typeof streamIdleTimeoutMs === "number" && Number.isFinite(streamIdleTimeoutMs) && streamIdleTimeoutMs > 0
			? streamIdleTimeoutMs
			: DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	if (timeoutMs <= PROVIDER_STALL_STATUS_MIN_DELAY_MS) {
		return Math.max(1_000, Math.floor(timeoutMs / 2));
	}
	return Math.min(
		PROVIDER_STALL_STATUS_MAX_DELAY_MS,
		Math.max(PROVIDER_STALL_STATUS_MIN_DELAY_MS, Math.floor(timeoutMs / 2)),
	);
}

export function shouldClearProviderStallStatusForRunEvent(payloadType: string | undefined): boolean {
	return payloadType === "tool_execution_start";
}

export function shouldScheduleProviderStallStatusAfterRunEvent(payloadType: string | undefined): boolean {
	if (!payloadType || payloadType === "agent_end") return false;
	return payloadType !== "tool_execution_start";
}

function activityStage(
	phase: AgentV2Phase | undefined,
): "understanding" | "implementation" | "validation" | "delivery" {
	if (phase === "validation" || phase === "repair") return "validation";
	if (phase === "preview" || phase === "delivery") return "delivery";
	if (phase === "implementation") return "implementation";
	return "understanding";
}

function implementationActivityIndex(elapsedSeconds: number): 0 | 1 | 2 | 3 {
	if (elapsedSeconds >= 90) return 3;
	if (elapsedSeconds >= 45) return 2;
	if (elapsedSeconds >= 15) return 1;
	return 0;
}
