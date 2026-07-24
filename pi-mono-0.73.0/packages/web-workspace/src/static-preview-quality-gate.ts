import { existsSync, readFileSync } from "node:fs";
import { normalize } from "node:path";
import { classifyStaticResourceReference, staticHtmlAttributeValue } from "./static-preview.js";
import { WorkspacePathAuthorizationError, WorkspacePathGuard } from "./workspace-path-guard.js";

export interface StaticPreviewQualityGateInput {
	serveRoot: string;
	indexFile?: string;
}

export interface StaticPreviewQualityGateResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	checkedFiles: string[];
}

type LocalScript = {
	src: string;
	path: string;
	content: string;
};

type LocalStylesheet = {
	href: string;
	content: string;
};

type StaticTextElement = {
	tagName: string;
	id: string;
	classNames: string[];
	style: string;
	text: string;
};

type StaticMarkupElement = {
	tagName: string;
	id: string;
	classNames: string[];
	style: string;
	children: StaticMarkupElement[];
	parent?: StaticMarkupElement;
};

type StaticCanvasElement = StaticMarkupElement & {
	tagName: "canvas";
};

type ScriptSource = {
	path: string;
	content: string;
	lineOffset: number;
};

type CanvasBitmapScaling = {
	canvasVariable: string;
	canvasIds: string[];
	hasScopedDisplaySize: boolean;
	widthExpression: string;
	heightExpression: string;
	path: string;
	line: number;
	excerpt: string;
};

type ExplicitSelectBindingMap = {
	collectionName: string;
	entries: Array<{ id: string; property: string; index: number }>;
	index: number;
};

type CssColor = {
	r: number;
	g: number;
	b: number;
	a: number;
};

