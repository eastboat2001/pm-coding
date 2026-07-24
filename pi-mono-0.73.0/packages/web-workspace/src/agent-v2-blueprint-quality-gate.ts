import type { AgentV2ProductBlueprint, AgentV2ProductBlueprintItem } from "./agent-v2-types.js";

export type AgentV2BlueprintQualityCode =
	| "static.blueprint_chart_missing"
	| "static.blueprint_table_missing"
	| "static.blueprint_default_missing"
	| "static.blueprint_filter_missing"
	| "static.blueprint_filter_option_missing"
	| "static.blueprint_filter_scope_incomplete"
	| "static.blueprint_chart_interaction_missing"
	| "static.blueprint_chart_drilldown_incomplete";

export interface AgentV2BlueprintProjectSource {
	path: string;
	content: string;
}

export interface AgentV2BlueprintQualityIssue {
	code: AgentV2BlueprintQualityCode;
	message: string;
	path: string;
	data: Record<string, unknown>;
}

interface StructuredBlueprintRow {
	item: AgentV2ProductBlueprintItem;
	columns: string[];
}

interface ChartRequirement extends StructuredBlueprintRow {
	id: string;
	name: string;
	type: string;
	interaction: string;
}

interface TableRequirement extends StructuredBlueprintRow {
	name: string;
}

const PROJECT_SOURCE_PATTERN = /\.(?:html?|css|js|mjs|cjs|jsx|ts|tsx|vue|svelte)$/iu;
const CHART_ID_PATTERN = /^(?:CH|CHART)[-_ ]?\d+$/iu;
const DEFERRED_REQUIREMENT_PATTERN =
	/(?:optional|fallback|future|nice to have|if approved|confirmation needed|open question|tbd|可选|备选|后续|待定|确认后|开放问题)/iu;
const UNIVERSAL_DEFAULT_PATTERN = /^(?:all(?:\s+selected)?|全部(?:已选|选中)?|全选)$/iu;
const CHART_INTERACTION_PATTERN = /(?:click|tap|drill(?:-?down)?|点击|点选|轻触|下钻)/iu;
const DISTINCT_NAMED_CHART_PATTERN =
	/^(?:\*\*|__)?((?:donut|pie|pareto|scatter|heatmap|gauge|sankey|treemap|funnel|choropleth|map|network|diagram|timeline|calendar|matrix)(?:\s+(?:chart|graph|plot|view|visuali[sz]ation)))\s*[:：](?:\*\*|__)?/iu;
const VISUALIZATION_SEMANTIC_PATTERN =
	/(?:chart|graph|plot|trend|donut|pie|pareto|scatter|heatmap|gauge|sankey|treemap|funnel|choropleth|map|network|diagram|timeline|calendar|matrix|visuali[sz]ation|\bviz\b|图表|趋势|环图|饼图|帕累托|热力图|仪表|桑基|树图|漏斗|地图|网络|关系图|时间线|日历|矩阵|可视化)/iu;
const GENERIC_SURFACE_TOKENS = new Set(["chart", "charts", "dashboard", "panel", "view", "图表", "看板", "面板"]);
const EXPLICIT_DETAIL_TABLE_PATTERN =
	/(?:detail(?:ed)?\s+(?:data\s+)?(?:table|grid)|data\s+grid|明细(?:数据)?(?:表格|列表)|数据表格)/iu;

