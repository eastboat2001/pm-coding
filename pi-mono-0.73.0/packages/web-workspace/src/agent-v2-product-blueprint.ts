import { createHash } from "node:crypto";
import type { AgentV2InputBlobRecord } from "./agent-v2-durable-store.js";
import type { AgentV2ResponseLanguage } from "./agent-v2-response-language.js";
import type {
	AgentV2BlueprintCategory,
	AgentV2ProductBlueprint,
	AgentV2ProductBlueprintItem,
} from "./agent-v2-types.js";

type TimestampFactory = () => string;

interface SourceLine {
	inputId: string;
	path: string;
	checksum: string;
	line: number;
	heading: string;
	text: string;
	raw: string;
}

interface BlueprintCandidate {
	line: SourceLine;
	categories: AgentV2BlueprintCategory[];
	priority: number;
}

const SOURCE_DOCUMENT_PATTERN = /\.(?:md|mdx|txt|rst|adoc)$/iu;
const MAX_ITEMS_TOTAL = 96;
const FALLBACK_ITEM_RESERVE = 2;
const MAX_ITEM_CHARS = 500;
const MAX_BLUEPRINT_TEXT_CHARS = 24_000;
const FALLBACK_TEXT_RESERVE = MAX_ITEM_CHARS * FALLBACK_ITEM_RESERVE;
const MAX_SUMMARY_CHARS = 240;
const CATEGORIES: AgentV2BlueprintCategory[] = [
	"requirement",
	"page",
	"interaction",
	"state",
	"permission",
	"visual",
	"acceptance",
];
const CATEGORY_PATTERNS: Record<AgentV2BlueprintCategory, RegExp> = {
	requirement: /(?:requirement|must|shall|should|需求|要求|必须|应当|需要|功能)/iu,
	page: /(?:dashboard|page|view|screen|module|table|detail|login|仪表盘|看板|页面|视图|模块|列表|明细|登录)/iu,
	interaction:
		/(?:filter|select|click|drill|export|download|sort|pagination|search|tab|筛选|选择|点击|下钻|导出|下载|排序|分页|搜索|切换)/iu,
	state: /(?:loading|empty|error|disabled|success|warning|加载|空状态|错误|禁用|成功|警告|无数据)/iu,
	permission: /(?:permission|role|admin|access|authorization|权限|角色|管理员|访问控制|授权)/iu,
	visual:
		/(?:visual|layout|color|typography|spacing|responsive|mobile|desktop|chart|kpi|design|视觉|布局|颜色|字体|间距|响应式|移动端|桌面端|图表|设计)/iu,
	acceptance: /(?:acceptance|accept criteria|definition of done|验收|完成标准|通过标准)/iu,
};

export function buildAgentV2ProductBlueprint(input: {
	runId: string;
	objective: string;
	responseLanguage: AgentV2ResponseLanguage;
	inputBlobs: readonly AgentV2InputBlobRecord[];
	now?: TimestampFactory;
}): AgentV2ProductBlueprint {
	const now = input.now ?? (() => new Date().toISOString());
	const sources = uniqueSourceDocuments(input.inputBlobs);
	const allLines = sources.flatMap((source) => source.lines);
	const candidates = prioritizedCandidates(
		allLines
			.map((line) => {
				const categories = matchingCategories(line);
				return { line, categories, priority: candidatePriority(line, categories) };
			})
			.filter((candidate) => candidate.categories.length > 0),
	);
	const items: AgentV2ProductBlueprintItem[] = [];
	let textChars = 0;
	let omittedItemCount = 0;
	const seenIds = new Set<string>();
	for (const candidate of candidates) {
		const text = boundedText(candidate.line.text, MAX_ITEM_CHARS);
		const id = stableItemId(candidate.line.path, text);
		if (seenIds.has(id)) continue;
		if (
			items.length >= MAX_ITEMS_TOTAL - FALLBACK_ITEM_RESERVE ||
			textChars + text.length > MAX_BLUEPRINT_TEXT_CHARS - FALLBACK_TEXT_RESERVE
		) {
			omittedItemCount += 1;
			continue;
		}
		seenIds.add(id);
		textChars += text.length;
		items.push({
			id,
			text,
			sourceInputId: candidate.line.inputId,
			sourcePath: candidate.line.path,
			sourceChecksum: candidate.line.checksum,
			line: candidate.line.line,
			categories: candidate.categories,
		});
	}
	if (!items.some((item) => item.categories.includes("requirement"))) {
		items.push(fallbackItem("requirement", input.objective));
	}
	if (!items.some((item) => item.categories.includes("acceptance"))) {
		items.push(
			fallbackItem(
				"acceptance",
				"Delivered behavior must satisfy the source-backed requirements and platform contract.",
			),
		);
	}
	const categoryItemIds = Object.fromEntries(
		CATEGORIES.map((category) => [
			category,
			items.filter((item) => item.categories.includes(category)).map((item) => item.id),
		]),
	) as Record<AgentV2BlueprintCategory, string[]>;
	const summary = blueprintSummary(input.objective, allLines);

	return {
		kind: "product_blueprint",
		version: 1,
		title: `Product Blueprint: ${summary}`,
		summary,
		responseLanguage: input.responseLanguage,
		sourceDocuments: sources.map(({ blob, text }) => ({
			inputId: blob.inputId,
			path: blob.logicalPath,
			checksum: blob.checksum,
			lineCount: lineCount(text),
		})),
		items,
		categoryItemIds,
		metadata: {
			runId: input.runId,
			createdAt: now(),
			sourceDocumentCount: sources.length,
			evidenceItemCount: items.length,
			omittedItemCount,
			truncated: omittedItemCount > 0,
		},
	};
}