const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(['"])([^'"]+)\1/g;
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(['"])([^'"]*)\1/;
const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*(['"])([^'"]*)\1/;
const SCRIPT_TAG_PATTERN = /<script\b([^>]*)>/gi;
const LINK_TAG_PATTERN = /<link\b([^>]*)>/gi;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const QUERY_SELECTOR_PATTERN = /\b(?:document\.)?(?:querySelector|querySelectorAll)\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const DOLLAR_SELECTOR_PATTERN = /\$\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const STYLE_TAG_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const SCRIPT_BLOCK_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const CANVAS_TAG_PATTERN = /<canvas\b([^>]*)>/gi;
const CSS_RULE_PATTERN = /([^{}]+)\{([^{}]*)\}/g;
const CHART_CONSTRUCTOR_PATTERN = /\bnew\s+Chart\s*\(/u;
const DISABLED_CHART_ASPECT_RATIO_PATTERN = /\bmaintainAspectRatio\s*:\s*false\b/u;
const DEDICATED_CHART_CONTAINER_SELECTOR_PATTERN =
	/(?:chart|graph|plot|visuali[sz]ation)(?:[-_ ]?(?:container|wrapper|viewport|frame|panel|region|area))|(?:container|wrapper|viewport|frame|panel|region|area)(?:[-_ ]?(?:chart|graph|plot|visuali[sz]ation))/iu;
const BOUNDED_CHART_SIZE_PATTERN =
	/(?:^|;)\s*(?:height|max-height|aspect-ratio)\s*:\s*(?!(?:auto|inherit|initial|unset|100%)\b)(?:clamp\(|min\(|max\(|\d+(?:\.\d+)?(?:px|rem|em|vh|vw)\b)/iu;
const BOUNDED_CHART_SIZE_VARIABLE_PATTERN =
	/(?:height|max-height|aspect-ratio)\s*:\s*var\(\s*(--[\w-]+)(?:\s*,[^)]*)?\s*\)/giu;
const POSITION_RELATIVE_PATTERN = /\bposition\s*:\s*relative\b/iu;
const FLEX_GROWING_WRAPPER_CLASS_PATTERN = /(?:^|\s)(?:card-body|h-100|flex-fill|flex-grow-1)(?:\s|$)/iu;
const SELECT_TAG_PATTERN = /<select\b([^>]*)>[\s\S]*?<\/select>/giu;
const GENERIC_SELECT_VALUE_HANDLER_PATTERN =
	/(?:(?:querySelectorAll)\(\s*(['"`])[^'"`]*\bselect\b[^'"`]*\1\s*\)|(?:getElementsByTagName)\(\s*(['"`])select\2\s*\))[\s\S]{0,2048}(?:\.value\b|target\s*\.\s*value\b)/u;
const GENERIC_SELECT_CHANGE_HANDLER_PATTERN =
	/(?:(?:querySelectorAll)\(\s*(['"`])[^'"`]*\bselect\b[^'"`]*\1\s*\)|(?:getElementsByTagName)\(\s*(['"`])select\2\s*\))[\s\S]{0,2048}\.addEventListener\s*\(\s*(['"`])change\3/u;
const DYNAMIC_SELECT_ID_HANDLER_PATTERN =
	/\bgetElementById\(\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,2048}\baddEventListener\(\s*(['"`])change\1[\s\S]{0,1024}(?:target\s*\.\s*value\b|\.value\b)/u;
const DYNAMIC_SELECT_CHANGE_HANDLER_PATTERN =
	/\bgetElementById\(\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,2048}\baddEventListener\(\s*(['"`])change\1/u;
const RANDOM_RENDERED_DATA_PATTERN = /\bdata\s*:\s*[\s\S]{0,512}\bMath\.random\s*\(/u;
const MOCK_DATA_RANDOM_PATTERN =
	/(?:\bfunction\s+((?=[A-Za-z_$][\w$]*(?:mock|demo|sample|fixture|seed))[A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|\b(?:const|let|var)\s+((?=[A-Za-z_$][\w$]*(?:mock|demo|sample|fixture|seed))[A-Za-z_$][\w$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{|\[))[\s\S]{0,8192}?\bMath\.random\s*\(/giu;
const OBJECT_DATA_METHOD_RANDOM_PATTERN =
	/\b((?:generate|create|build|make)(?:[A-Za-z_$][\w$]*)?(?:data|dataset|series|metrics?))\s*:\s*function\s*\([^)]*\)\s*\{[\s\S]{0,8192}?\bMath\.random\s*\(/giu;
const OBJECT_DATA_METHOD_SHORTHAND_PATTERN =
	/\b((?:generate|create|build|make)(?:[A-Za-z_$][\w$]*)?(?:data|dataset|series|metrics?))\s*\([^)]*\)\s*\{/giu;
const CHART_SEMANTIC_PATTERN =
	/(?:chart|trend|graph|plot|yield|fpy|defect|scrap|kpi|metric|analytics|series|histogram|scatter|visuali[sz]ation|\bviz\b|heatmap|treemap|choropleth|map|gauge|network|diagram|timeline|calendar|matrix)/iu;
const GAME_OR_DRAWING_CANVAS_PATTERN =
	/(?:game|arcade|hud|board|stage|sprite|paint|drawing|editor|simulator|游戏|街机|画板|棋盘|模拟器)/iu;
const CANVAS_DRAWING_CALL_PATTERN = /\.(?:moveTo|lineTo|fillText|strokeText|arc|bezierCurveTo|quadraticCurveTo)\s*\(/gu;
const RESPONSIVE_CANVAS_MEASUREMENT_PATTERN =
	/\.(?:clientWidth|clientHeight|offsetWidth|offsetHeight)\b|\.getBoundingClientRect\s*\(/u;
const CANVAS_RESIZE_OBSERVER_PATTERN = /\bResizeObserver\s*\(/u;
const CANVAS_CARD_SURFACE_CLASS_PATTERN = /(?:^|\s)(?:card|card-body)(?:\s|$)/iu;
const CANVAS_SURFACE_CHROME_CLASS_PATTERN =
	/(?:^|\s)(?:card-title|chart-title|panel-title|toolbar|actions|header)(?:\s|$)/iu;
const CANVAS_VIEWPORT_OVERLAY_CLASS_PATTERN =
	/(?:^|\s)(?:tooltip|chart-tooltip|overlay|crosshair|annotation|hover-label|empty-state|chart-empty|no-data)(?:\s|$)/iu;
const VOID_HTML_TAGS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const WINDOW_CHART_DESTROY_PATTERN = /\bwindow\.([A-Za-z_$][\w$]*)\.destroy\s*\(/gu;
const TEXT_CONTROL_TAGS = new Set(["button", "a", "input", "select", "textarea"]);
const MIN_BLOCKING_TEXT_CONTRAST = 1.5;
const MIN_RECOMMENDED_TEXT_CONTRAST = 4.5;

export function assessStaticPreviewQuality(input: StaticPreviewQualityGateInput): StaticPreviewQualityGateResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const checkedFiles: string[] = [];
	let guard: WorkspacePathGuard;
	let indexPath: string;
	try {
		guard = WorkspacePathGuard.forProjectContent(input.serveRoot);
		indexPath = guard.authorizeExisting(input.indexFile || "index.html", "file").absolutePath;
	} catch (error) {
		if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
		return {
			valid: false,
			errors: ["Static quality gate requires an authorized index.html inside the serve root."],
			warnings,
			checkedFiles,
		};
	}

	if (!existsSync(indexPath)) {
		return {
			valid: false,
			errors: [`Static quality gate requires index.html at ${indexPath}.`],
			warnings,
			checkedFiles,
		};
	}

	const html = readFileSync(indexPath, "utf8");
	checkedFiles.push(relativeCheckedPath(input.serveRoot, indexPath));
	const htmlIds = extractHtmlIds(html);
	const scripts = readLocalScripts(guard, html, errors);
	checkedFiles.push(...scripts.map((script) => script.src));
	checkedFiles.push(...authorizeLinkedResources(guard, html, errors));
	const stylesheets = readLocalStylesheets(guard, html);
	const referencedIds = collectReferencedIds(scripts, html);

	for (const [id, files] of referencedIds) {
		if (htmlIds.has(id)) continue;
		errors.push(`JavaScript selector #${id} in ${files.join(", ")} does not match any HTML id.`);
	}

	for (const loadingId of visibleLoadingIds(html)) {
		if (referencedIds.has(loadingId)) continue;
		errors.push(`Visible loading placeholder #${loadingId} is not controlled by local JavaScript.`);
	}

	for (const placeholderId of metricPlaceholderIds(html)) {
		if (referencedIds.has(placeholderId)) continue;
		errors.push(`Metric placeholder #${placeholderId} starts as "--" but local JavaScript never updates it.`);
	}

	const scriptSource = combinedScriptSource(html, scripts);
	const scriptSources = collectScriptSources(html, scripts);
	const selectValueErrors = unusedSelectValueErrors(html, scriptSources);
	const specificallyDiagnosedSelectIds = new Set(
		selectValueErrors.flatMap((error) => {
			const id = /\bSelect\s+#([^\s,.:]+)/u.exec(error)?.[1];
			return id ? [id] : [];
		}),
	);
	errors.push(
		...unwiredSelectErrors(html, scriptSource).filter((error) => {
			const id = /\bSelect control #([^\s,.:]+)/u.exec(error)?.[1];
			return !id || !specificallyDiagnosedSelectIds.has(id);
		}),
	);
	errors.push(...windowNamedElementChartErrors(htmlIds, scriptSource));
	errors.push(...selectValueErrors);
	errors.push(...filterStateKeyMismatchErrors(html, scriptSources));
	const nondeterministicEvidence = nondeterministicRenderedDataEvidence(
		scriptSources,
		/(?:dashboard|analytics|kpi|chart|trend|yield|pareto|data table|看板|分析|指标|图表|趋势|良率)/iu.test(
			`${html}\n${scriptSource}`,
		),
	);
	if (nondeterministicEvidence) {
		errors.push(
			`static.nondeterministic_data: Unseeded Math.random() feeds rendered chart or mock/demo application data.${nondeterministicEvidence.highConfidence ? " Context: dashboard-first-render." : ""} Evidence: ${nondeterministicEvidence.evidence}`,
		);
	}
	const nativeCanvasIssues = nativeCanvasChartIssues(html, scriptSources, stylesheets);
	errors.push(...nativeCanvasIssues.errors);
	warnings.push(...nativeCanvasIssues.warnings);
	const nativeSvgIssues = nativeSvgChartIssues(html, scriptSources, stylesheets);
	errors.push(...nativeSvgIssues.errors);
	warnings.push(...nativeSvgIssues.warnings);
	const chartJsIssues = chartLayoutIssues(html, scripts, stylesheets);
	errors.push(...chartJsIssues.errors);
	warnings.push(...chartJsIssues.warnings);
	const intrinsicWidthIssues = dashboardIntrinsicWidthIssues(html, scriptSources, stylesheets);
	errors.push(...intrinsicWidthIssues.errors);
	warnings.push(...intrinsicWidthIssues.warnings);
	const paginationWidthIssues = responsivePaginationWidthIssues(html, scriptSources, stylesheets);
	errors.push(...paginationWidthIssues.errors);
	warnings.push(...paginationWidthIssues.warnings);
	const contrast = controlTextContrastIssues(html, stylesheets);
	errors.push(...contrast.errors);
	warnings.push(...contrast.warnings);

	warnings.push(...externalResourceWarnings(html));

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		checkedFiles,
	};
}

function filterStateKeyMismatchErrors(html: string, sources: ScriptSource[]): string[] {
	const errors: string[] = [];
	for (const source of sources) {
		for (const derived of source.content.matchAll(
			/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\.split\(\s*(['"])-\3\s*\)\s*\[\s*0\s*\]/gu,
		)) {
			if (derived.index === undefined) continue;
			const keyVariable = derived[1];
			const idVariable = derived[2];
			if (!keyVariable || !idVariable) continue;
			const escapedKey = keyVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const assignment = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*\\[\\s*${escapedKey}\\s*\\]\\s*=`, "u").exec(
				source.content.slice(derived.index, derived.index + 768),
			);
			const stateVariable = assignment?.[1];
			if (!stateVariable) continue;
			const escapedState = stateVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const stateBody = new RegExp(
				`(?:const|let|var)\\s+${escapedState}\\s*=\\s*\\{([\\s\\S]{0,8192}?)\\}\\s*;`,
				"u",
			).exec(source.content)?.[1];
			if (!stateBody) continue;
			const stateKeys = new Set(
				[...stateBody.matchAll(/(?:^|[,\n])\s*([A-Za-z_$][\w$]*)\s*:/gu)].map((match) => match[1] ?? ""),
			);
			const escapedIdVariable = idVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const surrounding = source.content.slice(Math.max(0, derived.index - 4096), derived.index + 1024);
			if (!new RegExp(`\\.forEach\\(\\s*${escapedIdVariable}\\s*=>`, "u").test(surrounding)) continue;
			const controls = unique(
				[...source.content.matchAll(/(['"])([A-Za-z][\w-]*-[A-Za-z][\w-]*-filter)\1/gu)]
					.map((match) => match[2] ?? "")
					.filter((id) => selectIdExists(html, id)),
			);
			const affected = controls.flatMap((id) => {
				const parts = id.split("-").filter(Boolean);
				if (parts.at(-1)?.toLowerCase() !== "filter" || parts.length < 3) return [];
				const logicalParts = parts.slice(0, -1);
				const derivedKey = logicalParts[0] ?? "";
				const intendedKey = logicalParts
					.map((part, index) => (index === 0 ? part : `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`))
					.join("");
				return intendedKey && stateKeys.has(intendedKey) && !stateKeys.has(derivedKey)
					? [`#${id}=>${stateVariable}.${derivedKey} (expected ${stateVariable}.${intendedKey})`]
					: [];
			});
			if (affected.length === 0) continue;
			errors.push(
				`static.filter_state_key_mismatch: Shared select handler derives only the prefix before "-" and writes nonexistent state keys, so affected filters cannot update their declared render state. Controls: ${affected.join(", ")}. Evidence: ${evidenceAt(source, derived.index)}`,
			);
		}
	}
	return unique(errors);
}

function selectIdExists(html: string, id: string): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`<select\\b(?=[^>]*\\bid\\s*=\\s*(['"])${escaped}\\1)[^>]*>`, "iu").test(html);
}

function nativeSvgChartIssues(
	html: string,
	scriptSources: ScriptSource[],
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	const styleSource = combinedStyleSource(html, stylesheets);
	const svgElements = staticMarkupElements(html).filter(
		(element) =>
			element.tagName === "svg" &&
			element.id &&
			CHART_SEMANTIC_PATTERN.test(
				`${element.id} ${element.classNames.join(" ")} ${element.parent?.id ?? ""} ${element.parent?.classNames.join(" ") ?? ""}`,
			),
	);
	if (svgElements.length === 0) return { errors: [], warnings: [] };

	const errors: string[] = [];
	const warnings: string[] = [];
	for (const svg of svgElements) {
		if (!svg.parent) continue;
		const viewportHeight = explicitPixelHeight(elementDeclarations(svg.parent, styleSource));
		if (!viewportHeight || !svgFillsViewport(svg, styleSource) || svgHasViewBox(html, svg.id, scriptSources))
			continue;
		const mismatch = responsiveSvgLiteralHeightMismatch(svg.id, viewportHeight, scriptSources);
		if (!mismatch) continue;
		errors.push(
			`static.svg_coordinate_space_mismatch: Responsive chart SVG #${svg.id} fills a ${viewportHeight}px viewport but is drawn with a fixed ${mismatch.logicalHeight}px coordinate height without a matching viewBox or measured CSS height; marks can be clipped or stretched. Evidence: ${mismatch.evidence}`,
		);
	}
	return { errors, warnings };
}

function explicitPixelHeight(declarations: string): number | undefined {
	const values = [...declarations.matchAll(/(?:^|;)\s*height\s*:\s*(\d+(?:\.\d+)?)px\b/giu)];
	const value = Number(values.at(-1)?.[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function svgFillsViewport(svg: StaticMarkupElement, styleSource: string): boolean {
	const declarations = elementDeclarations(svg, styleSource);
	return (
		/(?:^|;)\s*width\s*:\s*100%(?:\s*!important)?(?:;|$)/iu.test(declarations) &&
		/(?:^|;)\s*height\s*:\s*100%(?:\s*!important)?(?:;|$)/iu.test(declarations)
	);
}

function svgHasViewBox(html: string, id: string, sources: ScriptSource[]): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const markup = new RegExp(`<svg\\b(?=[^>]*\\bid\\s*=\\s*(['"])${escaped}\\1)[^>]*>`, "iu").exec(html)?.[0] ?? "";
	if (/\bviewBox\s*=\s*(['"])[^'"]+\1/iu.test(markup)) return true;
	const scriptSource = sources.map((source) => source.content).join("\n");
	return new RegExp(
		`(?:getElementById\\(\\s*(['"])${escaped}\\1\\s*\\)|[A-Za-z_$][\\w$]*\\(\\s*(['"])${escaped}\\2\\s*\\))[\\s\\S]{0,512}?\\.setAttribute\\(\\s*(['"])viewBox\\3`,
		"u",
	).test(scriptSource);
}

function responsiveSvgLiteralHeightMismatch(
	id: string,
	viewportHeight: number,
	sources: ScriptSource[],
): { logicalHeight: number; evidence: string } | undefined {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const source of sources) {
		const measurementPattern = new RegExp(
			`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:document\\.getElementById\\(\\s*(['"])${escaped}\\2\\s*\\)|[A-Za-z_$][\\w$]*\\(\\s*(['"])${escaped}\\3\\s*\\))\\.getBoundingClientRect\\s*\\(\\s*\\)`,
			"gu",
		);
		for (const measurement of source.content.matchAll(measurementPattern)) {
			const variable = measurement[1];
			if (!variable || measurement.index === undefined) continue;
			const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const tail = source.content.slice(measurement.index, measurement.index + 2048);
			const literal = new RegExp(`\\b${escapedVariable}\\.width\\s*,\\s*(\\d+(?:\\.\\d+)?)\\b`, "u").exec(tail);
			const logicalHeight = Number(literal?.[1]);
			if (!literal || !Number.isFinite(logicalHeight) || Math.abs(logicalHeight - viewportHeight) < 2) continue;
			const evidenceIndex = measurement.index + (literal.index ?? 0);
			return { logicalHeight, evidence: evidenceAt(source, evidenceIndex) };
		}
	}
	return undefined;
}

function windowNamedElementChartErrors(htmlIds: Set<string>, scriptSource: string): string[] {
	const errors: string[] = [];
	for (const match of scriptSource.matchAll(WINDOW_CHART_DESTROY_PATTERN)) {
		const name = match[1] ?? "";
		if (!name || !htmlIds.has(name) || hasSafeChartDestroyGuard(scriptSource, name)) continue;
		errors.push(
			`Chart instance window.${name} collides with HTML id #${name}; the browser may expose the element on window before Chart initialization, so destroy() can fail. Use a differently named instance variable or guard destroy with instanceof Chart/typeof.`,
		);
	}
	return unique(errors);
}

function hasSafeChartDestroyGuard(source: string, name: string): boolean {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return (
		new RegExp(String.raw`window\.${escaped}\s+instanceof\s+Chart`, "u").test(source) ||
		new RegExp(String.raw`typeof\s+window\.${escaped}\.destroy\s*===?\s*['"]function['"]`, "u").test(source)
	);
}

function controlTextContrastIssues(
	html: string,
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	const styleSource = [
		...[...html.matchAll(STYLE_TAG_PATTERN)].map((match) => match[1] ?? ""),
		...stylesheets.map((stylesheet) => stylesheet.content),
	].join("\n");
	const rules = cssColorRules(styleSource);
	const errors: string[] = [];
	const warnings: string[] = [];
	for (const element of staticTextElements(html)) {
		const colors = resolvedElementColors(element, rules);
		if (!colors.foreground || !colors.background || colors.foreground.a < 1 || colors.background.a < 1) continue;
		const ratio = contrastRatio(colors.foreground, colors.background);
		const label = element.text || element.id || element.classNames.join(".") || element.tagName;
		const message = `Interactive control ${element.tagName}${element.id ? `#${element.id}` : ""} (${label}) has explicit foreground/background contrast ${ratio.toFixed(2)}:1.`;
		if (ratio < MIN_BLOCKING_TEXT_CONTRAST) {
			errors.push(`${message} Text is effectively unreadable; use contrasting colors.`);
		} else if (ratio < MIN_RECOMMENDED_TEXT_CONTRAST) {
			warnings.push(`${message} Aim for at least ${MIN_RECOMMENDED_TEXT_CONTRAST}:1 for normal text.`);
		}
	}
	return { errors, warnings };
}

function cssColorRules(source: string): Array<{
	selector: string;
	specificity: number;
	order: number;
	foregroundDeclared: boolean;
	backgroundDeclared: boolean;
	foreground?: CssColor;
	background?: CssColor;
}> {
	const rules: Array<{
		selector: string;
		specificity: number;
		order: number;
		foregroundDeclared: boolean;
		backgroundDeclared: boolean;
		foreground?: CssColor;
		background?: CssColor;
	}> = [];
	let order = 0;
	for (const match of source.matchAll(CSS_RULE_PATTERN)) {
		const declarations = match[2] ?? "";
		const foregroundDeclaration = lastColorDeclaration(declarations, ["color"]);
		const backgroundDeclaration = lastColorDeclaration(declarations, ["background", "background-color"]);
		if (!foregroundDeclaration && !backgroundDeclaration) continue;
		for (const selector of (match[1] ?? "").split(",").map((value) => value.trim())) {
			if (!selector || /[:>+~\s]/u.test(selector)) continue;
			rules.push({
				selector,
				specificity: selectorSpecificity(selector),
				order: order++,
				foregroundDeclared: foregroundDeclaration !== undefined,
				backgroundDeclared: backgroundDeclaration !== undefined,
				foreground: foregroundDeclaration?.color,
				background: backgroundDeclaration?.color,
			});
		}
	}
	return rules;
}

function staticTextElements(html: string): StaticTextElement[] {
	const elements: StaticTextElement[] = [];
	for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
		const tagName = (match[1] ?? "").toLowerCase();
		if (!TEXT_CONTROL_TAGS.has(tagName)) continue;
		const attrs = match[2] ?? "";
		const id = attributeValue(attrs, "id");
		const classNames = attributeValue(attrs, "class").split(/\s+/u).filter(Boolean);
		const style = attributeValue(attrs, "style");
		const contentStart = (match.index ?? 0) + match[0].length;
		const closeIndex = html.toLowerCase().indexOf(`</${tagName}>`, contentStart);
		const inner = closeIndex >= 0 ? html.slice(contentStart, closeIndex) : "";
		const text = stripTags(inner).replace(/\s+/gu, " ").trim() || attributeValueByName(attrs, "value");
		if (!text && tagName !== "input" && tagName !== "textarea" && tagName !== "select") continue;
		elements.push({ tagName, id, classNames, style, text });
	}
	return elements;
}

function resolvedElementColors(
	element: StaticTextElement,
	rules: ReturnType<typeof cssColorRules>,
): { foreground?: CssColor; background?: CssColor } {
	let foreground: { color?: CssColor; specificity: number; order: number } | undefined;
	let background: { color?: CssColor; specificity: number; order: number } | undefined;
	for (const rule of rules) {
		if (!simpleCssSelectorMatches(element, rule.selector)) continue;
		if (rule.foregroundDeclared && winsCascade(foreground, rule.specificity, rule.order)) {
			foreground = { color: rule.foreground, specificity: rule.specificity, order: rule.order };
		}
		if (rule.backgroundDeclared && winsCascade(background, rule.specificity, rule.order)) {
			background = { color: rule.background, specificity: rule.specificity, order: rule.order };
		}
	}
	const inlineForeground = lastColorDeclaration(element.style, ["color"]);
	const inlineBackground = lastColorDeclaration(element.style, ["background", "background-color"]);
	return {
		foreground: inlineForeground ? inlineForeground.color : foreground?.color,
		background: inlineBackground ? inlineBackground.color : background?.color,
	};
}

function winsCascade(
	current: { specificity: number; order: number } | undefined,
	specificity: number,
	order: number,
): boolean {
	return (
		!current || specificity > current.specificity || (specificity === current.specificity && order >= current.order)
	);
}

function simpleCssSelectorMatches(element: StaticTextElement, selector: string): boolean {
	const tag = selector.match(/^([a-z][\w-]*)/iu)?.[1]?.toLowerCase();
	if (tag && tag !== element.tagName) return false;
	const id = selector.match(/#([\w-]+)/u)?.[1];
	if (id && id !== element.id) return false;
	const classes = [...selector.matchAll(/\.([\w-]+)/gu)].map((match) => match[1] ?? "");
	return classes.every((className) => element.classNames.includes(className));
}

function selectorSpecificity(selector: string): number {
	const ids = [...selector.matchAll(/#[\w-]+/gu)].length;
	const classes = [...selector.matchAll(/\.[\w-]+|\[[^\]]+\]/gu)].length;
	const tags = /^[a-z][\w-]*/iu.test(selector) ? 1 : 0;
	return ids * 100 + classes * 10 + tags;
}

function lastColorDeclaration(
	declarations: string,
	properties: readonly ("color" | "background" | "background-color")[],
): { color?: CssColor; index: number } | undefined {
	let result: { color?: CssColor; index: number } | undefined;
	for (const property of properties) {
		for (const match of declarations.matchAll(
			new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)(?:!important)?`, "giu"),
		)) {
			const value = match[1]?.trim();
			const index = match.index ?? 0;
			if (!value || (result && result.index > index)) continue;
			const token = value.match(/(?:#[\da-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent)\b)/iu)?.[0];
			result = { index, ...(token ? { color: parseCssColor(token) } : {}) };
		}
	}
	return result;
}

function parseCssColor(value: string): CssColor | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "white") return { r: 255, g: 255, b: 255, a: 1 };
	if (normalized === "black") return { r: 0, g: 0, b: 0, a: 1 };
	if (normalized === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
	if (normalized.startsWith("#")) {
		const hex = normalized.slice(1);
		if (![3, 4, 6, 8].includes(hex.length)) return undefined;
		const expanded = hex.length <= 4 ? [...hex].map((char) => `${char}${char}`).join("") : hex;
		return {
			r: Number.parseInt(expanded.slice(0, 2), 16),
			g: Number.parseInt(expanded.slice(2, 4), 16),
			b: Number.parseInt(expanded.slice(4, 6), 16),
			a: expanded.length === 8 ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1,
		};
	}
	const rgb = normalized.match(
		/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/u,
	);
	if (!rgb) return undefined;
	return {
		r: Math.min(255, Number(rgb[1])),
		g: Math.min(255, Number(rgb[2])),
		b: Math.min(255, Number(rgb[3])),
		a: rgb[4] === undefined ? 1 : Math.min(1, Number(rgb[4])),
	};
}

function contrastRatio(foreground: CssColor, background: CssColor): number {
	const luminance = (color: CssColor): number => {
		const channels = [color.r, color.g, color.b].map((channel) => {
			const normalized = channel / 255;
			return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
	};
	const lighter = Math.max(luminance(foreground), luminance(background));
	const darker = Math.min(luminance(foreground), luminance(background));
	return (lighter + 0.05) / (darker + 0.05);
}

function attributeValueByName(attrs: string, name: string): string {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*(['"])(.*?)\\1`, "iu"))?.[2]?.trim() ?? "";
}

function readLocalStylesheets(guard: WorkspacePathGuard, html: string): LocalStylesheet[] {
	const stylesheets: LocalStylesheet[] = [];
	for (const match of html.matchAll(LINK_TAG_PATTERN)) {
		const attrs = match[1] ?? "";
		const href = staticHtmlAttributeValue(attrs, "href");
		const reference = classifyStaticResourceReference(href);
		if (!href || reference?.kind !== "local" || !reference.relativePath.toLowerCase().endsWith(".css")) continue;
		try {
			const authorized = guard.authorizeExisting(reference.relativePath, "file");
			stylesheets.push({ href, content: readFileSync(authorized.absolutePath, "utf8") });
		} catch {
			// authorizeLinkedResources reports the actionable path error.
		}
	}
	return stylesheets;
}

function nativeCanvasChartIssues(
	html: string,
	scriptSources: ScriptSource[],
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	const canvases = uniqueStaticCanvasElements([
		...staticCanvasElements(html),
		...scriptSources.flatMap((source) => staticCanvasElements(source.content)),
	]);
	if (canvases.length === 0) return { errors: [], warnings: [] };
	const scriptSource = scriptSources.map((source) => source.content).join("\n");
	const drawingCallCount = [...scriptSource.matchAll(CANVAS_DRAWING_CALL_PATTERN)].length;
	const scalings = canvasBitmapScalings(scriptSources);
	const responsiveMeasurement = firstSourceEvidence(scriptSources, RESPONSIVE_CANVAS_MEASUREMENT_PATTERN);
	const chartCanvases = canvases.filter((canvas) => {
		const hasAssociatedScaling = scalings.some((scaling) => scalingAppliesToCanvas(scaling, canvas, canvases.length));
		return isNativeChartCanvas(
			canvas,
			html,
			drawingCallCount,
			Boolean(responsiveMeasurement),
			hasAssociatedScaling,
			canvases.length,
		);
	});
	if (chartCanvases.length === 0) return { errors: [], warnings: [] };

	const styleSource = combinedStyleSource(html, stylesheets);
	const errors: string[] = [];
	const warnings: string[] = [];
	const canvasIds = chartCanvasLabels(chartCanvases);
	for (const scaling of scalings) {
		const associatedCanvases =
			scaling.canvasIds.length > 0
				? chartCanvases.filter((canvas) => scaling.canvasIds.includes(canvas.id))
				: chartCanvases.length === 1
					? chartCanvases
					: [];
		const canvasesMissingDisplaySize = associatedCanvases.filter(
			(canvas) => !hasExplicitCanvasDisplaySize(canvas, styleSource, scaling),
		);
		if (canvasesMissingDisplaySize.length > 0) {
			errors.push(
				`static.canvas_css_bitmap_mismatch: Chart bitmap dimensions are multiplied for DPR/a scale factor without explicit CSS display dimensions. Canvases: ${chartCanvasLabels(canvasesMissingDisplaySize)}. Evidence: ${sourceEvidence(scaling.path, scaling.line, scaling.excerpt)}`,
			);
			continue;
		}
		const aspectMismatchedCanvases = associatedCanvases.filter((canvas) =>
			hasResponsiveCanvasBitmapAspectMismatch(canvas, scaling, styleSource),
		);
		if (aspectMismatchedCanvases.length > 0) {
			errors.push(
				`static.canvas_css_bitmap_mismatch: Chart CSS display dimensions fill a non-square responsive viewport, but both bitmap dimensions use the same fixed logical size; this stretches rendered chart pixels. Canvases: ${chartCanvasLabels(aspectMismatchedCanvases)}. Evidence: ${sourceEvidence(scaling.path, scaling.line, scaling.excerpt)}`,
			);
		}
		if (associatedCanvases.length === 0) {
			const canvasesMissingDisplaySize = chartCanvases.filter(
				(canvas) => !hasExplicitCanvasDisplaySize(canvas, styleSource, scaling),
			);
			if (canvasesMissingDisplaySize.length > 0) {
				warnings.push(
					`Possible Canvas CSS/bitmap mismatch was not blocked because the scaled canvas variable could not be associated with one of several mixed chart canvases. Canvases needing review: ${chartCanvasLabels(canvasesMissingDisplaySize)}. Evidence: ${sourceEvidence(scaling.path, scaling.line, scaling.excerpt)}`,
				);
			}
		}
	}
	const unscaledResponsiveCanvases = chartCanvases.filter((canvas) => {
		if (scalings.some((scaling) => scalingAppliesToCanvas(scaling, canvas, canvases.length))) return false;
		const declarations = elementDeclarations(canvas, styleSource);
		return (
			cssDimensionIsFullSize(declarations, "width") &&
			cssDimensionIsFullSize(declarations, "height") &&
			Boolean(canvas.parent && isDedicatedBoundedCanvasViewport(canvas.parent, styleSource))
		);
	});
	if (unscaledResponsiveCanvases.length > 0) {
		const unassociatedScaling = scalings.find((scaling) => scaling.canvasIds.length === 0);
		if (unassociatedScaling) {
			warnings.push(
				`Responsive chart bitmap sizing could not be associated with specific canvases, so a CSS/bitmap mismatch was not blocked. Canvases needing browser review: ${chartCanvasLabels(unscaledResponsiveCanvases)}. Evidence: ${sourceEvidence(unassociatedScaling.path, unassociatedScaling.line, unassociatedScaling.excerpt)}`,
			);
		} else {
			const evidence =
				firstSourceEvidence(scriptSources, /\.canvas\.(?:width|height)\b/u) ??
				invalidViewportEvidence(unscaledResponsiveCanvases[0]);
			errors.push(
				`static.canvas_css_bitmap_mismatch: Responsive native chart CSS fills a bounded viewport, but bitmap dimensions are never synchronized to the measured CSS size and devicePixelRatio; the default bitmap will be stretched. Canvases: ${chartCanvasLabels(unscaledResponsiveCanvases)}. Evidence: ${evidence}`,
			);
		}
	}

	const invalidViewportCanvases = chartCanvases.filter(
		(canvas) => !canvas.parent || !isDedicatedBoundedCanvasViewport(canvas.parent, styleSource),
	);
	const uncertainViewportCanvases = invalidViewportCanvases.filter((canvas) =>
		couldBeBoundedByExternalStylesheet(canvas, html),
	);
	const blockingViewportCanvases = invalidViewportCanvases.filter(
		(canvas) => !uncertainViewportCanvases.includes(canvas),
	);
	if (blockingViewportCanvases.length > 0) {
		const evidence = invalidViewportEvidence(blockingViewportCanvases[0]);
		errors.push(
			`static.canvas_layout_unbounded: Chart canvases must be direct children of dedicated drawing viewports with an explicit height, max-height, or aspect-ratio; min-height alone does not prevent flex/grid stretching. Do not use cards containing titles, padding, or toolbars as the drawing viewport. Canvases: ${chartCanvasLabels(blockingViewportCanvases)}. Evidence: ${evidence}`,
		);
	}
	if (uncertainViewportCanvases.length > 0) {
		warnings.push(
			`Chart viewport bounds could not be verified because their sizing may come from an external stylesheet. Canvases needing browser review: ${chartCanvasLabels(uncertainViewportCanvases)}.`,
		);
	}

	if (responsiveMeasurement && !CANVAS_RESIZE_OBSERVER_PATTERN.test(maskJavaScriptCommentsAndStrings(scriptSource))) {
		errors.push(
			`static.canvas_resize_unhandled: Responsive chart canvases measure layout dimensions without observing their drawing viewports with ResizeObserver. A window resize listener alone misses container-only size changes. Canvases: ${canvasIds}. Evidence: ${responsiveMeasurement}`,
		);
	}
	return { errors, warnings };
}

function scalingAppliesToCanvas(
	scaling: CanvasBitmapScaling,
	canvas: StaticCanvasElement,
	canvasCount: number,
): boolean {
	return scaling.canvasIds.includes(canvas.id) || (scaling.canvasIds.length === 0 && canvasCount === 1);
}

function uniqueStaticCanvasElements(canvases: readonly StaticCanvasElement[]): StaticCanvasElement[] {
	const seen = new Set<string>();
	return canvases.filter((canvas, index) => {
		const parent = canvas.parent;
		const identity = canvas.id
			? `id:${canvas.id}`
			: `anonymous:${canvas.classNames.join(".")}:${parent?.id ?? ""}:${parent?.classNames.join(".") ?? ""}:${index}`;
		if (seen.has(identity)) return false;
		seen.add(identity);
		return true;
	});
}

function chartLayoutIssues(
	html: string,
	scripts: LocalScript[],
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	const scriptSource = combinedScriptSource(html, scripts);
	if (
		!CHART_CONSTRUCTOR_PATTERN.test(scriptSource) ||
		!DISABLED_CHART_ASPECT_RATIO_PATTERN.test(scriptSource) ||
		![...html.matchAll(CANVAS_TAG_PATTERN)].length
	) {
		return { errors: [], warnings: [] };
	}

	const styleSource = combinedStyleSource(html, stylesheets);
	const canvases = staticCanvasElements(html);
	const invalidCanvases = canvases.filter(
		(canvas) => !canvas.parent || !isDedicatedBoundedChartJsViewport(canvas.parent, styleSource),
	);
	if (invalidCanvases.length === 0) return { errors: [], warnings: [] };
	const uncertainCanvases = invalidCanvases.filter((canvas) => couldBeBoundedByExternalStylesheet(canvas, html));
	const blockingCanvases = invalidCanvases.filter((canvas) => !uncertainCanvases.includes(canvas));
	const canvasIds = chartCanvasLabels(blockingCanvases);
	const affected = canvasIds ? ` Affected canvases: ${canvasIds}.` : "";
	return {
		errors:
			blockingCanvases.length > 0
				? [
						`Chart.js uses maintainAspectRatio:false without a bounded chart or canvas height. Wrap each canvas in a dedicated position:relative chart container with an explicit responsive height or max-height to prevent runaway page growth.${affected}`,
					]
				: [],
		warnings:
			uncertainCanvases.length > 0
				? [
						`Chart.js viewport bounds could not be verified because their sizing may come from an external stylesheet. Canvases needing browser review: ${chartCanvasLabels(uncertainCanvases)}.`,
					]
				: [],
	};
}

function dashboardIntrinsicWidthIssues(
	html: string,
	scriptSources: ScriptSource[],
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	if (!/(?:dashboard|analytics|kpi|chart|trend|yield|pareto|看板|分析|指标|图表|趋势|良率)/iu.test(html)) {
		return { errors: [], warnings: [] };
	}
	const styleSource = combinedStyleSource(html, stylesheets);
	const elements = staticMarkupElements(html);
	const errors: string[] = [];
	const warnings: string[] = [];
	// Reuse this parse tree so Canvas ancestors and Grid elements share object identity.
	// A separately parsed Canvas tree cannot be matched to its containing Grid by reference.
	const chartCanvases = nativeChartCanvases(
		html,
		scriptSources,
		elements.filter((element) => element.tagName === "canvas") as StaticCanvasElement[],
	);
	for (const grid of elements) {
		const declarations = elementDeclarations(grid, styleSource);
		if (!/\bdisplay\s*:\s*grid\b/iu.test(declarations) || !hasExplicitMultiColumnGrid(declarations)) continue;
		const unsafeFractionalTracks = hasUncontainedFractionalGridTracks(declarations);
		if (unsafeFractionalTracks) {
			const affectedCanvases = chartCanvases.filter((canvas) => {
				const gridChild = directChildOfAncestor(canvas, grid);
				return (
					gridChild &&
					!gridItemCanShrink(gridChild, styleSource) &&
					Boolean(canvasParentWidthRemeasureEvidence(scriptSources, canvas))
				);
			});
			if (affectedCanvases.length > 0) {
				const measuredEvidence = canvasParentWidthRemeasureEvidence(scriptSources, affectedCanvases[0]);
				errors.push(
					`static.page_horizontal_overflow: Responsive chart canvases remeasure a Grid child into inline pixel widths after bitmap resizing while bare fractional tracks and automatic grid-item minimum widths can feed intrinsic width back into the page. Grid: ${markupElementLabel(grid)}. Canvases: ${chartCanvasLabels(affectedCanvases)}. Evidence: ${measuredEvidence ?? gridRuleEvidence(grid, html, stylesheets)}; ${gridRuleEvidence(grid, html, stylesheets)}`,
				);
			}
		}
		for (const child of grid.children) {
			const tables = descendants(child).filter((element) => element.tagName === "table");
			const wideTable = tables.find(
				(table) => descendants(table).filter((element) => element.tagName === "th").length >= 5,
			);
			if (!wideTable || containsIntrinsicWidth(child, wideTable, styleSource)) continue;
			const gridLabel = markupElementLabel(grid);
			const headerCount = descendants(wideTable).filter((element) => element.tagName === "th").length;
			if (couldContainIntrinsicWidthViaExternalStylesheet(html, child, wideTable)) {
				warnings.push(
					`Dashboard table containment could not be verified because its responsive wrapper may be styled by an external stylesheet. Grid needing browser review: ${gridLabel}.`,
				);
				continue;
			}
			if (!hasExplicitTableWidthPressure(wideTable, styleSource, headerCount)) {
				warnings.push(
					`A multi-column dashboard grid contains a ${headerCount}-column table without an explicit local overflow wrapper, but source does not prove intrinsic width pressure; browser review is recommended instead of blocking generation. Grid: ${gridLabel}.`,
				);
				continue;
			}
			errors.push(
				`static.page_horizontal_overflow: A multi-column dashboard grid contains a ${headerCount}-column table whose intrinsic width is not contained. Add min-width:0 to the table's direct grid item and wrap the table in a local overflow-x:auto region. Grid: ${gridLabel}. Evidence: ${gridRuleEvidence(grid, html, stylesheets)}`,
			);
			break;
		}
	}
	return { errors: unique(errors), warnings: unique(warnings) };
}

function nativeChartCanvases(
	html: string,
	scriptSources: ScriptSource[],
	markupCanvases: StaticCanvasElement[] = staticCanvasElements(html),
): StaticCanvasElement[] {
	const canvases = uniqueStaticCanvasElements([
		...markupCanvases,
		...scriptSources.flatMap((source) => staticCanvasElements(source.content)),
	]);
	if (canvases.length === 0) return [];
	const scriptSource = scriptSources.map((source) => source.content).join("\n");
	const drawingCallCount = [...scriptSource.matchAll(CANVAS_DRAWING_CALL_PATTERN)].length;
	const scalings = canvasBitmapScalings(scriptSources);
	const responsiveMeasurement = firstSourceEvidence(scriptSources, RESPONSIVE_CANVAS_MEASUREMENT_PATTERN);
	return canvases.filter((canvas) =>
		isNativeChartCanvas(
			canvas,
			html,
			drawingCallCount,
			Boolean(responsiveMeasurement),
			scalings.some((scaling) => scalingAppliesToCanvas(scaling, canvas, canvases.length)),
			canvases.length,
		),
	);
}

function hasUncontainedFractionalGridTracks(declarations: string): boolean {
	for (const match of declarations.matchAll(/\bgrid-template-columns\s*:\s*([^;]+)/giu)) {
		const value = (match[1] ?? "").trim();
		if (!hasExplicitMultiColumnGrid(`grid-template-columns:${value}`)) continue;
		const withoutZeroMinimumTracks = value.replace(
			/\bminmax\(\s*0(?:px|rem|em|%)?\s*,\s*[^)]*\b\d+(?:\.\d+)?fr\b[^)]*\)/giu,
			"",
		);
		if (/\b\d+(?:\.\d+)?fr\b/iu.test(withoutZeroMinimumTracks)) return true;
	}
	return false;
}

function directChildOfAncestor(
	element: StaticMarkupElement,
	ancestor: StaticMarkupElement,
): StaticMarkupElement | undefined {
	let current: StaticMarkupElement | undefined = element;
	while (current?.parent) {
		if (current.parent === ancestor) return current;
		current = current.parent;
	}
	return undefined;
}

function gridItemCanShrink(element: StaticMarkupElement, styleSource: string): boolean {
	const declarations = elementDeclarations(element, styleSource);
	return (
		/\bmin-width\s*:\s*0(?:px|rem|em|%)?\b/iu.test(declarations) ||
		/\boverflow(?:-x)?\s*:\s*(?:hidden|clip|auto|scroll)\b/iu.test(declarations)
	);
}

function canvasParentWidthRemeasureEvidence(sources: ScriptSource[], canvas: StaticCanvasElement): string | undefined {
	for (const source of sources) {
		const memberExpression = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*`;
		for (const displayWidth of source.content.matchAll(
			new RegExp(String.raw`\b(${memberExpression})\s*\.\s*style\s*\.\s*width\s*=\s*([^;\n]+)`, "gu"),
		)) {
			const assignmentIndex = displayWidth.index ?? 0;
			const canvasVariable = (displayWidth[1] ?? "").replace(/\s+/gu, "");
			const canvasId =
				canvasVariableId(source.content.slice(0, assignmentIndex), canvasVariable) ??
				canvasIdsPassedToScalingFunction(source.content, assignmentIndex, canvasVariable)[0];
			if (!canvasVariable || !canvas.id || canvasId !== canvas.id) continue;
			const expression = displayWidth[2] ?? "";
			if (!expressionRemeasuresCanvasParent(source.content, assignmentIndex, canvasVariable, expression)) continue;
			const range = enclosingJavaScriptFunctionRange(source.content, assignmentIndex);
			const scopeBefore = source.content.slice(range?.start ?? 0, assignmentIndex);
			const escapedCanvas = canvasVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (!new RegExp(`\\b${escapedCanvas}\\s*\\.\\s*width\\s*=`, "u").test(scopeBefore)) continue;
			return sourceEvidence(
				source.path,
				source.lineOffset + lineNumberAt(source.content, assignmentIndex),
				sourceLineAt(source.content, assignmentIndex),
			);
		}
	}
	return undefined;
}

function expressionRemeasuresCanvasParent(
	source: string,
	assignmentIndex: number,
	canvasVariable: string,
	expression: string,
): boolean {
	const normalizedExpression = expression.replace(/\s+/gu, "");
	const escapedCanvas = canvasVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (
		new RegExp(`\\b${escapedCanvas}\\.(?:parentElement|parentNode)\\.(?:clientWidth|offsetWidth)\\b`, "u").test(
			normalizedExpression,
		) ||
		new RegExp(
			`\\b${escapedCanvas}\\.(?:parentElement|parentNode)\\.getBoundingClientRect\\(\\)\\.width\\b`,
			"u",
		).test(normalizedExpression)
	) {
		return true;
	}
	const range = enclosingJavaScriptFunctionRange(source, assignmentIndex);
	const scopeBefore = source.slice(range?.start ?? 0, assignmentIndex);
	for (const alias of scopeBefore.matchAll(
		new RegExp(
			`\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedCanvas}\\.(?:parentElement|parentNode)\\b`,
			"gu",
		),
	)) {
		const name = alias[1];
		if (!name) continue;
		const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (
			new RegExp(`\\b${escapedName}\\.(?:clientWidth|offsetWidth)\\b`, "u").test(normalizedExpression) ||
			new RegExp(`\\b${escapedName}\\.getBoundingClientRect\\(\\)\\.width\\b`, "u").test(normalizedExpression)
		) {
			return true;
		}
	}
	return false;
}

function responsivePaginationWidthIssues(
	html: string,
	scriptSources: ScriptSource[],
	stylesheets: LocalStylesheet[],
): { errors: string[]; warnings: string[] } {
	const styleSource = combinedStyleSource(html, stylesheets);
	const paginationElements = staticMarkupElements(html).filter((element) =>
		/(?:pagination|paginator|pager|page[-_]?nav|分页)/iu.test(`${element.id} ${element.classNames.join(" ")}`),
	);
	const warnings: string[] = [];
	for (const pagination of paginationElements) {
		const declarations = elementDeclarations(pagination, styleSource);
		if (!/\bdisplay\s*:\s*(?:inline-)?flex\b/iu.test(declarations)) continue;
		if (
			/\bflex-wrap\s*:\s*wrap\b/iu.test(declarations) ||
			/\boverflow-x\s*:\s*(?:auto|scroll)\b/iu.test(declarations)
		) {
			continue;
		}
		const evidence = paginationAllPagesLoopEvidence(scriptSources, pagination);
		const staticButtons = descendants(pagination).filter((element) => element.tagName === "button").length;
		if (!evidence && staticButtons < 8) continue;
		warnings.push(
			`static.page_horizontal_overflow: Pagination renders every page control in one non-wrapping Flex row. Static source alone does not prove overflow at the 1440x900 desktop acceptance viewport, so this remains advisory and needs browser review. Target: ${markupElementLabel(pagination)}. Evidence: ${evidence ?? `index.html ${markupElementLabel(pagination)} contains ${staticButtons} buttons without flex-wrap.`}`,
		);
	}
	return { errors: [], warnings: unique(warnings) };
}

function paginationAllPagesLoopEvidence(sources: ScriptSource[], pagination: StaticMarkupElement): string | undefined {
	for (const source of sources) {
		const identityTokens = [pagination.id, ...pagination.classNames].filter(Boolean);
		if (identityTokens.length > 0 && !identityTokens.some((token) => source.content.includes(token))) continue;
		for (const loop of source.content.matchAll(
			/\bfor\s*\([^)]*(?:<=|<)\s*(?:totalPages|pageCount|numberOfPages|numPages)\b[^)]*\)\s*\{[\s\S]{0,3072}?\b(?:appendChild|append)\s*\(/giu,
		)) {
			return sourceEvidence(
				source.path,
				source.lineOffset + lineNumberAt(source.content, loop.index ?? 0),
				sourceLineAt(source.content, loop.index ?? 0),
			);
		}
	}
	return undefined;
}

function hasExplicitTableWidthPressure(table: StaticMarkupElement, styleSource: string, headerCount: number): boolean {
	const tableDeclarations = elementDeclarations(table, styleSource);
	if (
		/\b(?:min-)?width\s*:\s*(?:max-content|min-content|fit-content)\b/iu.test(tableDeclarations) ||
		/\bwhite-space\s*:\s*nowrap\b/iu.test(tableDeclarations)
	) {
		return true;
	}
	const tableMinWidth = numericPixelDeclaration(tableDeclarations, "min-width");
	if (tableMinWidth !== undefined && tableMinWidth >= 480) return true;
	const headers = descendants(table).filter((element) => element.tagName === "th");
	if (headers.some((header) => /\bwhite-space\s*:\s*nowrap\b/iu.test(elementDeclarations(header, styleSource)))) {
		return true;
	}
	const headerMinWidths = headers
		.map((header) => numericPixelDeclaration(elementDeclarations(header, styleSource), "min-width"))
		.filter((value): value is number => value !== undefined);
	return headerMinWidths.length > 0 && Math.max(...headerMinWidths) * headerCount >= 480;
}

function numericPixelDeclaration(declarations: string, property: string): number | undefined {
	const value = new RegExp(`\\b${property}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`, "iu").exec(declarations)?.[1];
	if (!value) return undefined;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function couldContainIntrinsicWidthViaExternalStylesheet(
	html: string,
	gridChild: StaticMarkupElement,
	table: StaticMarkupElement,
): boolean {
	if (!hasExternalStylesheet(html)) return false;
	let current: StaticMarkupElement | undefined = table.parent;
	while (current) {
		if (
			current.classNames.some((className) =>
				/(?:^|[-_])(?:table[-_]?)?(?:responsive|scroll|overflow)(?:$|[-_])/iu.test(className),
			)
		) {
			return true;
		}
		if (current === gridChild) break;
		current = current.parent;
	}
	return false;
}

function hasExplicitMultiColumnGrid(declarations: string): boolean {
	for (const match of declarations.matchAll(/\bgrid-template-columns\s*:\s*([^;]+)/giu)) {
		const value = (match[1] ?? "").trim();
		const repeatCount = Number.parseInt(/\brepeat\(\s*(\d+)\s*,/iu.exec(value)?.[1] ?? "0", 10);
		if (repeatCount >= 2) return true;
		if (/\brepeat\(\s*(?:auto-fit|auto-fill)\s*,/iu.test(value)) continue;
		const columns = value
			.replace(/\([^()]*(?:\([^()]*\)[^()]*)*\)/gu, "")
			.trim()
			.split(/\s+/u)
			.filter(Boolean);
		if (columns.length >= 2) return true;
	}
	return false;
}

function containsIntrinsicWidth(
	gridChild: StaticMarkupElement,
	table: StaticMarkupElement,
	styleSource: string,
): boolean {
	if (/\bmin-width\s*:\s*0(?:px|rem|em|%)?\b/iu.test(elementDeclarations(gridChild, styleSource))) return true;
	let current: StaticMarkupElement | undefined = table.parent;
	while (current) {
		const declarations = elementDeclarations(current, styleSource);
		if (/\boverflow-x\s*:\s*(?:auto|scroll)\b|\boverflow\s*:\s*(?:auto|scroll)\b/iu.test(declarations)) {
			return true;
		}
		if (current === gridChild) break;
		current = current.parent;
	}
	return false;
}

function descendants(element: StaticMarkupElement): StaticMarkupElement[] {
	return element.children.flatMap((child) => [child, ...descendants(child)]);
}

function markupElementLabel(element: StaticMarkupElement): string {
	return [element.tagName, element.id ? `#${element.id}` : "", ...element.classNames.map((name) => `.${name}`)]
		.filter(Boolean)
		.join("");
}

function gridRuleEvidence(grid: StaticMarkupElement, html: string, stylesheets: LocalStylesheet[]): string {
	for (const source of [
		{ path: "index.html", content: html },
		...stylesheets.map(({ href, content }) => ({ path: href, content })),
	]) {
		for (const match of source.content.matchAll(CSS_RULE_PATTERN)) {
			if (!/\bgrid-template-columns\s*:/iu.test(match[2] ?? "")) continue;
			if (!(match[1] ?? "").split(",").some((selector) => cssSelectorMatchesElement(selector, grid))) continue;
			return sourceEvidence(
				source.path,
				lineNumberAt(source.content, match.index ?? 0),
				(match[0] ?? "").replace(/\s+/gu, " "),
			);
		}
	}
	return `index.html ${markupElementLabel(grid)} uses an explicit multi-column grid.`;
}

function couldBeBoundedByExternalStylesheet(canvas: StaticCanvasElement, html: string): boolean {
	if (!hasExternalStylesheet(html) || !canvas.parent) return false;
	const parent = canvas.parent;
	if (CANVAS_CARD_SURFACE_CLASS_PATTERN.test(parent.classNames.join(" "))) return false;
	if (parent.children.length === 0 || parent.children.some((child) => !isCanvasOrViewportOverlay(child))) return false;
	return CHART_SEMANTIC_PATTERN.test(
		`${canvas.id} ${canvas.classNames.join(" ")} ${parent.id} ${parent.classNames.join(" ")}`,
	);
}

function hasExternalStylesheet(html: string): boolean {
	for (const match of html.matchAll(LINK_TAG_PATTERN)) {
		const attrs = match[1] ?? "";
		const rel = attributeValueByName(attrs, "rel").toLowerCase();
		const reference = classifyStaticResourceReference(staticHtmlAttributeValue(attrs, "href"));
		if ((!rel || rel.includes("stylesheet")) && reference?.kind === "external") return true;
	}
	return false;
}

function isNativeChartCanvas(
	canvas: StaticCanvasElement,
	html: string,
	drawingCallCount: number,
	hasResponsiveMeasurement: boolean,
	hasBitmapScaling: boolean,
	canvasCount: number,
): boolean {
	const semanticContext = [
		canvas.id,
		canvas.classNames.join(" "),
		canvas.parent?.id ?? "",
		canvas.parent?.classNames.join(" ") ?? "",
		canvas.parent?.children.map((child) => `${child.id} ${child.classNames.join(" ")}`).join(" ") ?? "",
		canvasMarkupNeighborhood(html, canvas.id),
	].join(" ");
	const semantic = CHART_SEMANTIC_PATTERN.test(semanticContext);
	const drawing = drawingCallCount >= 2;
	const fixedNumericSize = canvasHasFixedNumericSize(html, canvas.id);
	// A fixed-size game/HUD canvas can have a chart-like id such as metricGraph.
	// Exclude it even if the game uses DPR for sharp pixels. On mixed-canvas pages,
	// do not borrow responsive/DPR evidence from a sibling.
	// A real responsive chart normally omits intrinsic dimensions or has its own
	// associated bitmap scaling; ambiguous fixed canvases remain fail-open.
	if (fixedNumericSize && GAME_OR_DRAWING_CANVAS_PATTERN.test(semanticContext)) return false;
	if (canvasCount > 1 && fixedNumericSize && !hasBitmapScaling) return false;
	return (
		(semantic && (drawing || hasResponsiveMeasurement || hasBitmapScaling)) ||
		(canvasCount === 1 && hasResponsiveMeasurement && drawing && hasBitmapScaling)
	);
}

function canvasHasFixedNumericSize(html: string, id: string): boolean {
	if (!id) return false;
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const tag = new RegExp(`<canvas\\b(?=[^>]*\\bid\\s*=\\s*(?:"${escaped}"|'${escaped}'))[^>]*>`, "iu").exec(html)?.[0];
	if (!tag) return false;
	return /\bwidth\s*=\s*(['"])\d+(?:\.\d+)?\1/iu.test(tag) && /\bheight\s*=\s*(['"])\d+(?:\.\d+)?\1/iu.test(tag);
}

function canvasMarkupNeighborhood(html: string, id: string): string {
	if (!id) return "";
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = new RegExp(`<canvas\\b[^>]*\\bid\\s*=\\s*(['"])${escaped}\\1[^>]*>`, "iu").exec(html);
	if (!match || match.index === undefined) return "";
	return html.slice(Math.max(0, match.index - 512), Math.min(html.length, match.index + match[0].length + 128));
}

function canvasBitmapScalings(sources: ScriptSource[]): CanvasBitmapScaling[] {
	const scalings: CanvasBitmapScaling[] = [];
	for (const source of sources) {
		const memberExpression = String.raw`[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*`;
		const widthAssignments = [
			...source.content.matchAll(new RegExp(String.raw`\b(${memberExpression})\s*\.\s*width\s*=\s*([^;\n]+)`, "gu")),
		];
		const heightAssignments = [
			...source.content.matchAll(
				new RegExp(String.raw`\b(${memberExpression})\s*\.\s*height\s*=\s*([^;\n]+)`, "gu"),
			),
		];
		for (const width of widthAssignments) {
			const canvasVariable = (width[1] ?? "").replace(/\s+/gu, "");
			const widthExpression = width[2] ?? "";
			const height = heightAssignments
				.filter(
					(candidate) =>
						(candidate[1] ?? "").replace(/\s+/gu, "") === canvasVariable &&
						isScaledBitmapExpression(candidate[2] ?? "") &&
						Math.abs((candidate.index ?? 0) - (width.index ?? 0)) <= 4096,
				)
				.sort(
					(left, right) =>
						Math.abs((left.index ?? 0) - (width.index ?? 0)) - Math.abs((right.index ?? 0) - (width.index ?? 0)),
				)[0];
			if (!canvasVariable || !height || !isScaledBitmapExpression(widthExpression)) continue;
			const index = width.index ?? 0;
			const canvasId = canvasVariableId(source.content.slice(0, index), canvasVariable);
			scalings.push({
				canvasVariable,
				canvasIds: canvasId ? [canvasId] : canvasIdsPassedToScalingFunction(source.content, index, canvasVariable),
				hasScopedDisplaySize: canvasHasScopedDisplaySize(source.content, index, canvasVariable),
				widthExpression,
				heightExpression: height[2] ?? "",
				path: source.path,
				line: source.lineOffset + lineNumberAt(source.content, index),
				excerpt: sourceLineAt(source.content, index),
			});
		}
	}
	return scalings;
}

function canvasHasScopedDisplaySize(source: string, assignmentIndex: number, canvasVariable: string): boolean {
	const escapedVariable = canvasVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const range = enclosingJavaScriptFunctionRange(source, assignmentIndex);
	const scopedSource = range ? source.slice(range.start, range.end) : source;
	return (
		new RegExp(`\\b${escapedVariable}\\.style\\.width\\s*=`, "u").test(scopedSource) &&
		new RegExp(`\\b${escapedVariable}\\.style\\.height\\s*=`, "u").test(scopedSource)
	);
}

function enclosingJavaScriptFunctionRange(source: string, index: number): { start: number; end: number } | undefined {
	const declarations = [
		...source.matchAll(/\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gu),
		...source.matchAll(
			/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu,
		),
		...source.matchAll(/(?:^|[,;\n]\s*)(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/gu),
	];
	let best: { start: number; end: number } | undefined;
	for (const declaration of declarations) {
		const start = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
		const end = matchingJavaScriptBrace(source, start);
		if (start < 0 || end < index || start >= index) continue;
		if (!best || end - start < best.end - best.start) best = { start, end };
	}
	return best;
}

function canvasIdsPassedToScalingFunction(source: string, assignmentIndex: number, canvasVariable: string): string[] {
	const scope = enclosingCanvasFunction(source, assignmentIndex, canvasVariable);
	if (!scope) return [];
	const ids: string[] = [];
	const escapedName = scope.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const call of source.matchAll(new RegExp(`\\b${escapedName}\\s*\\(`, "gu"))) {
		const openParenthesis = (call.index ?? 0) + call[0].lastIndexOf("(");
		if (openParenthesis === scope.openParenthesis) continue;
		const closeParenthesis = matchingJavaScriptDelimiter(source, openParenthesis, "(", ")");
		if (closeParenthesis < 0) continue;
		const argument = source
			.slice(openParenthesis + 1, closeParenthesis)
			.split(/\s*,\s*/u)
			[scope.parameterIndex]?.trim();
		if (!argument) continue;
		const directId = /^(?:document\s*\.\s*)?getElementById\(\s*(['"])([^'"]+)\1\s*\)$/u.exec(argument)?.[2];
		if (directId) {
			ids.push(directId);
			continue;
		}
		if (!/^[A-Za-z_$][\w$]*$/u.test(argument)) continue;
		const boundId = canvasVariableId(source, argument);
		if (boundId) ids.push(boundId);
	}
	return unique(ids);
}

function enclosingCanvasFunction(
	source: string,
	assignmentIndex: number,
	canvasVariable: string,
): { name: string; parameterIndex: number; openParenthesis: number } | undefined {
	for (const declaration of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu)) {
		const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (assignmentIndex <= openBrace || closeBrace < assignmentIndex) continue;
		const parameters = (declaration[2] ?? "").split(/\s*,\s*/u).map((parameter) => parameter.trim());
		const parameterIndex = parameters.indexOf(canvasVariable);
		const name = declaration[1];
		if (!name || parameterIndex < 0) continue;
		return {
			name,
			parameterIndex,
			openParenthesis: (declaration.index ?? 0) + declaration[0].indexOf("("),
		};
	}
	return undefined;
}

function hasResponsiveCanvasBitmapAspectMismatch(
	canvas: StaticCanvasElement,
	scaling: CanvasBitmapScaling,
	styleSource: string,
): boolean {
	const width = fixedScaledLogicalDimension(scaling.widthExpression);
	const height = fixedScaledLogicalDimension(scaling.heightExpression);
	if (width === undefined || height === undefined || width !== height) return false;
	const canvasDeclarations = elementDeclarations(canvas, styleSource);
	if (!cssDimensionIsFullSize(canvasDeclarations, "width") || !cssDimensionIsFullSize(canvasDeclarations, "height")) {
		return false;
	}
	if (!canvas.parent) return false;
	return !hasExplicitSquareViewport(elementDeclarations(canvas.parent, styleSource));
}

function fixedScaledLogicalDimension(expression: string): number | undefined {
	const normalized = expression.replace(/\s+/gu, " ").trim();
	const patterns = [
		/^(?:Math\.(?:round|floor|ceil)\(\s*)?(\d+(?:\.\d+)?)\s*\*\s*(?:window\.)?(?:devicePixelRatio|dpr|pixelRatio|backingStoreRatio)\s*\)?$/iu,
		/^(?:Math\.(?:round|floor|ceil)\(\s*)?(?:window\.)?(?:devicePixelRatio|dpr|pixelRatio|backingStoreRatio)\s*\*\s*(\d+(?:\.\d+)?)\s*\)?$/iu,
	];
	for (const pattern of patterns) {
		const value = Number(pattern.exec(normalized)?.[1]);
		if (Number.isFinite(value) && value > 0) return value;
	}
	return undefined;
}

function cssDimensionIsFullSize(declarations: string, property: "width" | "height"): boolean {
	return new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*100%\\s*(?:!important\\s*)?(?:;|$)`, "iu").test(declarations);
}

function hasExplicitSquareViewport(declarations: string): boolean {
	if (/(?:^|;)\s*aspect-ratio\s*:\s*1(?:\s*\/\s*1)?\s*(?:;|$)/iu.test(declarations)) return true;
	const width = /(?:^|;)\s*width\s*:\s*([^;]+)/iu.exec(declarations)?.[1]?.trim();
	const height = /(?:^|;)\s*height\s*:\s*([^;]+)/iu.exec(declarations)?.[1]?.trim();
	return Boolean(width && height && width === height && !/^100%$/u.test(width));
}

function canvasVariableId(sourceBeforeAssignment: string, canvasVariable: string): string | undefined {
	const escapedVariable = canvasVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const bindings: RegExpMatchArray[] = [
		...sourceBeforeAssignment.matchAll(
			new RegExp(
				String.raw`\b(?:const|let|var)\s+${escapedVariable}\s*=\s*document\.getElementById\(\s*(['"])([^'"]+)\1\s*\)`,
				"gu",
			),
		),
		...sourceBeforeAssignment.matchAll(
			new RegExp(
				String.raw`\b(?:const|let|var)\s+${escapedVariable}\s*=\s*document\.querySelector\(\s*(['"])#([^'"]+)\1\s*\)`,
				"gu",
			),
		),
		...sourceBeforeAssignment.matchAll(
			new RegExp(String.raw`\b${escapedVariable}\s*=\s*document\.getElementById\(\s*(['"])([^'"]+)\1\s*\)`, "gu"),
		),
		...sourceBeforeAssignment.matchAll(
			new RegExp(String.raw`\b${escapedVariable}\s*=\s*document\.querySelector\(\s*(['"])#([^'"]+)\1\s*\)`, "gu"),
		),
	];
	const member = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/u.exec(canvasVariable);
	if (member) {
		const root = member[1]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
		const property = member[2]?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") ?? "";
		bindings.push(
			...sourceBeforeAssignment.matchAll(
				new RegExp(
					String.raw`\b(?:const|let|var)\s+${root}\s*=\s*\{[\s\S]{0,16384}?\b${property}\s*:\s*document\.getElementById\(\s*(['"])([^'"]+)\1\s*\)`,
					"gu",
				),
			),
			...sourceBeforeAssignment.matchAll(
				new RegExp(
					String.raw`\b(?:const|let|var)\s+${root}\s*=\s*\{[\s\S]{0,16384}?\b${property}\s*:\s*document\.querySelector\(\s*(['"])#([^'"]+)\1\s*\)`,
					"gu",
				),
			),
		);
	}
	bindings.sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	return bindings.at(-1)?.[2];
}

function isScaledBitmapExpression(expression: string): boolean {
	return (
		/\b(?:devicePixelRatio|dpr|pixelRatio|backingStoreRatio)\b/iu.test(expression) ||
		/(?:\*\s*(?:[2-9]|\d{2,})(?:\.\d+)?\b|\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*\*)/u.test(expression)
	);
}

function hasExplicitCanvasDisplaySize(
	canvas: StaticCanvasElement,
	styleSource: string,
	scaling: CanvasBitmapScaling,
): boolean {
	return scaling.hasScopedDisplaySize || hasCssDisplayDimensions(elementDeclarations(canvas, styleSource));
}

function hasCssDisplayDimensions(declarations: string): boolean {
	return (
		/(?:^|;)\s*width\s*:\s*(?!(?:auto|initial|inherit|unset)\b)[^;]+/iu.test(declarations) &&
		/(?:^|;)\s*height\s*:\s*(?!(?:auto|initial|inherit|unset)\b)[^;]+/iu.test(declarations)
	);
}

function isDedicatedBoundedCanvasViewport(parent: StaticMarkupElement, styleSource: string): boolean {
	if (CANVAS_CARD_SURFACE_CLASS_PATTERN.test(parent.classNames.join(" "))) return false;
	if (parent.children.some((child) => !isCanvasOrViewportOverlay(child))) return false;
	return hasBoundedChartSize(elementDeclarations(parent, styleSource), styleSource);
}

function isDedicatedBoundedChartJsViewport(parent: StaticMarkupElement, styleSource: string): boolean {
	const className = parent.classNames.join(" ");
	if (CANVAS_CARD_SURFACE_CLASS_PATTERN.test(className) || FLEX_GROWING_WRAPPER_CLASS_PATTERN.test(className)) {
		return false;
	}
	if (parent.children.some((child) => !isCanvasOrViewportOverlay(child))) return false;
	const declarations = elementDeclarations(parent, styleSource);
	const containsCanvasOnly =
		parent.children.length > 0 && parent.children.every((child) => child.tagName === "canvas");
	const semanticContainer =
		DEDICATED_CHART_CONTAINER_SELECTOR_PATTERN.test(`${parent.id} ${className}`) ||
		(containsCanvasOnly && (CHART_SEMANTIC_PATTERN.test(`${parent.id} ${className}`) || Boolean(parent.style)));
	return (
		semanticContainer &&
		POSITION_RELATIVE_PATTERN.test(declarations) &&
		hasBoundedChartSize(declarations, styleSource)
	);
}

function isCanvasOrViewportOverlay(child: StaticMarkupElement): boolean {
	if (child.tagName === "canvas") {
		return !CANVAS_SURFACE_CHROME_CLASS_PATTERN.test(child.classNames.join(" "));
	}
	return CANVAS_VIEWPORT_OVERLAY_CLASS_PATTERN.test(child.classNames.join(" "));
}

function hasBoundedChartSize(declarations: string, styleSource: string): boolean {
	if (BOUNDED_CHART_SIZE_PATTERN.test(declarations)) return true;
	for (const match of declarations.matchAll(BOUNDED_CHART_SIZE_VARIABLE_PATTERN)) {
		const variableName = match[1];
		if (!variableName) continue;
		const escapedVariableName = variableName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const definition = new RegExp(`${escapedVariableName}\\s*:\\s*([^;}]+)`, "iu").exec(styleSource)?.[1];
		if (definition && BOUNDED_CHART_SIZE_PATTERN.test(`height:${definition}`)) return true;
	}
	return false;
}

function elementDeclarations(element: StaticMarkupElement, styleSource: string): string {
	const declarations: string[] = [];
	for (const match of styleSource.matchAll(CSS_RULE_PATTERN)) {
		for (const selector of (match[1] ?? "").split(",")) {
			if (cssSelectorMatchesElement(selector, element)) declarations.push(match[2] ?? "");
		}
	}
	if (element.style) declarations.push(element.style);
	return declarations.join(";");
}

function cssSelectorMatchesElement(selector: string, element: StaticMarkupElement): boolean {
	const simple = selector
		.trim()
		.split(/[>+~\s]+/u)
		.filter(Boolean)
		.at(-1)
		?.replace(/:{1,2}[\w-]+(?:\([^)]*\))?/gu, "");
	if (!simple || simple === "*") return simple === "*";
	const tag = simple.match(/^([a-z][\w-]*)/iu)?.[1]?.toLowerCase();
	if (tag && tag !== element.tagName) return false;
	const id = simple.match(/#([\w-]+)/u)?.[1];
	if (id && id !== element.id) return false;
	const classes = [...simple.matchAll(/\.([\w-]+)/gu)].map((match) => match[1] ?? "");
	if (!classes.every((className) => element.classNames.includes(className))) return false;
	return Boolean(tag || id || classes.length > 0);
}

function invalidViewportEvidence(canvas: StaticCanvasElement | undefined): string {
	if (!canvas) return "index.html contains a chart canvas without a measurable viewport.";
	const parent = canvas.parent;
	if (!parent) return `index.html canvas ${chartCanvasLabel(canvas)} has no parent viewport.`;
	const parentLabel = [
		parent.tagName,
		parent.id ? `#${parent.id}` : "",
		...parent.classNames.map((name) => `.${name}`),
	]
		.filter(Boolean)
		.join("");
	const chrome = parent.children
		.filter((child) => child !== canvas)
		.map((child) => [child.tagName, child.id ? `#${child.id}` : "", ...child.classNames.map((name) => `.${name}`)])
		.map((parts) => parts.filter(Boolean).join(""))
		.slice(0, 4)
		.join(", ");
	return `index.html ${chartCanvasLabel(canvas)} is a direct child of ${parentLabel}${chrome ? ` alongside ${chrome}` : ""}.`;
}

function chartCanvasLabels(canvases: readonly StaticCanvasElement[]): string {
	return canvases.map(chartCanvasLabel).join(", ");
}

function chartCanvasLabel(canvas: StaticCanvasElement): string {
	return canvas.id
		? `#${canvas.id}`
		: canvas.classNames.length > 0
			? `canvas.${canvas.classNames.join(".")}`
			: "canvas";
}

function staticCanvasElements(html: string): StaticCanvasElement[] {
	return staticMarkupElements(html).filter((element) => element.tagName === "canvas") as StaticCanvasElement[];
}

function staticMarkupElements(html: string): StaticMarkupElement[] {
	const masked = maskHtmlBlocks(html, [SCRIPT_BLOCK_PATTERN, STYLE_TAG_PATTERN]);
	const tagPattern = /<\/?([a-z][\w:-]*)\b([^>]*)>/giu;
	const stack: StaticMarkupElement[] = [];
	const elements: StaticMarkupElement[] = [];
	for (const match of masked.matchAll(tagPattern)) {
		const token = match[0];
		const tagName = (match[1] ?? "").toLowerCase();
		if (token.startsWith("</")) {
			for (let index = stack.length - 1; index >= 0; index -= 1) {
				if (stack[index]?.tagName !== tagName) continue;
				stack.length = index;
				break;
			}
			continue;
		}
		const attrs = match[2] ?? "";
		const parent = stack.at(-1);
		const element: StaticMarkupElement = {
			tagName,
			id: attributeValueByName(attrs, "id"),
			classNames: attributeValueByName(attrs, "class").split(/\s+/u).filter(Boolean),
			style: attributeValueByName(attrs, "style"),
			children: [],
			...(parent ? { parent } : {}),
		};
		parent?.children.push(element);
		elements.push(element);
		if (!VOID_HTML_TAGS.has(tagName) && !token.endsWith("/>")) stack.push(element);
	}
	return elements;
}

function maskHtmlBlocks(html: string, patterns: RegExp[]): string {
	let masked = html;
	for (const pattern of patterns) masked = masked.replace(pattern, (match) => " ".repeat(match.length));
	return masked;
}

function combinedStyleSource(html: string, stylesheets: LocalStylesheet[]): string {
	return [
		...[...html.matchAll(STYLE_TAG_PATTERN)].map((match) => match[1] ?? ""),
		...stylesheets.map((stylesheet) => stylesheet.content),
	].join("\n");
}

function collectScriptSources(html: string, scripts: LocalScript[]): ScriptSource[] {
	const sources: ScriptSource[] = scripts.map((script) => ({
		path: script.src,
		content: script.content,
		lineOffset: 0,
	}));
	for (const match of html.matchAll(SCRIPT_BLOCK_PATTERN)) {
		if (staticHtmlAttributeValue(match[1] ?? "", "src")) continue;
		const content = match[2] ?? "";
		const contentIndex = (match.index ?? 0) + match[0].indexOf(content);
		sources.push({ path: "index.html", content, lineOffset: lineNumberAt(html, contentIndex) - 1 });
	}
	return sources;
}

function nondeterministicRenderedDataEvidence(
	sources: ScriptSource[],
	dataDrivenPage: boolean,
): { evidence: string; highConfidence: boolean } | undefined {
	for (const source of sources) {
		const executableSource = maskJavaScriptCommentsAndStrings(source.content);
		const renderedMatch = RANDOM_RENDERED_DATA_PATTERN.exec(executableSource);
		if (renderedMatch?.index !== undefined) {
			return {
				evidence: evidenceAt(source, renderedMatch.index + renderedMatch[0].lastIndexOf("Math.random")),
				highConfidence: true,
			};
		}
		for (const match of executableSource.matchAll(MOCK_DATA_RANDOM_PATTERN)) {
			const name = match[1] ?? match[2] ?? "";
			const randomOffset = match[0].lastIndexOf("Math.random");
			const minimumOccurrences = match[1] ? 2 : 1;
			if (!name || randomOffset < 0 || invocationCount(executableSource, name) < minimumOccurrences) continue;
			return {
				evidence: evidenceAt(source, (match.index ?? 0) + randomOffset),
				highConfidence: dataDrivenPage,
			};
		}
		if (!dataDrivenPage) continue;
		for (const match of executableSource.matchAll(OBJECT_DATA_METHOD_RANDOM_PATTERN)) {
			const name = match[1] ?? "";
			const randomOffset = match[0].lastIndexOf("Math.random");
			if (!name || randomOffset < 0 || invocationCount(executableSource, name) < 1) continue;
			return {
				evidence: evidenceAt(source, (match.index ?? 0) + randomOffset),
				highConfidence: true,
			};
		}
		for (const declaration of executableSource.matchAll(OBJECT_DATA_METHOD_SHORTHAND_PATTERN)) {
			const name = declaration[1] ?? "";
			const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(executableSource, openBrace);
			if (!name || closeBrace < 0 || invocationCount(executableSource, name) < 2) continue;
			const body = executableSource.slice(openBrace + 1, closeBrace);
			const randomOffset = body.indexOf("Math.random");
			if (randomOffset < 0) continue;
			return {
				evidence: evidenceAt(source, openBrace + 1 + randomOffset),
				highConfidence: true,
			};
		}
		const transitiveObjectRandom = transitiveObjectRandomDataIndex(executableSource);
		if (transitiveObjectRandom !== undefined) {
			return {
				evidence: evidenceAt(source, transitiveObjectRandom),
				highConfidence: true,
			};
		}
		for (const renderer of declaredFunctionBodies(executableSource)) {
			if (
				!/^(?:render(?:dashboard|charts?|graphs?|plots?|kpis?|metrics?|tables?|data|view|[A-Za-z_$][\w$]*(?:chart|graph|plot))?|draw(?:[A-Za-z_$][\w$]*(?:chart|graph|plot))|update(?:dashboard|charts?|graphs?|plots?|kpis?|metrics?|tables?|data|view|[A-Za-z_$][\w$]*(?:chart|graph|plot))|refresh(?:dashboard|charts?|graphs?|plots?|kpis?|metrics?|tables?|data|view|[A-Za-z_$][\w$]*(?:chart|graph|plot))|(?:generate|create|build|make)(?:mock|demo|sample|fixture|seed)?(?:data|dataset|series|metrics?)|(?:generate|create|build|make)[A-Za-z_$][\w$]*(?:data|dataset|series|metrics?))$/iu.test(
					renderer.name,
				)
			) {
				continue;
			}
			const randomOffset = renderer.body.indexOf("Math.random");
			if (randomOffset < 0) continue;
			if (
				invocationCount(executableSource, renderer.name) <
				declaredFunctionInvocationMinimum(executableSource, renderer.name)
			) {
				continue;
			}
			const bodyOffset = executableSource.indexOf(renderer.body, renderer.index);
			return {
				evidence: evidenceAt(source, (bodyOffset < 0 ? renderer.index : bodyOffset) + randomOffset),
				highConfidence: true,
			};
		}
	}
	return undefined;
}

function transitiveObjectRandomDataIndex(source: string): number | undefined {
	const dataSemantics = /(?:mock|demo|sample|fixture|seed|data|dataset|series|metric|row)/iu;
	const declarations = source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/gu);
	for (const declaration of declarations) {
		const objectName = declaration[1] ?? "";
		const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (!objectName || closeBrace < 0 || closeBrace - openBrace > 65_536) continue;
		const objectBody = source.slice(openBrace + 1, closeBrace);
		const methodDeclarations = [
			...objectBody.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu),
			...objectBody.matchAll(
				/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*(?:function\s*\([^)]*\)|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)\s*\{/gu,
			),
		].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
		const methods: Array<{ name: string; body: string; randomIndex?: number }> = [];
		for (const method of methodDeclarations) {
			const name = method[1] ?? "";
			if (!name || /^(?:if|for|while|switch|catch|function)$/u.test(name)) continue;
			const methodOpenBrace = openBrace + 1 + (method.index ?? 0) + method[0].lastIndexOf("{");
			const methodCloseBrace = matchingJavaScriptBrace(source, methodOpenBrace);
			if (methodCloseBrace < 0 || methodCloseBrace > closeBrace) continue;
			const body = source.slice(methodOpenBrace + 1, methodCloseBrace);
			const randomOffset = body.indexOf("Math.random");
			methods.push({
				name,
				body,
				...(randomOffset >= 0 ? { randomIndex: methodOpenBrace + 1 + randomOffset } : {}),
			});
		}
		if (
			methods.length === 0 ||
			!dataSemantics.test(`${objectName} ${methods.map((method) => method.name).join(" ")}`)
		) {
			continue;
		}
		const tainted = new Set(
			methods.filter((method) => method.randomIndex !== undefined).map((method) => method.name),
		);
		if (tainted.size === 0) continue;
		const escapedObjectName = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (let pass = 0; pass < methods.length; pass += 1) {
			let changed = false;
			for (const method of methods) {
				if (tainted.has(method.name)) continue;
				const callsTaintedMethod = [...tainted].some((callee) => {
					const escapedCallee = callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					return new RegExp(String.raw`\b(?:this|${escapedObjectName})\s*\.\s*${escapedCallee}\s*\(`, "u").test(
						method.body,
					);
				});
				if (!callsTaintedMethod) continue;
				tainted.add(method.name);
				changed = true;
			}
			if (!changed) break;
		}
		const invokedTaintedMethod = methods.find((method) => {
			if (!tainted.has(method.name)) return false;
			const escapedMethod = method.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return [
				...source.matchAll(new RegExp(`\\b${escapedObjectName}\\s*\\.\\s*${escapedMethod}\\s*\\(`, "gu")),
			].some((call) => (call.index ?? 0) < openBrace || (call.index ?? 0) > closeBrace);
		});
		if (!invokedTaintedMethod) continue;
		const randomSource = methods.find((method) => method.randomIndex !== undefined && tainted.has(method.name));
		if (randomSource?.randomIndex !== undefined) return randomSource.randomIndex;
	}
	return undefined;
}

function declaredFunctionInvocationMinimum(source: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// A classic declaration itself looks like a call to invocationCount;
	// function-valued variables do not, so one actual call is sufficient.
	return new RegExp(`\\bfunction\\s+${escaped}\\s*\\(`, "u").test(source) ? 2 : 1;
}

function invocationCount(source: string, name: string): number {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return [...source.matchAll(new RegExp(`\\b${escaped}\\s*\\(`, "gu"))].length;
}

function firstSourceEvidence(sources: ScriptSource[], pattern: RegExp): string | undefined {
	for (const source of sources) {
		const match = pattern.exec(source.content);
		if (match?.index !== undefined) return evidenceAt(source, match.index);
	}
	return undefined;
}

function evidenceAt(source: ScriptSource, index: number): string {
	return sourceEvidence(
		source.path,
		source.lineOffset + lineNumberAt(source.content, index),
		sourceLineAt(source.content, index),
	);
}

function sourceEvidence(path: string, line: number, excerpt: string): string {
	return `${path}:${line} ${excerpt.trim().slice(0, 180)}`;
}

function lineNumberAt(source: string, index: number): number {
	return source.slice(0, Math.max(0, index)).split("\n").length;
}

function sourceLineAt(source: string, index: number): string {
	const start = source.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
	const end = source.indexOf("\n", index);
	return source.slice(start, end < 0 ? source.length : end);
}

function combinedScriptSource(html: string, scripts: LocalScript[]): string {
	const inlineScripts = [...html.matchAll(SCRIPT_BLOCK_PATTERN)]
		.filter((match) => !staticHtmlAttributeValue(match[1] ?? "", "src"))
		.map((match) => match[2] ?? "");
	return [...scripts.map((script) => script.content), ...inlineScripts].join("\n");
}

function unwiredSelectErrors(html: string, scriptSource: string): string[] {
	if (
		GENERIC_SELECT_VALUE_HANDLER_PATTERN.test(scriptSource) ||
		GENERIC_SELECT_CHANGE_HANDLER_PATTERN.test(scriptSource)
	) {
		return [];
	}
	const errors: string[] = [];
	for (const match of html.matchAll(SELECT_TAG_PATTERN)) {
		const id = attributeValue(match[1] ?? "", "id");
		if (
			!id ||
			scriptReferencesId(scriptSource, id) ||
			delegatedSelectHandlerReferencesId(scriptSource, id) ||
			delegatedContainerSelectHandlerReferencesId(html, scriptSource, id) ||
			explicitSelectBindingMapReferencesId(scriptSource, id) ||
			dynamicConstructedSelectHandlerReferencesId(scriptSource, id)
		) {
			continue;
		}
		errors.push(`Select control #${id} is never referenced by local JavaScript and cannot affect rendered data.`);
	}
	return errors;
}

function delegatedContainerSelectHandlerReferencesId(html: string, source: string, id: string): boolean {
	const select = staticMarkupElements(html).find((element) => element.tagName === "select" && element.id === id);
	if (!select) return false;
	for (let ancestor = select.parent; ancestor; ancestor = ancestor.parent) {
		if (!ancestor.id) continue;
		const escapedAncestor = ancestor.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const listenerPattern = new RegExp(
			String.raw`(?:getElementById\(\s*(['"\x60])${escapedAncestor}\1\s*\)|querySelector\(\s*(['"\x60])#${escapedAncestor}\2\s*\))\s*\.\s*addEventListener\(\s*(['"\x60])change\3\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{`,
			"gu",
		);
		for (const listener of source.matchAll(listenerPattern)) {
			const eventVariable = listener[4];
			const openBrace = (listener.index ?? 0) + listener[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(source, openBrace);
			if (!eventVariable || closeBrace < 0) continue;
			const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const body = source.slice(openBrace + 1, closeBrace);
			if (
				new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*id\\b`, "u").test(body) &&
				new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*value\\b`, "u").test(body)
			) {
				return true;
			}
		}
		const expressionListenerPattern = new RegExp(
			String.raw`(?:getElementById\(\s*(['"\x60])${escapedAncestor}\1\s*\)|querySelector\(\s*(['"\x60])#${escapedAncestor}\2\s*\))\s*\.\s*addEventListener\(\s*(['"\x60])change\3\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*([^;\r\n]{1,1024})`,
			"gu",
		);
		for (const listener of source.matchAll(expressionListenerPattern)) {
			const eventVariable = listener[4];
			const body = listener[5] ?? "";
			if (!eventVariable) continue;
			const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (
				new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*id\\b`, "u").test(body) &&
				new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*value\\b`, "u").test(body)
			) {
				return true;
			}
		}
	}
	return false;
}

function explicitSelectBindingMapReferencesId(source: string, id: string): boolean {
	return explicitSelectBindingMaps(source).some((bindingMap) => bindingMap.entries.some((entry) => entry.id === id));
}

function explicitSelectBindingMaps(source: string): ExplicitSelectBindingMap[] {
	const maps: ExplicitSelectBindingMap[] = [];
	for (const declaration of source.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]{1,8192}?)\]\s*;/gu,
	)) {
		const collectionName = declaration[1];
		const items = declaration[2] ?? "";
		if (!collectionName) continue;
		const entries: ExplicitSelectBindingMap["entries"] = [];
		for (const item of items.matchAll(/\{([\s\S]{1,768}?)\}/gu)) {
			const body = item[1] ?? "";
			const id = /\bid\s*:\s*(['"`])([^'"`$]+)\1/u.exec(body)?.[2];
			const property = /\b(?:key|property|stateKey)\s*:\s*(['"`])([^'"`$]+)\1/u.exec(body)?.[2];
			if (!id || !property) continue;
			entries.push({
				id,
				property,
				index: (declaration.index ?? 0) + declaration[0].indexOf(items) + (item.index ?? 0),
			});
		}
		if (entries.length < 2) continue;
		const escapedCollection = collectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const loop = new RegExp(
			String.raw`\b${escapedCollection}\s*\.\s*forEach\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\{`,
			"gu",
		).exec(source);
		const parameter = loop?.[1];
		const openBrace = loop?.index === undefined ? -1 : loop.index + loop[0].lastIndexOf("{");
		const closeBrace = openBrace < 0 ? -1 : matchingJavaScriptBrace(source, openBrace);
		if (!parameter || closeBrace < 0) continue;
		const escapedParameter = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const body = source.slice(openBrace + 1, closeBrace);
		if (
			!new RegExp(String.raw`getElementById\s*\(\s*${escapedParameter}\s*\.\s*id\s*\)`, "u").test(body) ||
			!/\.\s*addEventListener\s*\(\s*(['"`])change\1/u.test(body) ||
			!new RegExp(
				String.raw`\bstate\s*\.\s*filters\s*\[\s*${escapedParameter}\s*\.\s*(?:key|property|stateKey)\s*\]\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*target\s*\.\s*value\b`,
				"iu",
			).test(body)
		) {
			continue;
		}
		maps.push({ collectionName, entries, index: declaration.index ?? 0 });
	}
	return maps;
}

function dynamicConstructedSelectHandlerReferencesId(source: string, id: string): boolean {
	const loops: Array<{ items: string; parameter: string; body: string }> = [];
	for (const loop of source.matchAll(/\[([\s\S]{1,1024}?)\]\s*\.\s*forEach\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\{/gu)) {
		const parameter = loop[2];
		const openBrace = (loop.index ?? 0) + loop[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (!parameter || closeBrace < 0) continue;
		loops.push({ items: loop[1] ?? "", parameter, body: source.slice(openBrace + 1, closeBrace) });
	}
	for (const declaration of source.matchAll(
		/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]{1,1024}?)\]\s*;/gu,
	)) {
		const collection = declaration[1];
		if (!collection) continue;
		const escapedCollection = collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		for (const loop of source.matchAll(
			new RegExp(String.raw`\b${escapedCollection}\s*\.\s*forEach\s*\(\s*([A-Za-z_$][\w$]*)\s*=>\s*\{`, "gu"),
		)) {
			const parameter = loop[1];
			const openBrace = (loop.index ?? 0) + loop[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(source, openBrace);
			if (!parameter || closeBrace < 0) continue;
			loops.push({ items: declaration[2] ?? "", parameter, body: source.slice(openBrace + 1, closeBrace) });
		}
	}
	for (const loop of loops) {
		const { body, parameter } = loop;
		if (!/\.\s*addEventListener\s*\(\s*(['"])change\1/u.test(body) || !/\.\s*value\b/u.test(body)) continue;
		const escapedParameter = parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		// A common generated-app pattern declares the complete DOM ids in an
		// array and then loops over getElementById(id). This is just as explicit
		// as prefix/suffix construction and should not be reported as unwired.
		// Requiring the literal id, the direct lookup, the listener, and a value
		// read in the same bounded loop keeps this cross-file association narrow.
		if (
			new RegExp(String.raw`getElementById\(\s*${escapedParameter}\s*\)`, "u").test(body) &&
			new RegExp(`(['"])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "u").test(loop.items)
		) {
			return true;
		}
		const prefixedConstruction = new RegExp(
			String.raw`getElementById\(\s*(['"\x60])([^'"\x60$]*)\1\s*\+\s*${escapedParameter}\s*\)`,
			"u",
		).exec(body);
		const prefix = prefixedConstruction?.[2];
		if (prefix !== undefined && id.startsWith(prefix)) {
			const item = id.slice(prefix.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(['"])${item}\\1`, "u").test(loop.items)) return true;
		}
		const suffixedConstruction = new RegExp(
			String.raw`getElementById\(\s*${escapedParameter}\s*\+\s*(['"\x60])([^'"\x60$]*)\1\s*\)`,
			"u",
		).exec(body);
		const suffix = suffixedConstruction?.[2];
		if (suffix !== undefined && id.endsWith(suffix)) {
			const item = id.slice(0, id.length - suffix.length).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (new RegExp(`(['"])${item}\\1`, "u").test(loop.items)) return true;
		}
	}
	return false;
}

function delegatedSelectHandlerReferencesId(source: string, id: string): boolean {
	const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const listener of source.matchAll(
		/\.\s*addEventListener\(\s*(['"])change\1\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{/gu,
	)) {
		const eventVariable = listener[2];
		const openBrace = (listener.index ?? 0) + listener[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (!eventVariable || closeBrace < 0) continue;
		const body = source.slice(openBrace + 1, closeBrace);
		const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (!new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*id\\b`, "u").test(body)) continue;
		if (!new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*value\\b`, "u").test(body)) continue;
		if (new RegExp(`(['"])${escapedId}\\1`, "u").test(body)) return true;
	}
	return false;
}

function unusedSelectValueErrors(html: string, sources: ScriptSource[]): string[] {
	const combined = sources.map((source) => source.content).join("\n");
	const errors: string[] = [
		...advisoryOnlySelectHandlerErrors(sources),
		...placeholderOnlyFilterHandlerErrors(sources),
		...inertDelegatedFilterStateErrors(html, sources),
		...explicitBindingMapFilterErrors(html, sources),
		...deadDynamicConstructedFilterPropertyErrors(sources),
		...deadBulkStateFilterPropertyErrors(sources),
		...deadAliasedStateFilterPropertyErrors(sources),
		...deadStateFilterPropertyErrors(sources),
		...deadSharedStateFilterPropertyErrors(html, sources),
		...deadFlatStateFilterPropertyErrors(html, sources),
	];
	for (const match of html.matchAll(SELECT_TAG_PATTERN)) {
		const id = attributeValue(match[1] ?? "", "id");
		if (!id) continue;
		const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const idReferencePattern = new RegExp(`['"\\x60]#?${escapedId}['"\\x60]`, "gu");
		const resetOnlyPatternSource = String.raw`(?:(?:document\.)?getElementById\(\s*['"\x60]${escapedId}['"\x60]\s*\)|(?:document\.)?querySelector\(\s*['"\x60]#${escapedId}['"\x60]\s*\))\s*\.\s*(?:selectedIndex|value)\s*=\s*[^;\n]+;?`;
		const resetOnlyMatches = [...combined.matchAll(new RegExp(resetOnlyPatternSource, "gu"))];
		if (
			resetOnlyMatches.length > 0 &&
			!/(?:onchange|oninput)\s*=/iu.test(match[1] ?? "") &&
			!GENERIC_SELECT_VALUE_HANDLER_PATTERN.test(combined) &&
			!GENERIC_SELECT_CHANGE_HANDLER_PATTERN.test(combined) &&
			!DYNAMIC_SELECT_ID_HANDLER_PATTERN.test(combined)
		) {
			const sourceWithoutResetAssignments = combined.replace(new RegExp(resetOnlyPatternSource, "gu"), "");
			if (![...sourceWithoutResetAssignments.matchAll(idReferencePattern)].length) {
				for (const source of sources) {
					const resetMatch = new RegExp(resetOnlyPatternSource, "u").exec(source.content);
					if (resetMatch?.index === undefined) continue;
					errors.push(
						`static.filter_value_unused: Select #${id} is only reset and is never read by an applicable filter handler. Evidence: ${evidenceAt(source, resetMatch.index)}`,
					);
					break;
				}
				continue;
			}
		}
		const referenceCount = [...combined.matchAll(idReferencePattern)].length;
		if (
			referenceCount === 1 &&
			DYNAMIC_SELECT_CHANGE_HANDLER_PATTERN.test(combined) &&
			!DYNAMIC_SELECT_ID_HANDLER_PATTERN.test(combined) &&
			!GENERIC_SELECT_VALUE_HANDLER_PATTERN.test(combined) &&
			!/(?:target\s*\.\s*value\b|new\s+FormData\s*\(|\.elements\s*\[)/u.test(combined)
		) {
			for (const source of sources) {
				const reference = idReferencePattern.exec(source.content);
				if (reference?.index === undefined) continue;
				errors.push(
					`static.filter_value_unused: Select #${id} is bound through a generic change handler, but its value is never read by rendered-data code. Evidence: ${evidenceAt(source, reference.index)}`,
				);
				break;
			}
			continue;
		}
		const capturePattern = new RegExp(
			String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:(?:document\.)?(?:getElementById|querySelector)\(\s*['"\x60]#?${escapedId}['"\x60]\s*\)|\$\(\s*['"\x60]#${escapedId}['"\x60]\s*\))\.value\b`,
			"u",
		);
		for (const source of sources) {
			const capture = capturePattern.exec(source.content);
			const variable = capture?.[1];
			if (!variable || capture?.index === undefined) continue;
			const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if ([...combined.matchAll(new RegExp(`\\b${escapedVariable}\\b`, "gu"))].length !== 1) continue;
			errors.push(
				`static.filter_value_unused: Select #${id} reads its value into ${variable} but never uses that value. Evidence: ${evidenceAt(source, capture.index)}`,
			);
		}
	}
	return unique(errors);
}

function inertDelegatedFilterStateErrors(html: string, sources: readonly ScriptSource[]): string[] {
	if (!/(?:dashboard|analytics|kpi|chart|trend|yield|pareto|table|看板|分析|指标|图表|趋势|良率)/iu.test(html)) {
		return [];
	}
	const errors: string[] = [];
	for (const source of sources) {
		const updateMethod = objectMethodBody(source.content, "updateFilter");
		const dataMethod = objectMethodBody(source.content, "getFilteredData");
		if (!updateMethod || !dataMethod || invocationCount(source.content, "getFilteredData") < 2) continue;
		const updateBody = withoutJavaScriptComments(updateMethod.body);
		const dataBody = withoutJavaScriptComments(dataMethod.body);
		if (
			!/\bthis\s*\.\s*filters\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*[A-Za-z_$][\w$]*/u.test(updateBody) ||
			!/\b(?:this\s*\.\s*)?notify\s*\(/u.test(updateBody) ||
			!/\breturn\s+this\s*\.\s*dataset\s*;?/u.test(dataBody) ||
			/\bthis\s*\.\s*filters\b/u.test(dataBody)
		) {
			continue;
		}
		if (!delegatedUpdateFilterCall(source.content)) continue;
		// A subscriber that accepts filter arguments or a named subscriber may apply
		// them downstream. Keep that architecture fail-open; the high-confidence
		// defect is the common no-argument redraw subscriber plus identity getter.
		if (
			/\.\s*subscribe\s*\(\s*(?:\(\s*[A-Za-z_$][\w$]*|[A-Za-z_$][\w$]*\s*=>|[A-Za-z_$][\w$]*\s*\))/u.test(
				source.content,
			)
		) {
			continue;
		}
		const filterKeys = objectPropertyKeys(source.content, "filters");
		if (filterKeys.size === 0) continue;
		const returnIndex = /\breturn\s+this\s*\.\s*dataset\s*;?/u.exec(dataMethod.body)?.index ?? 0;
		const evidence = evidenceAt(source, dataMethod.openBrace + 1 + returnIndex);
		for (const selectMatch of html.matchAll(SELECT_TAG_PATTERN)) {
			const id = attributeValue(selectMatch[1] ?? "", "id");
			const property = id ? kebabToCamelCase(id) : "";
			if (!id || !property || !filterKeys.has(property) || enabledStaticSelectOptionCount(selectMatch[0]) < 2) {
				continue;
			}
			errors.push(
				`static.filter_value_unused: Select #${id} updates this.filters.${property}, but getFilteredData() returns this.dataset unchanged and the redraw subscriber does not consume filter arguments. Evidence: ${evidence}`,
			);
		}
	}
	return unique(errors);
}

function explicitBindingMapFilterErrors(html: string, sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	const declaredFilterProperties = allObjectPropertyKeys(combined, "filters");
	const markupSelects = staticMarkupElements(html).filter((element) => element.tagName === "select");
	for (const source of sources) {
		for (const bindingMap of explicitSelectBindingMaps(source.content)) {
			const mappedIds = new Set(bindingMap.entries.map((entry) => entry.id));
			for (const entry of bindingMap.entries) {
				if (!selectIdExists(html, entry.id) || !declaredFilterProperties.has(entry.property)) continue;
				if (renderedDataReadsStateFilterProperty(combined, entry.property)) continue;
				errors.push(
					`static.filter_value_unused: Select #${entry.id} writes state.filters.${entry.property} through an explicit binding map, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, entry.index)}`,
				);
			}

			const mappedElements = markupSelects.filter((element) => mappedIds.has(element.id));
			const mappedParentCounts = new Map<StaticMarkupElement, number>();
			for (const element of mappedElements) {
				for (let ancestor = element.parent; ancestor; ancestor = ancestor.parent) {
					if (!/(?:filter|control)/iu.test(`${ancestor.id} ${ancestor.classNames.join(" ")}`)) continue;
					mappedParentCounts.set(ancestor, (mappedParentCounts.get(ancestor) ?? 0) + 1);
				}
			}
			for (const [parent, count] of mappedParentCounts) {
				if (count < 2) continue;
				for (const select of descendants(parent).filter((child) => child.tagName === "select")) {
					if (!select.id || mappedIds.has(select.id)) continue;
					const property = kebabToCamelCase(select.id.replace(/^filter-/iu, "").replace(/-filter$/iu, ""));
					if (!property || !declaredFilterProperties.has(property)) continue;
					if (
						scriptReferencesId(combined, select.id) ||
						delegatedContainerSelectHandlerReferencesId(html, combined, select.id)
					) {
						continue;
					}
					errors.push(
						`static.filter_value_unused: Select #${select.id} is omitted from the explicit filter binding map and cannot update declared state.filters.${property}. Evidence: ${evidenceAt(source, bindingMap.index)}`,
					);
				}
			}
		}
	}
	return unique(errors);
}

function objectMethodBody(
	source: string,
	name: string,
): { body: string; openBrace: number; closeBrace: number } | undefined {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const patterns = [
		new RegExp(String.raw`\b${escapedName}\s*\([^)]*\)\s*\{`, "gu"),
		new RegExp(String.raw`\b${escapedName}\s*:\s*function\s*\([^)]*\)\s*\{`, "gu"),
	];
	for (const pattern of patterns) {
		for (const declaration of source.matchAll(pattern)) {
			const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(source, openBrace);
			if (closeBrace < 0) continue;
			return { body: source.slice(openBrace + 1, closeBrace), openBrace, closeBrace };
		}
	}
	return undefined;
}

function delegatedUpdateFilterCall(source: string): boolean {
	for (const listener of source.matchAll(
		/\.\s*addEventListener\s*\(\s*(['"`])change\1\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{/gu,
	)) {
		const eventVariable = listener[2];
		const openBrace = (listener.index ?? 0) + listener[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (!eventVariable || closeBrace < 0) continue;
		const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const body = source.slice(openBrace + 1, closeBrace);
		if (
			/\.\s*updateFilter\s*\(/u.test(body) &&
			new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*id\\b`, "u").test(body) &&
			new RegExp(`\\b${escapedEvent}\\s*\\.\\s*target\\s*\\.\\s*value\\b`, "u").test(body)
		) {
			return true;
		}
	}
	return false;
}

function objectPropertyKeys(source: string, propertyName: string): Set<string> {
	const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const declaration = new RegExp(String.raw`\b${escapedName}\s*:\s*\{`, "gu").exec(source);
	if (declaration?.index === undefined) return new Set();
	const openBrace = declaration.index + declaration[0].lastIndexOf("{");
	const closeBrace = matchingJavaScriptBrace(source, openBrace);
	if (closeBrace < 0) return new Set();
	const body = source.slice(openBrace + 1, closeBrace);
	return new Set(
		[...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/gu)].map((match) => match[1] ?? "").filter(Boolean),
	);
}

function allObjectPropertyKeys(source: string, propertyName: string): Set<string> {
	const keys = new Set<string>();
	const escapedName = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (const declaration of source.matchAll(new RegExp(String.raw`\b${escapedName}\s*:\s*\{`, "gu"))) {
		const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (closeBrace < 0) continue;
		const body = source.slice(openBrace + 1, closeBrace);
		for (const property of body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:/gu)) {
			if (property[1]) keys.add(property[1]);
		}
	}
	return keys;
}

function enabledStaticSelectOptionCount(selectHtml: string): number {
	return [...selectHtml.matchAll(/<option\b([^>]*)>/giu)].filter(
		(option) => !/(?:^|\s)disabled(?:\s|=|$)/iu.test(option[1] ?? ""),
	).length;
}

function kebabToCamelCase(value: string): string {
	return value.replace(/-([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
}

function withoutJavaScriptComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\r\n]*/gu, "");
}

export function executableMathRandomCallIndex(source: string): number | undefined {
	const match = /\bMath\s*\.\s*random\s*\(/u.exec(maskJavaScriptCommentsAndStrings(source));
	return match?.index;
}

function maskJavaScriptCommentsAndStrings(source: string): string {
	const characters = source.split("");
	const masked = [...characters];
	let mode: "code" | "line-comment" | "block-comment" | "single-string" | "double-string" | "template-string" = "code";
	let templateExpressionDepth = 0;
	for (let index = 0; index < characters.length; index += 1) {
		const current = characters[index] ?? "";
		const next = characters[index + 1] ?? "";
		if (mode === "code") {
			if (current === "/" && next === "/") {
				masked[index] = " ";
				masked[index + 1] = " ";
				mode = "line-comment";
				index += 1;
				continue;
			}
			if (current === "/" && next === "*") {
				masked[index] = " ";
				masked[index + 1] = " ";
				mode = "block-comment";
				index += 1;
				continue;
			}
			if (current === "'") {
				mode = "single-string";
				continue;
			}
			if (current === '"') {
				mode = "double-string";
				continue;
			}
			if (current === "`") {
				mode = "template-string";
				continue;
			}
			if (current === "/") {
				const regexEnd = javascriptRegexLiteralEnd(characters, index);
				if (regexEnd >= 0) {
					for (let cursor = index; cursor <= regexEnd; cursor += 1) {
						if (characters[cursor] !== "\r" && characters[cursor] !== "\n") masked[cursor] = " ";
					}
					index = regexEnd;
					continue;
				}
			}
			if (templateExpressionDepth > 0) {
				if (current === "{") templateExpressionDepth += 1;
				if (current === "}") {
					templateExpressionDepth -= 1;
					if (templateExpressionDepth === 0) mode = "template-string";
				}
			}
			continue;
		}
		if (mode === "line-comment") {
			if (current === "\r" || current === "\n") {
				mode = "code";
			} else {
				masked[index] = " ";
			}
			continue;
		}
		if (mode === "block-comment") {
			if (current === "*" && next === "/") {
				masked[index] = " ";
				masked[index + 1] = " ";
				mode = "code";
				index += 1;
			} else if (current !== "\r" && current !== "\n") {
				masked[index] = " ";
			}
			continue;
		}
		if (mode === "template-string") {
			if (current === "\\") {
				masked[index] = " ";
				if (index + 1 < masked.length && characters[index + 1] !== "\r" && characters[index + 1] !== "\n") {
					masked[index + 1] = " ";
				}
				index += 1;
				continue;
			}
			if (current === "`") {
				mode = "code";
				continue;
			}
			if (current === "$" && next === "{") {
				templateExpressionDepth = 1;
				mode = "code";
				index += 1;
				continue;
			}
			if (current !== "\r" && current !== "\n") masked[index] = " ";
			continue;
		}
		const quote = mode === "single-string" ? "'" : '"';
		if (current === "\\") {
			masked[index] = " ";
			if (index + 1 < masked.length && characters[index + 1] !== "\r" && characters[index + 1] !== "\n") {
				masked[index + 1] = " ";
			}
			index += 1;
			continue;
		}
		if (current === quote) {
			mode = "code";
		} else if (current !== "\r" && current !== "\n") {
			masked[index] = " ";
		}
	}
	return masked.join("");
}

function javascriptRegexLiteralEnd(characters: readonly string[], start: number): number {
	let previous = start - 1;
	while (previous >= 0 && /\s/u.test(characters[previous] ?? "")) previous -= 1;
	const previousCharacter = previous >= 0 ? (characters[previous] ?? "") : "";
	const prefixAllowsRegex =
		previous < 0 ||
		/[=(:,!&|?{;[]/u.test(previousCharacter) ||
		(previousCharacter === ">" && characters[previous - 1] === "=") ||
		/\b(?:return|case|throw|delete|void|typeof|instanceof|in|of|yield|await)\s*$/u.test(
			characters.slice(0, start).join(""),
		);
	if (!prefixAllowsRegex) return -1;
	let inCharacterClass = false;
	for (let index = start + 1; index < characters.length; index += 1) {
		const current = characters[index] ?? "";
		if (current === "\r" || current === "\n") return -1;
		if (current === "\\") {
			index += 1;
			continue;
		}
		if (current === "[") {
			inCharacterClass = true;
			continue;
		}
		if (current === "]") {
			inCharacterClass = false;
			continue;
		}
		if (current !== "/" || inCharacterClass) continue;
		while (/[A-Za-z]/u.test(characters[index + 1] ?? "")) index += 1;
		return index;
	}
	return -1;
}

function deadDynamicConstructedFilterPropertyErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	const computedAssignmentPattern = /\bstate\s*\.\s*filters\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*=\s*[^;\r\n]+;?/gu;
	const withoutComputedAssignments = combined
		.replace(computedAssignmentPattern, "")
		// A filter-definition template commonly reads state.filters[f.id] only
		// to mark the current <option> selected. That is UI reflection, not
		// whole-object data consumption, so it must not suppress dead-property
		// analysis for every dynamically declared control.
		.replace(/\bstate\s*\.\s*filters\s*\[\s*[A-Za-z_$][\w$]*\s*\.\s*id\s*\]/gu, "");
	// Whole-object or computed consumption after the assignment can legitimately
	// use every dynamic property. Fail open instead of guessing through it.
	if (
		/\bstate\s*\.\s*filters\s*\[/u.test(withoutComputedAssignments) ||
		/\bstate\s*\.\s*filters\b(?!\s*\.)/u.test(withoutComputedAssignments)
	) {
		return errors;
	}
	if (!computedAssignmentPattern.test(combined)) return errors;

	for (const source of sources) {
		for (const definition of source.content.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]{1,8192}?)\]\s*;/gu,
		)) {
			const collectionName = definition[1];
			const items = definition[2] ?? "";
			if (!collectionName || !/(?:filter|control|selector)/iu.test(collectionName)) continue;
			const escapedCollection = collectionName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
			const map = new RegExp(
				String.raw`\b${escapedCollection}\s*\.\s*map\s*\(\s*([A-Za-z_$][\w$]*)\s*=>[\s\S]{0,4096}?<select\b[^>]*\bid\s*=\s*(["'\x60])([^"'\x60$]*)\$\{\s*\1\s*\.\s*id\s*\}`,
				"u",
			).exec(source.content);
			const prefix = map?.[3];
			if (prefix === undefined) continue;
			const ids = [...items.matchAll(/\bid\s*:\s*(["'\x60])([^"'\x60$]+)\1/gu)];
			if (ids.length < 2) continue;
			for (const idMatch of ids) {
				const property = idMatch[2];
				if (!property || renderedDataReadsStateFilterProperty(withoutComputedAssignments, property)) continue;
				const itemIndex = (definition.index ?? 0) + definition[0].indexOf(items) + (idMatch.index ?? 0);
				errors.push(
					`static.filter_value_unused: Select #${prefix}${property} writes state.filters.${property} through a dynamic filter definition, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, itemIndex)}`,
				);
			}
		}
	}
	return errors;
}

function advisoryOnlySelectHandlerErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	for (const source of sources) {
		for (const handler of declaredFunctionBodies(source.content)) {
			if (!/(?:apply|filter|search|query|refresh)/iu.test(handler.name)) continue;
			const captures = [
				...handler.body.matchAll(
					/\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:document\.)?(?:getElementById|querySelector)\(\s*(['"`])#?([^'"`$]+)\1\s*\)\s*\.\s*value\b[^;]*;?/gu,
				),
			];
			if (captures.length === 0) continue;
			let residual = handler.body;
			for (const capture of captures) residual = residual.replace(capture[0], "");
			residual = withoutAdvisoryCalls(residual)
				.replace(/\/\*[\s\S]*?\*\//gu, "")
				.replace(/\/\/[^\r\n]*/gu, "")
				.replace(/[;\s]+/gu, "");
			if (residual) continue;
			for (const capture of captures) {
				const id = capture[2];
				if (!id) continue;
				errors.push(
					`static.filter_value_unused: Select #${id} is read only by advisory-only handler ${handler.name}, which logs or displays the value without changing rendered data. Evidence: ${evidenceAt(source, handler.index)}`,
				);
			}
		}
	}
	return errors;
}

function placeholderOnlyFilterHandlerErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	for (const source of sources) {
		for (const handler of declaredFunctionBodies(source.content)) {
			if (!/(?:apply|filter|refresh)/iu.test(handler.name)) continue;
			if (
				!/(?:would\s+go\s+here|to-?do|not\s+implemented|just\s+(?:trigger|refresh|update)[\s\S]{0,120}(?:current|existing|same)\s+data)/iu.test(
					handler.body,
				)
			) {
				continue;
			}
			const executableBody = handler.body.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\r\n]*/gu, "");
			if (/\bfilters?\b/iu.test(executableBody)) continue;
			if (!/(?:\.update\s*\(|update(?:kpis?|charts?|metrics?|tables?)\s*\()/iu.test(executableBody)) continue;
			errors.push(
				`static.filter_value_unused: Handler ${handler.name} explicitly leaves filtering unimplemented and only redraws existing data. Evidence: ${evidenceAt(source, handler.index)}`,
			);
		}
	}
	return errors;
}

function deadBulkStateFilterPropertyErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const assignmentPattern = /\bstate\s*\.\s*filters\s*=\s*\{([\s\S]{0,4096}?)\}\s*;?/gu;
	const assignments = sources.flatMap((source) =>
		[...source.content.matchAll(assignmentPattern)].map((assignment) => ({ source, assignment })),
	);
	if (assignments.length === 0) return errors;
	const combinedWithoutAssignments = sources.map((source) => source.content.replace(assignmentPattern, "")).join("\n");
	if (
		/\bstate\s*\.\s*filters\s*\[/u.test(combinedWithoutAssignments) ||
		/\bstate\s*\.\s*filters\b(?!\s*\.)/u.test(combinedWithoutAssignments)
	) {
		return errors;
	}
	const entryPattern =
		/\b([A-Za-z_$][\w$]*)\s*:\s*(?:document\s*\.\s*)?(?:getElementById|querySelector)\(\s*(['"`])#?([^'"`$]+)\2\s*\)\s*\.\s*value\b/gu;
	for (const { source, assignment } of assignments) {
		const objectBody = assignment[1] ?? "";
		for (const entry of objectBody.matchAll(entryPattern)) {
			const property = entry[1];
			const id = entry[3];
			if (!property || !id) continue;
			const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			if (
				new RegExp(String.raw`\bstate\s*\.\s*filters\s*\.\s*${escapedProperty}\b`, "u").test(
					combinedWithoutAssignments,
				)
			) {
				continue;
			}
			const entryIndex = (assignment.index ?? 0) + assignment[0].indexOf(objectBody) + (entry.index ?? 0);
			errors.push(
				`static.filter_value_unused: Select #${id} writes state.filters.${property} in a bulk filter assignment, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, entryIndex)}`,
			);
		}
	}
	return errors;
}

function deadAliasedStateFilterPropertyErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	if (/\bstate\s*\.\s*filters\s*\[/u.test(combined) || /\bstate\s*\.\s*filters\b(?!\s*\.)/u.test(combined)) {
		return errors;
	}
	const elementIds = new Map<string, string>();
	const elementAliasPattern =
		/\b([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*=\s*(?:document\s*\.\s*)?(?:getElementById|querySelector)\(\s*(['"`])#?([^'"`$]+)\2\s*\)/gu;
	for (const source of sources) {
		for (const alias of source.content.matchAll(elementAliasPattern)) {
			const qualifiedName = alias[1]?.replace(/\s+/gu, "");
			const id = alias[3];
			if (qualifiedName && id) elementIds.set(qualifiedName, id);
		}
	}
	if (elementIds.size === 0) return errors;
	const stateAssignmentPattern =
		/\bstate\s*\.\s*filters\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\.\s*value\b/gu;
	for (const source of sources) {
		for (const assignment of source.content.matchAll(stateAssignmentPattern)) {
			const property = assignment[1];
			const alias = assignment[2]?.replace(/\s+/gu, "");
			const id = alias ? elementIds.get(alias) : undefined;
			if (!property || !id || renderedDataReadsStateFilterProperty(combined, property)) continue;
			errors.push(
				`static.filter_value_unused: Select #${id} writes state.filters.${property} through DOM alias ${alias}, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, assignment.index ?? 0)}`,
			);
		}
	}
	return errors;
}

function deadStateFilterPropertyErrors(sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	if (/\bstate\s*\.\s*filters\s*\[/u.test(combined)) return errors;
	const bareStateFilterUse = /\bstate\s*\.\s*filters\b(?!\s*\.)/u.test(combined);
	if (bareStateFilterUse) return errors;
	const bindingPattern =
		/\b(?:document\s*\.\s*)?getElementById\(\s*(['"`])([^'"`$]+)\1\s*\)\s*\.\s*addEventListener\(\s*(['"`])change\3\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{([\s\S]{0,768}?)\}\s*\)/gu;
	for (const source of sources) {
		for (const binding of source.content.matchAll(bindingPattern)) {
			const id = binding[2];
			const eventVariable = binding[4];
			const body = binding[5] ?? "";
			if (!id || !eventVariable) continue;
			const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const assignment = new RegExp(
				String.raw`\bstate\s*\.\s*filters\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*${escapedEvent}\s*\.\s*target\s*\.\s*value\b`,
				"u",
			).exec(body);
			const property = assignment?.[1];
			if (!property) continue;
			if (renderedDataReadsStateFilterProperty(combined, property)) continue;
			errors.push(
				`static.filter_value_unused: Select #${id} writes state.filters.${property}, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, binding.index ?? 0)}`,
			);
		}
	}
	return errors;
}

function renderedDataReadsStateFilterProperty(source: string, property: string): boolean {
	const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const qualifiedProperty = String.raw`\bstate\s*\.\s*filters\s*\.\s*${escapedProperty}\b`;
	const scrubbed = withoutAdvisoryCalls(source)
		.replace(
			new RegExp(
				String.raw`(?:^|[\r\n])[^\r\n]*(?:singleOpts|setSelect(?:Options|Value)?|populateSelect)[^\r\n]*${qualifiedProperty}[^\r\n]*`,
				"giu",
			),
			"",
		)
		.replace(new RegExp(String.raw`[^;\r\n]*\.\s*value\s*=\s*${qualifiedProperty}\s*;?`, "giu"), "")
		.replace(new RegExp(String.raw`${qualifiedProperty}\s*=(?!=)\s*[^;\r\n]+;?`, "giu"), "");
	return new RegExp(qualifiedProperty, "iu").test(scrubbed);
}

function deadSharedStateFilterPropertyErrors(html: string, sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	// Computed access or whole-object delegation can consume a property without
	// spelling it. Keep these cases advisory/fail-open rather than guessing.
	if (/\bstate\s*\.\s*filters\s*\[/u.test(combined) || /\bstate\s*\.\s*filters\b(?!\s*\.)/u.test(combined)) {
		return errors;
	}

	const bindingPattern =
		/\b[A-Za-z_$][\w$]*\s*\.\s*addEventListener\(\s*(['"`])change\1\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{/gu;
	for (const source of sources) {
		for (const binding of source.content.matchAll(bindingPattern)) {
			const eventVariable = binding[2];
			const openBrace = (binding.index ?? 0) + binding[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(source.content, openBrace);
			if (!eventVariable || openBrace < 0 || closeBrace < 0) continue;
			const body = source.content.slice(openBrace + 1, closeBrace);
			const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const derivedKeys = new Map<string, string>();
			for (const derived of body.matchAll(
				/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*replace\(\s*(['"`])([^'"`$]*)\2\s*,\s*(['"`])\4\s*\)/gu,
			)) {
				const keyVariable = derived[1];
				const removedPrefix = derived[3];
				if (keyVariable !== undefined && removedPrefix !== undefined) derivedKeys.set(keyVariable, removedPrefix);
			}

			const branchPattern = new RegExp(
				String.raw`(?:if|else\s+if)\s*\(\s*([A-Za-z_$][\w$]*)\s*={2,3}\s*(['"\x60])([^'"\x60$]+)\2\s*\)\s*state\s*\.\s*filters\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*${escapedEvent}\s*\.\s*target\s*\.\s*value\b`,
				"gu",
			);
			for (const branch of body.matchAll(branchPattern)) {
				const keyVariable = branch[1];
				const comparedValue = branch[3];
				const property = branch[4];
				if (!keyVariable || !comparedValue || !property) continue;
				const prefixedId = `${derivedKeys.get(keyVariable) ?? ""}${comparedValue}`;
				const id = selectIdExists(html, comparedValue)
					? comparedValue
					: selectIdExists(html, prefixedId)
						? prefixedId
						: undefined;
				if (!id || renderedDataReadsStateFilterProperty(combined, property)) continue;
				errors.push(
					`static.filter_value_unused: Select #${id} writes state.filters.${property} through a shared change handler, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, openBrace + 1 + (branch.index ?? 0))}`,
				);
			}
		}

		// Compact generated handlers are often nested inside forEach and can be
		// difficult to delimit with a single regular expression. Use a second,
		// still high-confidence path that requires all of these in one bounded
		// window: a change listener, a literal prefix removal, an exact branch for
		// the remaining control id, and a nested state assignment from target.value.
		for (const derived of source.content.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*replace\(\s*(['"`])([^'"`$]*)\2\s*,\s*(['"`])\4\s*\)/gu,
		)) {
			const keyVariable = derived[1];
			const removedPrefix = derived[3];
			const derivedIndex = derived.index ?? 0;
			if (!keyVariable || removedPrefix === undefined) continue;
			const boundedStart = Math.max(0, derivedIndex - 512);
			const boundedWindow = source.content.slice(boundedStart, derivedIndex + 4096);
			if (!/\.\s*addEventListener\(\s*(['"`])change\1/iu.test(boundedWindow)) continue;
			for (const select of html.matchAll(SELECT_TAG_PATTERN)) {
				const id = attributeValue(select[1] ?? "", "id");
				if (!id || !id.startsWith(removedPrefix)) continue;
				const comparedValue = id.slice(removedPrefix.length);
				if (!comparedValue) continue;
				const escapedKey = keyVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const escapedValue = comparedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const branch = new RegExp(
					String.raw`(?:if|else\s+if)\s*\(\s*${escapedKey}\s*={2,3}\s*(['"\x60])${escapedValue}\1\s*\)\s*state\s*\.\s*filters\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*target\s*\.\s*value\b`,
					"u",
				).exec(boundedWindow);
				const property = branch?.[2];
				if (!property || renderedDataReadsStateFilterProperty(combined, property)) continue;
				errors.push(
					`static.filter_value_unused: Select #${id} writes state.filters.${property} through a shared change handler, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, boundedStart + (branch?.index ?? 0))}`,
				);
			}
		}
		if (/\.\s*addEventListener\(\s*(['"`])change\1/iu.test(source.content)) {
			for (const branch of source.content.matchAll(
				/(?:if|else\s+if)\s*\(\s*([A-Za-z_$][\w$]*)\s*={2,3}\s*(['"`])([^'"`$]+)\2\s*\)\s*state\s*\.\s*filters\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*target\s*\.\s*value\b/gu,
			)) {
				const keyVariable = branch[1];
				const comparedValue = branch[3];
				const property = branch[4];
				if (!keyVariable || !comparedValue || !property) continue;
				const escapedKey = keyVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const prefixPattern = new RegExp(
					String.raw`\b(?:const|let|var)\s+${escapedKey}\s*=\s*[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*replace\(\s*(['"\x60])([^'"\x60$]*)\1\s*,\s*(['"\x60])\3\s*\)`,
					"gu",
				);
				const branchIndex = branch.index ?? 0;
				const prefixes = [...source.content.matchAll(prefixPattern)].filter(
					(candidate) => (candidate.index ?? 0) <= branchIndex && branchIndex - (candidate.index ?? 0) <= 4096,
				);
				const removedPrefix = prefixes.at(-1)?.[2] ?? "";
				const id = selectIdExists(html, comparedValue)
					? comparedValue
					: selectIdExists(html, `${removedPrefix}${comparedValue}`)
						? `${removedPrefix}${comparedValue}`
						: undefined;
				if (!id || renderedDataReadsStateFilterProperty(combined, property)) continue;
				errors.push(
					`static.filter_value_unused: Select #${id} writes state.filters.${property} through a shared change handler, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, branchIndex)}`,
				);
			}
		}
	}
	return unique(errors);
}

function deadFlatStateFilterPropertyErrors(html: string, sources: readonly ScriptSource[]): string[] {
	const errors: string[] = [];
	const combined = sources.map((source) => source.content).join("\n");
	// Dynamic or whole-object state consumption can legitimately read a property
	// without spelling state.<property>. Fail open instead of guessing through it.
	if (
		/\bstate\s*\[/u.test(combined) ||
		/\.{3}\s*state\b/u.test(combined) ||
		/\bObject\s*\.\s*(?:keys|values|entries)\s*\(\s*state\s*\)/u.test(combined) ||
		/\b(?:render|filter|query|compute|aggregate|update|apply)[\w$]*\s*\([^)]*\bstate\b(?!\s*[.[])/iu.test(combined) ||
		/\b(?:const|let|var)\s*\{[^}]+\}\s*=\s*state\b/u.test(combined)
	) {
		return errors;
	}

	for (const source of sources) {
		const assignments: Array<{ id: string; property: string; index: number }> = [];
		// Generated single-file dashboards frequently cache controls in an object and
		// attach property handlers (`els.dateFilter.onchange = ...`). This is a real
		// browser event binding, but neither the direct getElementById detector nor the
		// addEventListener detector below can see it. Keep this path deliberately
		// narrow: require an exact object-literal DOM alias, an onchange/oninput arrow
		// handler, an assignment from that handler's event target, and a select with an
		// actual alternative option. A flat state property that is delegated or read
		// anywhere else still fails open through renderedDataReadsFlatStateProperty.
		for (const declaration of source.content.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{/gu)) {
			const objectName = declaration[1];
			const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
			const closeBrace = matchingJavaScriptBrace(source.content, openBrace);
			if (!objectName || openBrace < 0 || closeBrace < 0) continue;
			const objectBody = source.content.slice(openBrace + 1, closeBrace);
			for (const entry of objectBody.matchAll(
				/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*(?:document\s*\.\s*)?(?:getElementById|querySelector)\(\s*(['"`])#?([^'"`$]+)\2\s*\)/gu,
			)) {
				const objectProperty = entry[1];
				const id = entry[3];
				if (!objectProperty || !id || !selectHasAlternativeOption(html, id)) continue;
				const escapedObject = objectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const escapedObjectProperty = objectProperty.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
				const handlerPattern = new RegExp(
					String.raw`\b${escapedObject}\s*\.\s*${escapedObjectProperty}\s*\.\s*on(?:change|input)\s*=\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{`,
					"gu",
				);
				for (const handler of source.content.matchAll(handlerPattern)) {
					const eventVariable = handler[1];
					const handlerBrace = (handler.index ?? 0) + handler[0].lastIndexOf("{");
					const handlerEnd = matchingJavaScriptBrace(source.content, handlerBrace);
					if (!eventVariable || handlerBrace < 0 || handlerEnd < 0) continue;
					const body = source.content.slice(handlerBrace + 1, handlerEnd);
					const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					const assignment = new RegExp(
						String.raw`\bstate\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*${escapedEvent}\s*\.\s*target\s*\.\s*value\b`,
						"u",
					).exec(body);
					const property = assignment?.[1];
					if (property) {
						assignments.push({
							id,
							property,
							index: handlerBrace + 1 + (assignment?.index ?? 0),
						});
					}
				}
			}
		}
		const directBindingPattern =
			/\b(?:document\s*\.\s*)?getElementById\(\s*(['"`])([^'"`$]+)\1\s*\)\s*\.\s*addEventListener\(\s*(['"`])change\3\s*,\s*(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>\s*\{([\s\S]{0,1536}?)\}\s*\)/gu;
		for (const binding of source.content.matchAll(directBindingPattern)) {
			const id = binding[2];
			const eventVariable = binding[4];
			const body = binding[5] ?? "";
			if (!id || !eventVariable || !selectIdExists(html, id)) continue;
			const escapedEvent = eventVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const assignment = new RegExp(
				String.raw`\bstate\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*${escapedEvent}\s*\.\s*target\s*\.\s*value\b`,
				"u",
			).exec(body);
			const property = assignment?.[1];
			if (property) assignments.push({ id, property, index: binding.index ?? 0 });
		}

		const sharedBindingPattern =
			/\b([A-Za-z_$][\w$]*)\s*\.\s*addEventListener\(\s*(['"`])change\2\s*,[\s\S]{0,256}?\{([\s\S]{0,4096}?)\}\s*\)/gu;
		for (const binding of source.content.matchAll(sharedBindingPattern)) {
			const selectVariable = binding[1];
			const body = binding[3] ?? "";
			if (!selectVariable) continue;
			const escapedSelect = selectVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const idVariable = new RegExp(
				String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*${escapedSelect}\s*\.\s*id\b`,
				"u",
			).exec(body)?.[1];
			if (!idVariable) continue;
			const escapedIdVariable = idVariable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const branchPattern = new RegExp(
				String.raw`(?:if|else\s+if)\s*\(\s*${escapedIdVariable}\s*={2,3}\s*(['"\x60])([^'"\x60$]+)\1\s*\)\s*state\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*${escapedSelect}\s*\.\s*value\b`,
				"gu",
			);
			for (const branch of body.matchAll(branchPattern)) {
				const id = branch[2];
				const property = branch[3];
				if (!id || !property || !selectIdExists(html, id)) continue;
				assignments.push({
					id,
					property,
					index: (binding.index ?? 0) + binding[0].indexOf(body) + (branch.index ?? 0),
				});
			}
		}

		// Keep a narrow fallback for compact/generated handlers whose nested arrow
		// syntax is difficult to delimit without a JavaScript parser. The control id,
		// change binding, flat state assignment, and selected value must all be
		// explicit in the same short source window.
		for (const select of html.matchAll(/<select\b([^>]*)>[\s\S]*?<\/select>/giu)) {
			const id = attributeValue(select[1] ?? "", "id");
			if (!id) continue;
			const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const direct = new RegExp(
				String.raw`(?:document\s*\.\s*)?getElementById\(\s*(['"\x60])${escapedId}\1\s*\)\s*\.\s*addEventListener\(\s*(['"\x60])change\2[\s\S]{0,768}?\bstate\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*target\s*\.\s*value\b`,
				"u",
			).exec(source.content);
			const branch = new RegExp(
				String.raw`(?:if|else\s+if)\s*\(\s*[A-Za-z_$][\w$]*\s*={2,3}\s*(['"\x60])${escapedId}\1\s*\)\s*state\s*\.\s*([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\s*\.\s*value\b`,
				"u",
			).exec(source.content);
			const property = direct?.[3] ?? branch?.[2];
			const index = direct?.index ?? branch?.index;
			if (!property || index === undefined) continue;
			if (!assignments.some((candidate) => candidate.id === id && candidate.property === property)) {
				assignments.push({ id, property, index });
			}
		}

		for (const assignment of assignments) {
			if (renderedDataReadsFlatStateProperty(combined, assignment.property)) continue;
			errors.push(
				`static.filter_value_unused: Select #${assignment.id} writes state.${assignment.property}, but rendered-data code never reads that filter property. Evidence: ${evidenceAt(source, assignment.index)}`,
			);
		}
	}
	return unique(errors);
}

function renderedDataReadsFlatStateProperty(source: string, property: string): boolean {
	const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const qualifiedProperty = String.raw`\bstate\s*\.\s*${escapedProperty}\b`;
	const scrubbed = withoutAdvisoryCalls(source)
		.replace(new RegExp(String.raw`[^;\r\n]*\.\s*value\s*=\s*${qualifiedProperty}\s*;?`, "giu"), "")
		.replace(new RegExp(String.raw`${qualifiedProperty}\s*=(?!=)\s*[^;\r\n]+;?`, "giu"), "");
	return new RegExp(qualifiedProperty, "iu").test(scrubbed);
}

function selectHasAlternativeOption(html: string, id: string): boolean {
	for (const select of html.matchAll(SELECT_TAG_PATTERN)) {
		if (attributeValue(select[1] ?? "", "id") !== id) continue;
		return enabledStaticSelectOptionCount(select[0]) >= 2;
	}
	return false;
}

function withoutAdvisoryCalls(source: string): string {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const call of source.matchAll(/\b(?:console\s*\.\s*(?:log|info|warn|debug)|(?:window\s*\.\s*)?alert)\s*\(/gu)) {
		const start = call.index ?? 0;
		const openParenthesis = start + call[0].lastIndexOf("(");
		const closeParenthesis = matchingJavaScriptDelimiter(source, openParenthesis, "(", ")");
		if (closeParenthesis < 0) continue;
		const end = source[closeParenthesis + 1] === ";" ? closeParenthesis + 2 : closeParenthesis + 1;
		ranges.push({ start, end });
	}
	let result = source;
	for (const range of ranges.sort((left, right) => right.start - left.start)) {
		result = `${result.slice(0, range.start)}${result.slice(range.end)}`;
	}
	return result;
}

function declaredFunctionBodies(source: string): Array<{ name: string; body: string; index: number }> {
	const functions: Array<{ name: string; body: string; index: number }> = [];
	const declarations = [
		...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gu),
		...source.matchAll(
			/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/gu,
		),
	].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
	for (const declaration of declarations) {
		const name = declaration[1];
		const openBrace = (declaration.index ?? 0) + declaration[0].lastIndexOf("{");
		if (!name || openBrace < 0) continue;
		const closeBrace = matchingJavaScriptBrace(source, openBrace);
		if (closeBrace < 0) continue;
		functions.push({ name, body: source.slice(openBrace + 1, closeBrace), index: declaration.index ?? 0 });
	}
	return functions;
}

function matchingJavaScriptBrace(source: string, openBrace: number): number {
	return matchingJavaScriptDelimiter(source, openBrace, "{", "}");
}

function matchingJavaScriptDelimiter(source: string, openIndex: number, open: string, close: string): number {
	let depth = 0;
	for (let index = openIndex; index < source.length; index += 1) {
		const current = source[index];
		const next = source[index + 1];
		if (current === "/" && next === "/") {
			const newline = source.indexOf("\n", index + 2);
			if (newline < 0) return -1;
			index = newline;
			continue;
		}
		if (current === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) return -1;
			index = end + 1;
			continue;
		}
		if (current === "'" || current === '"' || current === "`") {
			const quote = current;
			for (index += 1; index < source.length; index += 1) {
				if (source[index] === "\\") {
					index += 1;
					continue;
				}
				if (source[index] === quote) break;
			}
			continue;
		}
		if (current === open) depth += 1;
		if (current !== close) continue;
		depth -= 1;
		if (depth === 0) return index;
	}
	return -1;
}

function scriptReferencesId(source: string, id: string): boolean {
	const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const directReference = new RegExp(
		String.raw`(?:getElementById\(\s*['"\x60]${escaped}['"\x60]\s*\)|(?:querySelector|querySelectorAll)\(\s*['"\x60][^'"\x60]*#${escaped}\b)`,
		"u",
	).test(source);
	if (directReference) return true;
	return DYNAMIC_SELECT_ID_HANDLER_PATTERN.test(source) && new RegExp(String.raw`\b${escaped}\b`, "u").test(source);
}

function extractHtmlIds(html: string): Set<string> {
	const ids = new Set<string>();
	for (const match of html.matchAll(ID_ATTRIBUTE_PATTERN)) {
		const id = match[2]?.trim();
		if (id) ids.add(id);
	}
	return ids;
}

function readLocalScripts(guard: WorkspacePathGuard, html: string, errors: string[]): LocalScript[] {
	const scripts: LocalScript[] = [];
	for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
		const src = staticHtmlAttributeValue(match[1] ?? "", "src");
		const reference = classifyStaticResourceReference(src);
		if (!src || reference?.kind !== "local") continue;
		try {
			const authorized = guard.authorizeExisting(reference.relativePath, "file");
			scripts.push({
				src: authorized.relativePath.replace(/\\/g, "/"),
				path: authorized.absolutePath,
				content: readFileSync(authorized.absolutePath, "utf8"),
			});
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			errors.push(`Local script ${src} could not be authorized by the static quality gate.`);
		}
	}
	return scripts;
}

function authorizeLinkedResources(guard: WorkspacePathGuard, html: string, errors: string[]): string[] {
	const checked: string[] = [];
	for (const match of html.matchAll(/<(link|img|source|video|audio|track)\b[^>]*>/gi)) {
		const tag = match[0];
		const value = staticHtmlAttributeValue(tag, /\blink\b/i.test(match[1] ?? "") ? "href" : "src");
		const reference = classifyStaticResourceReference(value);
		if (!value || reference?.kind !== "local") continue;
		try {
			checked.push(guard.authorizeExisting(reference.relativePath, "file").relativePath.replace(/\\/g, "/"));
		} catch (error) {
			if (!(error instanceof WorkspacePathAuthorizationError)) throw error;
			errors.push(`Local asset ${value} could not be authorized by the static quality gate.`);
		}
	}
	return checked;
}

function collectReferencedIds(scripts: LocalScript[], html: string): Map<string, string[]> {
	const ids = new Map<string, string[]>();
	const inlineScripts = [...html.matchAll(SCRIPT_BLOCK_PATTERN)]
		.filter((match) => !staticHtmlAttributeValue(match[1] ?? "", "src"))
		.map((match, index) => ({ src: `index.html#inline-script-${index + 1}`, content: match[2] ?? "" }));
	for (const script of [...scripts, ...inlineScripts]) {
		for (const id of extractReferencedIds(script.content)) {
			const files = ids.get(id) ?? [];
			if (!files.includes(script.src)) files.push(script.src);
			ids.set(id, files);
		}
	}
	return ids;
}

function extractReferencedIds(source: string): Set<string> {
	const ids = new Set<string>();
	for (const match of source.matchAll(GET_ELEMENT_BY_ID_PATTERN)) {
		const id = match[2]?.trim();
		if (id) ids.add(id);
	}
	for (const match of source.matchAll(QUERY_SELECTOR_PATTERN)) {
		const selector = match[2] ?? "";
		for (const id of idsFromSelector(selector)) ids.add(id);
	}
	for (const match of source.matchAll(DOLLAR_SELECTOR_PATTERN)) {
		const selector = match[2] ?? "";
		for (const id of idsFromSelector(selector)) ids.add(id);
	}
	return ids;
}

function idsFromSelector(selector: string): string[] {
	const ids: string[] = [];
	for (const part of selector.split(",")) {
		const match = part.trim().match(/^#([A-Za-z][\w:.-]*)\b/);
		if (match?.[1]) ids.push(match[1]);
	}
	return ids;
}

function visibleLoadingIds(html: string): string[] {
	const ids: string[] = [];
	for (const element of htmlElements(html)) {
		if (!element.id || !/\bloading\b/i.test(element.className)) continue;
		if (isHiddenByDefault(element.className, element.style)) continue;
		ids.push(element.id);
	}
	return unique(ids);
}

function metricPlaceholderIds(html: string): string[] {
	const ids: string[] = [];
	for (const element of htmlElements(html)) {
		if (!element.id || !element.text.includes("--")) continue;
		const signal = `${element.id} ${element.className}`;
		if (!/(kpi|metric|value|yield|count|output|loss|updated)/i.test(signal)) continue;
		ids.push(element.id);
	}
	return unique(ids);
}

function htmlElements(html: string): Array<{ id: string; className: string; style: string; text: string }> {
	const elements: Array<{ id: string; className: string; style: string; text: string }> = [];
	for (const match of html.matchAll(OPEN_TAG_PATTERN)) {
		const tag = match[1] ?? "";
		const attrs = match[2] ?? "";
		const id = attributeValue(attrs, "id");
		if (!id) continue;
		const contentStart = (match.index ?? 0) + match[0].length;
		const closeIndex = html.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, contentStart);
		const inner = closeIndex >= 0 ? html.slice(contentStart, closeIndex) : "";
		elements.push({
			id,
			className: attributeValue(attrs, "class"),
			style: attributeValue(attrs, "style"),
			text: stripTags(inner).trim(),
		});
	}
	return elements;
}

function attributeValue(attrs: string, name: "id" | "class" | "style"): string {
	const pattern =
		name === "id" ? ID_ATTRIBUTE_PATTERN : name === "class" ? CLASS_ATTRIBUTE_PATTERN : STYLE_ATTRIBUTE_PATTERN;
	pattern.lastIndex = 0;
	const match = pattern.exec(attrs);
	return match?.[2]?.trim() ?? "";
}

function isHiddenByDefault(className: string, style: string): boolean {
	return (
		/\b(d-none|hidden|visually-hidden|sr-only)\b/i.test(className) ||
		/display\s*:\s*none/i.test(style) ||
		/visibility\s*:\s*hidden/i.test(style)
	);
}

function externalResourceWarnings(html: string): string[] {
	const warnings: string[] = [];
	for (const match of html.matchAll(SCRIPT_TAG_PATTERN)) {
		const src = staticHtmlAttributeValue(match[1] ?? "", "src");
		if (classifyStaticResourceReference(src)?.kind === "external") {
			warnings.push(`External script ${src} should have a local fallback.`);
		}
	}
	for (const match of html.matchAll(LINK_TAG_PATTERN)) {
		const href = staticHtmlAttributeValue(match[1] ?? "", "href");
		if (classifyStaticResourceReference(href)?.kind === "external") {
			warnings.push(`External stylesheet ${href} should have a local fallback.`);
		}
	}
	return warnings;
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function relativeCheckedPath(root: string, file: string): string {
	const relative = normalize(file)
		.slice(normalize(root).length)
		.replace(/^[/\\]+/, "");
	return relative || file;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