export function inspectAgentV2BlueprintQuality(input: {
	blueprint?: AgentV2ProductBlueprint;
	sources: readonly AgentV2BlueprintProjectSource[];
}): AgentV2BlueprintQualityIssue[] {
	if (!input.blueprint || input.blueprint.sourceDocuments.length === 0) return [];
	const sources = input.sources.filter((source) => PROJECT_SOURCE_PATTERN.test(source.path));
	if (sources.length === 0) return [];
	const combinedSource = sources.map((source) => source.content).join("\n");
	const targetPath = preferredTargetPath(sources);
	const rows = structuredRows(input.blueprint);
	const issues: AgentV2BlueprintQualityIssue[] = [];

	const chartRequirements = uniqueChartRequirements([
		...rows.flatMap(chartRequirementFor),
		...input.blueprint.items.flatMap(distinctNamedChartRequirementFor),
	]);
	const missingCharts = chartRequirements.filter(
		(requirement) =>
			!sourceContainsNamedSurface(combinedSource, requirement.name) ||
			sourceContainsUnimplementedChartPlaceholder(combinedSource, requirement),
	);
	if (missingCharts.length > 0) {
		issues.push({
			code: "static.blueprint_chart_missing",
			message: `Source-backed chart inventory is missing required named chart surfaces: ${missingCharts
				.map((requirement) => requirement.name)
				.join(", ")}.`,
			path: targetPath,
			data: evidenceData(
				missingCharts,
				"requiredCharts",
				missingCharts.map((requirement) => requirement.name),
			),
		});
	}

	const tableRequirements = uniqueTableRequirements(rows.flatMap(tableRequirementFor));
	if (tableRequirements.length > 0 && !sourceContainsDataTable(combinedSource)) {
		issues.push({
			code: "static.blueprint_table_missing",
			message: `Source-backed interaction inventory requires a concrete detail table/data grid, but project source contains no rendered table surface.`,
			path: targetPath,
			data: evidenceData(
				tableRequirements,
				"requiredTables",
				tableRequirements.map((requirement) => requirement.name),
			),
		});
	}

	const universalDefaults = rows.filter(isUniversalDefaultRow);
	if (universalDefaults.length > 0 && !sourceContainsUniversalDefault(combinedSource)) {
		issues.push({
			code: "static.blueprint_default_missing",
			message: `Source-backed filter defaults require an explicit All option, but project source contains no All/全选 default value.`,
			path: targetPath,
			data: evidenceData(
				universalDefaults,
				"requiredFilters",
				universalDefaults.map((requirement) => requirement.columns[0] ?? "filter"),
			),
		});
	}

	const filterRequirements = rows.filter(isFilterInventoryRow);
	const missingFilters = filterRequirements.filter((requirement) => {
		const name = requirement.columns[0] ?? "";
		return name && !sourceContainsExactLabel(combinedSource, name);
	});
	if (missingFilters.length > 0) {
		issues.push({
			code: "static.blueprint_filter_missing",
			message: `Source-backed filter inventory is missing required controls: ${missingFilters
				.map((requirement) => requirement.columns[0])
				.join(", ")}.`,
			path: targetPath,
			data: evidenceData(
				missingFilters,
				"requiredFilters",
				missingFilters.map((requirement) => requirement.columns[0] ?? "filter"),
			),
		});
	}

	const singleOptionFilters = filterRequirements.filter((requirement) => {
		const name = requirement.columns[0] ?? "";
		return name && sourceContainsOnlyOneStaticOption(combinedSource, name);
	});
	if (singleOptionFilters.length > 0) {
		issues.push({
			code: "static.blueprint_filter_option_missing",
			message: `Source-backed interactive dropdowns contain no enabled alternative to their default: ${singleOptionFilters
				.map((requirement) => requirement.columns[0])
				.join(", ")}.`,
			path: targetPath,
			data: evidenceData(
				singleOptionFilters,
				"requiredFilters",
				singleOptionFilters.map((requirement) => requirement.columns[0] ?? "filter"),
			),
		});
	}

	const incompleteFilterScope = sourceProvesAllChartsFilterScopeIncomplete(sources, filterRequirements);
	if (incompleteFilterScope) {
		issues.push({
			code: "static.blueprint_filter_scope_incomplete",
			message:
				"Source-backed filters apply to all charts, but the shared render function derives filtered rows for only part of the chart inventory.",
			path: incompleteFilterScope.path,
			data: {
				...evidenceData(
					incompleteFilterScope.requirements,
					"requiredFilters",
					incompleteFilterScope.requirements.map((requirement) => requirement.columns[0] ?? "filter"),
				),
				unfilteredCharts: incompleteFilterScope.unfilteredCharts,
				sourceEvidence: `${incompleteFilterScope.path}:${incompleteFilterScope.line} ${incompleteFilterScope.summary}`,
			},
		});
	}

	const interactiveCharts = chartRequirements.filter((requirement) =>
		CHART_INTERACTION_PATTERN.test(requirement.interaction),
	);
	const chartsMissingInteraction = interactiveCharts.filter(
		(requirement) => !sourceContainsChartInteractionForRequirement(combinedSource, requirement),
	);
	if (chartsMissingInteraction.length > 0) {
		const highConfidence = !sourceContainsAnyPointerInteraction(combinedSource);
		issues.push({
			code: "static.blueprint_chart_interaction_missing",
			message:
				"Source-backed chart inventory requires click/tap drill-down behavior, but project source contains no chart-segment interaction handler.",
			path: targetPath,
			data: {
				...evidenceData(
					chartsMissingInteraction,
					"interactiveCharts",
					chartsMissingInteraction.map((requirement) => requirement.name),
				),
				highConfidence,
			},
		});
	}

	const incompleteDrilldowns = interactiveCharts.flatMap((requirement) => {
		const proof = sourceIncompleteDrilldownTargets(combinedSource, requirement);
		return proof ? [{ requirement, ...proof }] : [];
	});
	if (incompleteDrilldowns.length > 0) {
		const proofSource = sources.find((source) =>
			incompleteDrilldowns.some(({ requirement }) => sourceIncompleteDrilldownTargets(source.content, requirement)),
		);
		const requirements = incompleteDrilldowns.map(({ requirement }) => requirement);
		const missingTargets = [
			...new Set(incompleteDrilldowns.flatMap((incomplete) => incomplete.missingTargets)),
		].sort();
		issues.push({
			code: "static.blueprint_chart_drilldown_incomplete",
			message: `Source-backed chart drill-down does not use the selected chart value in documented downstream data selection for: ${missingTargets.join(", ")}.`,
			path: proofSource?.path ?? targetPath,
			data: {
				...evidenceData(
					requirements,
					"interactiveCharts",
					requirements.map((requirement) => requirement.name),
				),
				missingTargets,
				highConfidence: incompleteDrilldowns.every((incomplete) => incomplete.highConfidence),
			},
		});
	}

	return issues;
}

function structuredRows(blueprint: AgentV2ProductBlueprint): StructuredBlueprintRow[] {
	return blueprint.items.flatMap((item) => {
		if (DEFERRED_REQUIREMENT_PATTERN.test(item.text)) return [];
		const columns = item.text
			.split(/\s*\|\s*/u)
			.map((column) => column.trim())
			.filter(Boolean);
		return columns.length >= 3 ? [{ item, columns }] : [];
	});
}

function chartRequirementFor(row: StructuredBlueprintRow): ChartRequirement[] {
	const [id = "", name = "", type = "", interaction = ""] = row.columns;
	// A structured CH-/CHART- inventory id is the authoritative chart signal.
	// Do not restrict future PMs to a hard-coded visualization taxonomy (maps,
	// gauges, networks, calendars, domain-specific plots, and new libraries are
	// all valid). Empty and explicitly table/detail rows remain fail-open below.
	if (!CHART_ID_PATTERN.test(id) || !name || !type) return [];
	// Mixed detail containers (for example Table/Line/Pie) are too ambiguous for
	// deterministic source inspection. Their concrete child charts may be named
	// elsewhere; treating the container label as mandatory would over-block.
	if (/(?:table|grid|detail|表格|明细)/iu.test(type) || /[/]/u.test(type)) return [];
	return [{ ...row, id, name, type, interaction }];
}

function tableRequirementFor(row: StructuredBlueprintRow): TableRequirement[] {
	const [id = "", name = "", , interaction = ""] = row.columns;
	if (!name || !CHART_ID_PATTERN.test(id)) return [];
	// A mixed "Table/Line/Pie" detail container is not enough by itself because
	// the document may intentionally delegate the concrete child surface. Only
	// promote an explicit interaction target such as "filter detail table". This
	// keeps database table inventories and ambiguous visual alternatives fail-open.
	if (!EXPLICIT_DETAIL_TABLE_PATTERN.test(interaction)) return [];
	if (
		!/(?:click|tap|filter|update|refresh|drill|show|display|点击|点选|筛选|更新|刷新|下钻|展示)/iu.test(interaction)
	) {
		return [];
	}
	return [{ ...row, name: `${name} detail table` }];
}