function prioritizedCandidates(candidates: readonly BlueprintCandidate[]): BlueprintCandidate[] {
	const sourceOrder = [...new Set(candidates.map((candidate) => candidate.line.inputId))];
	const priorities = [...new Set(candidates.map((candidate) => candidate.priority))].sort(
		(left, right) => left - right,
	);
	const result: BlueprintCandidate[] = [];
	for (const priority of priorities) {
		const queues = new Map(
			sourceOrder.map((sourceId) => [
				sourceId,
				candidates.filter((candidate) => candidate.priority === priority && candidate.line.inputId === sourceId),
			]),
		);
		const positions = new Map(sourceOrder.map((sourceId) => [sourceId, 0]));
		let added = true;
		while (added) {
			added = false;
			for (const sourceId of sourceOrder) {
				const position = positions.get(sourceId) ?? 0;
				const next = queues.get(sourceId)?.[position];
				if (!next) continue;
				result.push(next);
				positions.set(sourceId, position + 1);
				added = true;
			}
		}
	}
	return result;
}

function candidatePriority(line: SourceLine, categories: readonly AgentV2BlueprintCategory[]): number {
	const evidence = `${line.heading} ${line.raw}`;
	if (
		/(?:\bCH[-_ ]?\d+\b|all selected|default value|main chart|donut chart|right panel|acceptance criteria|definition of done|全选|默认值|主图|环形图|右侧面板|验收标准)/iu.test(
			evidence,
		) ||
		(line.raw.includes("|") &&
			/(?:filter|query condition|chart inventory|page|function|acceptance|筛选|查询条件|图表清单|页面|功能|验收)/iu.test(
				line.heading,
			))
	) {
		return 0;
	}
	if (
		categories.includes("acceptance") ||
		categories.includes("interaction") ||
		categories.includes("page") ||
		categories.includes("state")
	) {
		return 1;
	}
	return 2;
}

function uniqueSourceDocuments(inputBlobs: readonly AgentV2InputBlobRecord[]) {
	const sources = new Map<string, { blob: AgentV2InputBlobRecord; text: string; lines: SourceLine[] }>();
	for (const blob of [...inputBlobs].sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))) {
		if (blob.encoding !== "utf8" || !SOURCE_DOCUMENT_PATTERN.test(blob.logicalPath) || sources.has(blob.inputId)) {
			continue;
		}
		const text = normalizeSourceText(new TextDecoder("utf-8", { fatal: true }).decode(blob.bytes));
		sources.set(blob.inputId, {
			blob,
			text,
			lines: sourceLines(blob.inputId, blob.logicalPath, blob.checksum, text),
		});
	}
	return [...sources.values()];
}

function matchingCategories(line: SourceLine): AgentV2BlueprintCategory[] {
	const searchText = `${line.heading} ${line.raw}`;
	return CATEGORIES.filter((category) => CATEGORY_PATTERNS[category].test(searchText));
}

function sourceLines(inputId: string, path: string, checksum: string, text: string): SourceLine[] {
	const result: SourceLine[] = [];
	let heading = "";
	for (const [index, rawLine] of text.split("\n").entries()) {
		const raw = rawLine.trim();
		if (!raw) continue;
		const headingMatch = raw.match(/^#{1,6}\s+(.+)$/u);
		if (headingMatch?.[1]) heading = cleanLine(headingMatch[1]);
		const cleaned = cleanLine(raw);
		if (!cleaned || cleaned.length < 3) continue;
		result.push({ inputId, path, checksum, line: index + 1, heading, text: cleaned, raw });
	}
	return result;
}

function fallbackItem(category: "requirement" | "acceptance", text: string): AgentV2ProductBlueprintItem {
	const bounded = boundedText(text, MAX_ITEM_CHARS);
	const checksum = "sha256:run-objective";
	const sourcePath = category === "requirement" ? "run.objective" : "agent-v2/product-blueprint";
	return {
		id: stableItemId(sourcePath, bounded),
		text: bounded,
		sourceInputId: "run-objective",
		sourcePath,
		sourceChecksum: checksum,
		line: 1,
		categories: [category],
	};
}

function stableItemId(path: string, text: string): string {
	return `blueprint:${createHash("sha256")
		.update(`${path.normalize("NFC")}\0${text}`)
		.digest("hex")
		.slice(0, 20)}`;
}

function cleanLine(value: string): string {
	return value
		.replace(/^#{1,6}\s+/u, "")
		.replace(/^[-*+]\s+/u, "")
		.replace(/^\d+[.)]\s+/u, "")
		.replace(/^[-:|\s]+|[-:|\s]+$/gu, "")
		.replace(/\s+/gu, " ")
		.trim();
}

function blueprintSummary(objective: string, lines: readonly SourceLine[]): string {
	const preferred = lines.find((line) => /(?:title|overview|summary|项目|概述|名称)/iu.test(line.heading));
	const candidate = preferred?.text || objective.split("\n").find((line) => line.trim()) || "Requested application";
	return boundedText(cleanLine(candidate), MAX_SUMMARY_CHARS);
}

function boundedText(value: string, maxChars: number): string {
	const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function normalizeSourceText(value: string): string {
	return value.normalize("NFC").replace(/\r\n?/gu, "\n");
}

function lineCount(value: string): number {
	return value.length === 0 ? 0 : value.split("\n").length;
}