function distinctNamedChartRequirementFor(item: AgentV2ProductBlueprintItem): ChartRequirement[] {
	if (DEFERRED_REQUIREMENT_PATTERN.test(item.text)) return [];
	const name = item.text.match(DISTINCT_NAMED_CHART_PATTERN)?.[1]?.trim();
	if (!name) return [];
	return [
		{
			item,
			columns: [name, name, ""],
			id: item.id,
			name,
			type: name,
			interaction: item.text,
		},
	];
}

function uniqueChartRequirements(requirements: readonly ChartRequirement[]): ChartRequirement[] {
	return [
		...new Map(requirements.map((requirement) => [normalizeSearchText(requirement.name), requirement])).values(),
	];
}

function uniqueTableRequirements(requirements: readonly TableRequirement[]): TableRequirement[] {
	return [
		...new Map(requirements.map((requirement) => [normalizeSearchText(requirement.name), requirement])).values(),
	];
}

function isUniversalDefaultRow(row: StructuredBlueprintRow): boolean {
	const controlType = row.columns[1] ?? "";
	const defaultValue = row.columns[2] ?? "";
	return /(?:dropdown|select|下拉|选择)/iu.test(controlType) && UNIVERSAL_DEFAULT_PATTERN.test(defaultValue.trim());
}

function isFilterInventoryRow(row: StructuredBlueprintRow): boolean {
	const name = row.columns[0] ?? "";
	const controlType = row.columns[1] ?? "";
	return (
		name.length >= 2 &&
		name.length <= 80 &&
		!/(?:^filter$|control type|筛选项|控件类型)/iu.test(name) &&
		/(?:dropdown|select|下拉|选择)/iu.test(controlType)
	);
}

function sourceContainsNamedSurface(source: string, name: string): boolean {
	const normalizedSource = normalizeSearchText(source);
	const normalizedName = normalizeSearchText(name);
	if (!normalizedName) return true;
	if (normalizedSource.includes(normalizedName)) return true;
	const tokens = uniqueTokens(normalizedName).filter((token) => !GENERIC_SURFACE_TOKENS.has(token));
	if (tokens.length === 0) return true;
	if (tokens.length === 1) return normalizedSource.split(" ").includes(tokens[0] ?? "");
	const requiredCoverage = tokens.length >= 3 ? Math.ceil((tokens.length * 2) / 3) : tokens.length;
	return hasNearbyTokenCoverage(normalizedSource, tokens, requiredCoverage, 120);
}

function sourceContainsUnimplementedChartPlaceholder(source: string, requirement: ChartRequirement): boolean {
	const semanticTokens = uniqueTokens(normalizeSearchText(`${requirement.name} ${requirement.type}`)).filter(
		(token) =>
			!GENERIC_SURFACE_TOKENS.has(token) &&
			/(?:donut|pie|pareto|scatter|heatmap|gauge|sankey|treemap|funnel|choropleth|map|network|diagram|timeline|calendar|matrix|visuali[sz]ation|viz|trend|defect|department|yield|loss|ratio|环|饼|帕累托|热力|仪表|桑基|树图|漏斗|地图|网络|关系|时间线|日历|矩阵|可视化|趋势|缺陷|部门|良率)/iu.test(
				token,
			),
	);
	if (semanticTokens.length === 0) return false;
	const emptyContainers = [...source.matchAll(/<(?:div|section|article)\b([^>]*)>\s*<\/(?:div|section|article)>/giu)]
		.map((match) => ({
			id: (match[1] ?? "").match(/\bid\s*=\s*(["'])([^"']+)\1/iu)?.[2] ?? "",
			identity: normalizeSearchText(
				`${(match[1] ?? "").match(/\bid\s*=\s*(["'])([^"']+)\1/iu)?.[2] ?? ""} ${(match[1] ?? "").match(/\bclass\s*=\s*(["'])([^"']+)\1/iu)?.[2] ?? ""}`,
			),
		}))
		.filter((container) => container.id && VISUALIZATION_SEMANTIC_PATTERN.test(container.identity));
	const target = emptyContainers.find((container) =>
		semanticTokens.some(
			(token) => container.identity.split(" ").includes(token) || container.identity.includes(token),
		),
	);
	if (!target || sourceReferencesElementId(source, target.id)) return false;
	// One generic empty mount can be populated by a framework or a shared loop.
	// Block only the high-confidence asymmetric case: sibling chart mounts are
	// explicitly rendered while this source-backed mount is never referenced.
	return emptyContainers.some(
		(container) => container.id !== target.id && sourceReferencesElementId(source, container.id),
	);
}

function sourceReferencesElementId(source: string, id: string): boolean {
	const escapedId = escapeRegExp(id);
	return new RegExp(
		String.raw`(?:getElementById\s*\(\s*(["'])${escapedId}\1\s*\)|querySelector(?:All)?\s*\(\s*(["'])#${escapedId}\2\s*\))`,
		"iu",
	).test(source);
}

function sourceContainsUniversalDefault(source: string): boolean {
	return /(?:^|[^\p{L}\p{N}_])(?:all|全部|全选)(?:[^\p{L}\p{N}_]|$)/iu.test(source);
}

function sourceContainsExactLabel(source: string, label: string): boolean {
	const normalizedLabel = normalizeSearchText(label);
	return !normalizedLabel || normalizeSearchText(source).includes(normalizedLabel);
}

function sourceContainsOnlyOneStaticOption(source: string, label: string): boolean {
	// Dynamic option construction is ambiguous in source inspection. Fail open
	// and let Smoke/browser acceptance exercise the populated control instead.
	if (
		/(?:createElement\s*\(\s*["']option["']\s*\)|new\s+Option\s*\(|\.add\s*\(\s*(?:new\s+Option|[A-Za-z_$][\w$]*Option)\b)/iu.test(
			source,
		)
	) {
		return false;
	}
	const normalizedLabel = normalizeSearchText(label);
	for (const match of source.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/giu)) {
		const attrs = match[1] ?? "";
		const optionsMarkup = match[2] ?? "";
		const index = match.index ?? 0;
		const id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/iu)?.[1] ?? "";
		const associatedLabel =
			(id
				? source.match(
						new RegExp(
							`<label\\b[^>]*\\bfor\\s*=\\s*["']${escapeRegExp(id)}["'][^>]*>([\\s\\S]*?)<\\/label>`,
							"iu",
						),
					)?.[1]
				: "") ?? "";
		const prefix = source.slice(Math.max(0, index - 600), index);
		const immediatelyPrecedingLabel = prefix.match(/<label\b[^>]*>([^<>]*)<\/label>\s*$/iu)?.[1] ?? "";
		const wrappingLabel = prefix.match(/<label\b[^>]*>([^<>]*)$/iu)?.[1] ?? "";
		const controlIdentity = [
			id,
			attrs.match(/\bname\s*=\s*["']([^"']+)["']/iu)?.[1] ?? "",
			attrs.match(/\baria-label\s*=\s*["']([^"']+)["']/iu)?.[1] ?? "",
		].join(" ");
		if (
			![associatedLabel, immediatelyPrecedingLabel, wrappingLabel, controlIdentity].some((candidate) =>
				normalizeSearchText(candidate).includes(normalizedLabel),
			)
		) {
			continue;
		}
		const enabledOptions = [...optionsMarkup.matchAll(/<option\b([^>]*)>/giu)].filter(
			(option) => !/\bdisabled\b/iu.test(option[1] ?? ""),
		);
		if (enabledOptions.length === 1) return true;
	}
	return false;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sourceContainsDataTable(source: string): boolean {
	return (
		/<table\b/iu.test(source) ||
		/(?:createElement|createElementNS)\s*\(\s*["']table["']\s*\)/iu.test(source) ||
		/<(?:[A-Z][\w.]*Table|DataGrid)\b/u.test(source) ||
		/\brole\s*=\s*["'](?:table|grid)["']/iu.test(source)
	);
}

function sourceContainsChartInteraction(source: string): boolean {
	const subject = `(?:chart|svg|canvas|bar|point|segment|slice|defect|pareto|trend|plot|map|region|gauge|node|link|network|diagram|timeline|calendar|matrix|visuali[sz]ation|viz|图表|柱|数据点|缺陷|趋势|地图|区域|仪表|节点|连线|网络|关系图|时间线|日历|矩阵|可视化)`;
	const receiver = String.raw`(?:[\w$]*${subject}[\w$]*|(?:getElementById|querySelector)\s*\(\s*["'][^"']*${subject}[^"']*["']\s*\))`;
	// Static SVG/CSS charts are often rendered as semantic div marks inside a
	// template string.  In that shape the element itself can be generic while
	// the inline handler names the business mark (for example selectWeek or
	// selectDefect).  Requiring a <rect>/<canvas> tag here produced a false
	// negative and sent already-interactive dashboards into needless repair.
	// Keep this narrow: a generic Apply/Export button does not satisfy it unless
	// the invoked handler carries chart-mark semantics.
	const semanticInlineMarkInteraction =
		/<(?:div|span|li|tr|td|button|a)\b[^>]{0,640}\b(?:onclick|onpointerup)\s*=\s*["'][^"']{0,240}\b(?:select|drill|filter|show|update)(?:Week|Date|Period|Defect|Code|Point|Segment|Slice|Bar|Trend|Chart|Pareto|Department|Dept|Region|Map|Node|Link|Gauge|Network|Diagram|Timeline|Calendar|Matrix)\s*\(/iu;
	const semanticElementAliasInteraction = new RegExp(
		String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\s*\.\s*)?(?:getElementById|querySelector)\s*\(\s*["'][^"']*${subject}[^"']*["']\s*\)[\s\S]{0,4096}?\b\1\s*\.\s*(?:addEventListener\s*\(\s*["'](?:click|pointerup)["']|(?:onclick|onpointerup)\s*=)`,
		"iu",
	);
	const dynamicSvgMarkInteraction =
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:document\s*\.\s*)?createElementNS\s*\([\s\S]{0,240}?["'](?:rect|path|circle|line|polyline|polygon)["']\s*\)[\s\S]{0,4096}?\b\1\s*\.\s*(?:addEventListener\s*\(\s*["'](?:click|pointerup)["']|(?:onclick|onpointerup)\s*=)/iu;
	return (
		new RegExp(`${receiver}\\s*\\.addEventListener\\s*\\(\\s*["'](?:click|pointerup)["']`, "iu").test(source) ||
		new RegExp(`${receiver}\\s*\\.(?:onclick|onpointerup)\\s*=`, "iu").test(source) ||
		new RegExp(`${receiver}\\s*\\.on\\s*\\(\\s*["'](?:click|pointerup)["']`, "iu").test(source) ||
		new RegExp(
			`(?:select|selectAll)\\s*\\(\\s*["'][^"']*${subject}[^"']*["']\\s*\\)[\\s\\S]{0,80}\\.on\\s*\\(\\s*["']click["']`,
			"iu",
		).test(source) ||
		new RegExp(`<(?:${subject})\\b[^>]*\\bonClick\\s*=`, "iu").test(source) ||
		/(?:chart|options|plugins)[\s\S]{0,120}\bonClick\s*:/iu.test(source) ||
		new RegExp(
			`addEventListener\\s*\\(\\s*["'](?:click|pointerup)["'][\\s\\S]{0,320}(?:closest|matches)\\s*\\([^)]*${subject}`,
			"iu",
		).test(source) ||
		semanticElementAliasInteraction.test(source) ||
		dynamicSvgMarkInteraction.test(source) ||
		semanticInlineMarkInteraction.test(source) ||
		segmentUsesProvenSvgMarkFactory(source, source) ||
		sourceContainsForwardedChartInteraction(source, subject) ||
		/<(?:rect|path|circle|canvas|svg)\b[^>]*(?:onclick|onpointerup)\s*=/iu.test(source)
	);
}

function sourceContainsChartInteractionForRequirement(source: string, requirement: ChartRequirement): boolean {
	const semanticText = normalizeSearchText(`${requirement.name} ${requirement.type}`);
	const semanticTokens = uniqueTokens(semanticText).filter(
		(token) =>
			!GENERIC_SURFACE_TOKENS.has(token) &&
			!["bar", "line", "horizontal", "vertical", "ratio", "loss", "overall"].includes(token),
	);
	if (/\bdefect\b.*\bloss\b|\bloss\b.*\bdefect\b/iu.test(semanticText)) semanticTokens.push("pareto");
	const segments = declaredFunctionSegments(source).filter((segment) => {
		const normalizedName = normalizeSearchText(segment.name);
		return semanticTokens.some((token) => normalizedName.includes(token));
	});
	if (segments.length === 0) return sourceContainsChartInteraction(source);
	return (
		segments.some(
			(segment) =>
				sourceContainsChartInteraction(segment.source) ||
				segmentContainsSelectedStateInteraction(segment.source) ||
				segmentUsesProvenInteractionForwarder(source, segment.source) ||
				segmentUsesProvenSvgMarkFactory(source, segment.source),
		) || sourceContainsInlineInteractionForRequirement(source, semanticTokens)
	);
}

function sourceContainsAnyPointerInteraction(source: string): boolean {
	return (
		/\.\s*(?:onclick|onpointerup)\s*=|\.\s*addEventListener\s*\(\s*["'](?:click|pointerup)["']/iu.test(source) ||
		/\.\s*on\s*\(\s*["'](?:click|pointerup)["']|\bonClick\s*[:=]/iu.test(source) ||
		/\b(?:onclick|onpointerup)\s*=\s*["']/iu.test(source)
	);
}

function segmentContainsSelectedStateInteraction(segment: string): boolean {
	// Once a function name is tied to a source-backed chart requirement, a
	// generic local mark name (map, node, cell, shape, item...) is valid. Require
	// both a pointer/click binding and selected-state mutation in the same
	// function so an unrelated Apply/Export control cannot satisfy the chart.
	const interaction =
		/\.\s*(?:onclick|onpointerup)\s*=|\.\s*addEventListener\s*\(\s*["'](?:click|pointerup)["']/iu.test(segment);
	const selectionMutation = /\b(?:state|selection|filters)\s*\.\s*selected[A-Za-z_$][\w$]*\s*=/u.test(segment);
	return interaction && selectionMutation;
}

function segmentUsesProvenSvgMarkFactory(source: string, segment: string): boolean {
	const declarations = [
		...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)[^)]*\)\s*\{/gu),
		...source.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\(\s*)?([A-Za-z_$][\w$]*)[^=)]*(?:\))?\s*=>\s*\{/gu,
		),
	];
	for (const declaration of declarations) {
		const helperName = declaration[1];
		const tagParameter = declaration[2];
		if (!helperName || !tagParameter) continue;
		const declarationWindow = source.slice(declaration.index ?? 0, (declaration.index ?? 0) + 2_048);
		if (
			!new RegExp(String.raw`\bcreateElementNS\s*\([^)]{0,512},\s*${escapeRegExp(tagParameter)}\s*\)`, "u").test(
				declarationWindow,
			)
		) {
			continue;
		}
		const callPattern = new RegExp(
			String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${escapeRegExp(helperName)}\s*\(\s*["'](?:rect|path|circle|line|polyline|polygon)["']`,
			"gu",
		);
		for (const call of segment.matchAll(callPattern)) {
			const markAlias = call[1];
			if (!markAlias) continue;
			const interactionWindow = segment.slice(call.index ?? 0, (call.index ?? 0) + 2_048);
			if (
				new RegExp(
					String.raw`\b${escapeRegExp(markAlias)}\s*\.\s*(?:addEventListener\s*\(\s*["'](?:click|pointerup)["']|(?:onclick|onpointerup)\s*=)`,
					"u",
				).test(interactionWindow)
			) {
				return true;
			}
		}
	}
	return false;
}

function segmentUsesProvenInteractionForwarder(source: string, segment: string): boolean {
	for (const helper of source.matchAll(
		/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,512}?)\}/gu,
	)) {
		const [name, elementParameter, eventParameter, listenerParameter, body] = helper.slice(1);
		if (!name || !elementParameter || !eventParameter || !listenerParameter || !body) continue;
		if (
			!new RegExp(
				String.raw`\b${escapeRegExp(elementParameter)}\s*\.\s*addEventListener\s*\(\s*${escapeRegExp(eventParameter)}\s*,\s*${escapeRegExp(listenerParameter)}\b`,
				"u",
			).test(body)
		) {
			continue;
		}
		if (
			new RegExp(String.raw`\b${escapeRegExp(name)}\s*\([^;\r\n]{0,320}?["'](?:click|pointerup)["']`, "iu").test(
				segment,
			)
		) {
			return true;
		}
	}
	return false;
}

function sourceContainsInlineInteractionForRequirement(source: string, semanticTokens: readonly string[]): boolean {
	for (const element of source.matchAll(/<(?:svg|canvas|div)\b([^>]*)>([\s\S]{0,4096}?)<\/(?:svg|canvas|div)>/giu)) {
		const identity = normalizeSearchText(element[1] ?? "");
		if (!semanticTokens.some((token) => identity.includes(token))) continue;
		if (/<(?:rect|path|circle|div|span|button)\b[^>]*(?:onclick|onpointerup)\s*=/iu.test(element[2] ?? "")) {
			return true;
		}
	}
	return false;
}

function declaredFunctionSegments(source: string): Array<{ name: string; source: string; index: number }> {
	const declarations = [
		...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu),
		...source.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu,
		),
	].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	return declarations.flatMap((declaration, index) => {
		const name = declaration[1];
		if (!name) return [];
		const start = declaration.index ?? 0;
		const end = declarations[index + 1]?.index ?? source.length;
		return [{ name, source: source.slice(start, end), index: start }];
	});
}

function sourceProvesAllChartsFilterScopeIncomplete(
	sources: readonly AgentV2BlueprintProjectSource[],
	filterRequirements: readonly StructuredBlueprintRow[],
):
	| {
			path: string;
			line: number;
			summary: string;
			requirements: StructuredBlueprintRow[];
			unfilteredCharts: string[];
	  }
	| undefined {
	const requirements = filterRequirements.filter((requirement) =>
		/^(?:all\s+charts?|all\s+visuals?|所有图表|全部图表)$/iu.test(requirement.columns[3] ?? ""),
	);
	if (requirements.length === 0) return undefined;

	for (const projectSource of sources) {
		const segments = declaredFunctionSegments(projectSource.content);
		const segmentByName = new Map(segments.map((segment) => [segment.name, segment]));
		for (const segment of segments) {
			if (!/(?:renderAll|renderDashboard|updateDashboard|refreshDashboard|drawDashboard)/iu.test(segment.name)) {
				continue;
			}
			const filteredAlias = segment.source.match(
				/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:getFilteredData|deriveFilteredData|filterData|applyFiltersToData)\s*\(/u,
			)?.[1];
			if (!filteredAlias) continue;
			const chartCalls = [
				...segment.source.matchAll(
					/\b((?:render|draw|update)[A-Za-z_$][\w$]*(?:Chart|Graph|Plot|Trend|Pareto|Donut|Heatmap|Treemap|Funnel|Sankey|Map|Gauge|Network|Diagram|Timeline|Calendar|Matrix|Visualization|View))\s*\(([^)]*)\)/gu,
				),
			].map((call) => ({ name: call[1] ?? "", arguments: call[2] ?? "" }));
			if (chartCalls.length < 2) continue;
			const escapedAlias = escapeRegExp(filteredAlias);
			const filteredCalls = chartCalls.filter((call) => {
				if (new RegExp(String.raw`\b${escapedAlias}\b`, "u").test(call.arguments)) return true;
				if (/(?:getFilteredData|state\s*\.\s*filters|\bfilters\b)/iu.test(call.arguments)) return true;
				const callee = segmentByName.get(call.name)?.source ?? "";
				return /(?:getFilteredData\s*\(|state\s*\.\s*filters\b|\bfilters\s*\.)/iu.test(callee);
			});
			if (filteredCalls.length === 0) continue;
			const unfilteredCharts = chartCalls.filter((call) => !filteredCalls.includes(call)).map((call) => call.name);
			if (unfilteredCharts.length === 0) continue;
			const line = projectSource.content.slice(0, segment.index).split(/\r?\n/u).length;
			return {
				path: projectSource.path,
				line,
				summary: `${segment.name} derives ${filteredAlias} but does not pass filtered data or filter state to ${[
					...new Set(unfilteredCharts),
				].join(", ")}.`,
				requirements,
				unfilteredCharts: [...new Set(unfilteredCharts)].sort(),
			};
		}
	}
	return undefined;
}

function sourceContainsForwardedChartInteraction(source: string, subject: string): boolean {
	const forwardingHelpers = new Set<string>();
	const helperPattern =
		/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*,\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,512}?)\}/gu;
	for (const helper of source.matchAll(helperPattern)) {
		const [name, elementParameter, eventParameter, listenerParameter, body] = helper.slice(1);
		if (!name || !elementParameter || !eventParameter || !listenerParameter || !body) continue;
		const escapedElement = elementParameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedEvent = eventParameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const escapedListener = listenerParameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (
			new RegExp(
				String.raw`\b${escapedElement}\s*\.\s*addEventListener\s*\(\s*${escapedEvent}\s*,\s*${escapedListener}\b`,
				"u",
			).test(body)
		) {
			forwardingHelpers.add(name);
		}
	}
	for (const helperName of forwardingHelpers) {
		const escapedHelper = helperName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const semanticReceiver = String.raw`(?:[\w$]*${subject}[\w$]*|(?:\$|getElementById|querySelector)\s*\(\s*["'][^"']*${subject}[^"']*["']\s*\))`;
		if (
			new RegExp(
				String.raw`\b${escapedHelper}\s*\(\s*${semanticReceiver}\s*,\s*["'](?:click|pointerup)["']\s*,`,
				"iu",
			).test(source)
		) {
			return true;
		}
	}
	return false;
}

type DownstreamTargetGroup = {
	label: string;
	tokens: string[];
};

type DrilldownTargetProof = {
	missingTargets: string[];
	highConfidence: boolean;
};

function sourceIncompleteDrilldownTargets(
	source: string,
	requirement: ChartRequirement,
): DrilldownTargetProof | undefined {
	const semanticTokens = uniqueTokens(normalizeSearchText(requirement.name)).filter(
		(token) => !GENERIC_SURFACE_TOKENS.has(token) && !["loss", "ratio", "overall"].includes(token),
	);
	if (semanticTokens.length === 0) return undefined;
	const targetGroups = downstreamTargetGroups(requirement);
	if (targetGroups.length === 0) return undefined;
	const selectionTokens = selectionStateTokens(requirement, semanticTokens);
	const ignoredOccurrences = sourceIgnoredDownstreamSelectionOccurrences(source, semanticTokens);
	if (sourceProvesInstanceLocalHighlight(source, semanticTokens)) {
		return { missingTargets: targetGroups.map((group) => group.label), highConfidence: true };
	}
	const assignmentPattern = /\b((?:state|selection|filters)\s*\.\s*selected([A-Za-z_$][\w$]*))\s*=/giu;
	for (const assignment of source.matchAll(assignmentPattern)) {
		const qualifiedName = (assignment[1] ?? "").replace(/\s+/gu, "");
		const selectedName = normalizeSearchText(assignment[2] ?? "");
		if (!qualifiedName || !selectionTokens.some((token) => semanticallyOverlaps(selectedName, token))) continue;
		const escapedName = qualifiedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const occurrences = [...source.matchAll(new RegExp(`\\b${escapedName}\\b`, "gu"))];
		if (occurrences.length < 2) continue;
		let originatingChartUse = false;
		let sharedDataSelectionUse = false;
		let ambiguousNonOriginUse = false;
		const satisfiedTargets = new Set<string>();
		for (const occurrence of occurrences) {
			const occurrenceIndex = occurrence.index ?? 0;
			if (ignoredOccurrences.has(occurrenceIndex)) continue;
			for (const group of targetGroups) {
				if (occurrenceIsDownstreamCallArgument(source, occurrenceIndex, semanticTokens, group.tokens)) {
					satisfiedTargets.add(group.label);
				}
			}
			const scope = enclosingFunctionName(source, occurrenceIndex);
			if (!scope || /(?:reset|initiali[sz]e|setup|bootstrap)/iu.test(scope)) continue;
			const normalizedScope = normalizeSearchText(scope);
			if (
				semanticTokens.some((token) => normalizedScope.includes(token)) ||
				selectionTokens.some((token) => normalizedScope.includes(token))
			) {
				originatingChartUse = true;
				continue;
			}
			if (occurrenceParticipatesInDataSelection(source, occurrenceIndex)) {
				if (/(?:filter|derive|select|query|aggregate|group|data|rows|items)/iu.test(scope)) {
					sharedDataSelectionUse = true;
				}
				for (const group of targetGroups) {
					if (group.tokens.some((token) => normalizedScope.includes(token))) {
						satisfiedTargets.add(group.label);
					}
				}
			} else {
				// A non-originating read may flow through a shared selector, store,
				// framework binding, or generic renderer that source inspection cannot
				// associate with a named target. Preserve the diagnostic as advisory.
				ambiguousNonOriginUse = true;
			}
		}
		if (originatingChartUse) {
			// A shared selector/derivation can fan out through arbitrary application
			// architecture. Static text inspection cannot prove which named consumer
			// receives the result, so fail open and leave that relationship to real
			// browser acceptance instead of blocking a valid PM application.
			if (sharedDataSelectionUse) return undefined;
			const missingTargets = targetGroups
				.filter((group) => !satisfiedTargets.has(group.label))
				.map((group) => group.label);
			if (missingTargets.length > 0) {
				return { missingTargets, highConfidence: !ambiguousNonOriginUse };
			}
		}
	}
	return undefined;
}

function sourceIgnoredDownstreamSelectionOccurrences(source: string, semanticTokens: readonly string[]): Set<number> {
	const ignoredOccurrences = new Set<number>();
	for (const ignoredFilter of source.matchAll(
		/(?:^|[;{}\r\n])\s*(?:if\s*\([^;\r\n]{0,256}\)\s*)?[A-Za-z_$][\w$]*\s*\.\s*filter\s*\([^;\r\n]{0,512}\bstate\s*\.\s*selected([A-Za-z_$][\w$]*)\b[^;\r\n]{0,256}\)\s*;/gmu,
	)) {
		const selectedName = normalizeSearchText(ignoredFilter[1] ?? "");
		if (!semanticTokens.some((token) => semanticallyOverlaps(selectedName, token))) continue;
		for (const stateReference of ignoredFilter[0].matchAll(/\bstate\s*\.\s*selected[A-Za-z_$][\w$]*/gu)) {
			ignoredOccurrences.add((ignoredFilter.index ?? 0) + (stateReference.index ?? 0));
		}
	}
	return ignoredOccurrences;
}

function semanticallyOverlaps(left: string, right: string): boolean {
	if (!left || !right) return false;
	if (left.includes(right) || right.includes(left)) return true;
	const prefixLength = Math.min(left.length, right.length, 5);
	return prefixLength >= 4 && left.slice(0, prefixLength) === right.slice(0, prefixLength);
}

function occurrenceIsDownstreamCallArgument(
	source: string,
	index: number,
	semanticTokens: readonly string[],
	targetTokens: readonly string[],
): boolean {
	const before = source.slice(Math.max(0, index - 180), index);
	const callName = before.match(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\([^()]*$/u)?.[1];
	if (!callName) return false;
	const normalizedCall = normalizeSearchText(callName);
	if (semanticTokens.some((token) => normalizedCall.includes(token))) return false;
	if (targetTokens.some((token) => normalizedCall.includes(token))) return true;
	return /(?:synchroni[sz]e|drilldown|applySelectionTo|refreshDependent)/iu.test(callName.replace(/\s+/gu, ""));
}

function downstreamTargetGroups(requirement: ChartRequirement): DownstreamTargetGroup[] {
	const targetClause = requirement.interaction.match(
		/(?:update|refresh|filter|drill(?:-?down)?(?:\s+into)?|show|display|load|synchroni[sz]e|同步|联动|更新|刷新|筛选|下钻|展示|显示)\s*(?:the\s+)?([^.;；。]{2,160})/iu,
	)?.[1];
	if (!targetClause) return [];
	const rawTargets = targetClause
		.split(/\s*(?:\/|\||,|&|\+|、|，|→|->)\s*|\s+(?:and|then|plus)\s+|(?:以及|并且|同时|和|及|与)/iu)
		.map((value) => normalizeSearchText(value))
		.filter(Boolean);
	const groups = rawTargets.flatMap((label): DownstreamTargetGroup[] => {
		const tokens = uniqueTokens(label).filter(
			(token) => !["the", "all", "related", "corresponding", "相关", "对应"].includes(token),
		);
		if (tokens.length === 0) return [];
		const aliases = new Set(tokens);
		// Aliases improve source matching, but the target inventory itself always
		// comes from this PM blueprint row; none of these surfaces is mandatory for
		// an unrelated product requirement.
		if (tokens.some((token) => ["defect", "analysis", "loss", "缺陷", "分析", "损失"].includes(token))) {
			aliases.add("pareto");
		}
		if (tokens.some((token) => ["department", "donut", "部门", "环图"].includes(token))) {
			aliases.add("attribution");
		}
		if (tokens.some((token) => ["detail", "table", "grid", "list", "明细", "表格", "列表"].includes(token))) {
			aliases.add("rows");
			aliases.add("details");
		}
		if (tokens.some((token) => ["trend", "time", "timeline", "趋势", "时间"].includes(token))) {
			aliases.add("timeline");
		}
		return [{ label, tokens: [...aliases] }];
	});
	return [...new Map(groups.map((group) => [group.label, group])).values()];
}

function occurrenceParticipatesInDataSelection(source: string, index: number): boolean {
	const containingFunction = declaredFunctionSegments(source)
		.filter((segment) => segment.index <= index && segment.index + segment.source.length > index)
		.at(-1);
	const scopeStart = containingFunction?.index ?? 0;
	const scopeEnd = containingFunction ? containingFunction.index + containingFunction.source.length : source.length;
	const windowStart = Math.max(scopeStart, index - 320);
	const windowEnd = Math.min(scopeEnd, index + 320);
	const window = source.slice(windowStart, windowEnd);
	const relativeIndex = index - windowStart;
	if (
		/(?:style|class(?:Name)?|stroke|border|highlight|selected)\s*[=:][\s\S]{0,180}$/iu.test(
			window.slice(0, relativeIndex),
		)
	) {
		return false;
	}
	const localAlias = window
		.slice(Math.max(0, relativeIndex - 120), relativeIndex)
		.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/u)?.[1];
	if (localAlias) {
		const escapedAlias = escapeRegExp(localAlias);
		const aliasTail = window.slice(relativeIndex);
		if (
			new RegExp(
				String.raw`[;\r\n][\s\S]{0,240}\.(?:filter|find|findIndex|some|every|reduce|groupBy)\s*\([\s\S]{0,240}\b${escapedAlias}\b`,
				"u",
			).test(aliasTail)
		) {
			return true;
		}
	}
	return (
		/\.(?:filter|find|findIndex|some|every|reduce|groupBy)\s*\([\s\S]{0,360}$/u.test(
			window.slice(0, relativeIndex),
		) ||
		/\[[\s\S]{0,80}(?:state|selection|filters)\s*\./u.test(window) ||
		/(?:rows|records|data|items|series|details|defects|departments|regions|nodes|links|categories)\s*=\s*[^;\r\n]{0,240}(?:state|selection|filters)\s*\./iu.test(
			window,
		)
	);
}

function selectionStateTokens(requirement: ChartRequirement, semanticTokens: readonly string[]): string[] {
	const identity = normalizeSearchText(`${requirement.name} ${requirement.type}`);
	const tokens = new Set(semanticTokens);
	if (/(?:trend|line|bar|time|week|date|趋势|折线|柱|周|日期)/iu.test(identity)) {
		for (const token of ["week", "date", "period", "time", "point", "bar", "index", "周", "日期", "周期"]) {
			tokens.add(token);
		}
	}
	if (/(?:defect|loss|pareto|缺陷|损失|帕累托)/iu.test(identity)) {
		for (const token of ["defect", "loss", "code", "bar", "index", "缺陷", "损失", "代码"]) tokens.add(token);
	}
	return [...tokens];
}

function sourceProvesInstanceLocalHighlight(source: string, semanticTokens: readonly string[]): boolean {
	const assignmentPattern = /\b([A-Za-z_$][\w$]*(?:chart|graph|plot))\s*\.\s*(selected([A-Za-z_$][\w$]*))\s*=/giu;
	for (const assignment of source.matchAll(assignmentPattern)) {
		const chartObject = assignment[1] ?? "";
		const selectedName = normalizeSearchText(assignment[3] ?? "");
		const chartName = normalizeSearchText(chartObject);
		if (!semanticTokens.some((token) => selectedName.includes(token) || chartName.includes(token))) continue;
		const assignmentIndex = assignment.index ?? 0;
		const handlerEnd = source.indexOf("});", assignmentIndex);
		if (handlerEnd < 0 || handlerEnd - assignmentIndex > 1_200) continue;
		const handlerTail = source.slice(assignmentIndex, handlerEnd + 3);
		const escapedChartObject = chartObject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const ownRedrawPattern = new RegExp(String.raw`\b${escapedChartObject}\s*\.\s*(?:draw|render|update)\s*\(`, "iu");
		if (!ownRedrawPattern.test(handlerTail)) continue;
		const calls = [...handlerTail.matchAll(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)\s*\(/gu)]
			.map((call) => (call[1] ?? "").replace(/\s+/gu, ""))
			.filter((call) => !new RegExp(`^${escapedChartObject}\\.(?:draw|render|update)$`, "iu").test(call));
		// A delegated function or another chart/DOM update makes static intent
		// ambiguous, so fail open and let browser acceptance decide.
		if (calls.length === 0) return true;
	}
	return false;
}

function enclosingFunctionName(source: string, index: number): string | undefined {
	const before = source.slice(Math.max(0, index - 12_000), index);
	const functions = [
		...before.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu),
		...before.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu,
		),
	].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	return functions.at(-1)?.[1];
}

function evidenceData(
	requirements: readonly StructuredBlueprintRow[],
	valueKey: string,
	values: readonly string[],
): Record<string, unknown> {
	const first = requirements[0];
	return {
		[valueKey]: [...new Set(values)].sort(),
		blueprintItemIds: requirements.map((requirement) => requirement.item.id).sort(),
		blueprintEvidence: requirements.slice(0, 8).map((requirement) => ({
			path: requirement.item.sourcePath,
			line: requirement.item.line,
			text: requirement.item.text.slice(0, 500),
		})),
		...(first
			? {
					sourceEvidence: `${first.item.sourcePath}:${first.item.line} ${first.item.text}`.slice(0, 1_000),
				}
			: {}),
	};
}

function preferredTargetPath(sources: readonly AgentV2BlueprintProjectSource[]): string {
	return (
		sources.find((source) => /(?:^|\/)index\.html$/iu.test(source.path))?.path ?? sources[0]?.path ?? "index.html"
	);
}

function normalizeSearchText(value: string): string {
	return value
		.normalize("NFKC")
		.toLocaleLowerCase("en-US")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function uniqueTokens(value: string): string[] {
	return [...new Set(value.split(" ").filter((token) => token.length >= 2))];
}

function hasNearbyTokenCoverage(source: string, tokens: readonly string[], required: number, window: number): boolean {
	for (let start = 0; start < source.length; start += window) {
		const section = source.slice(start, start + window * 2);
		const coverage = tokens.filter((token) => section.includes(token)).length;
		if (coverage >= required) return true;
	}
	return false;
}
