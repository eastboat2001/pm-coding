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
const CHART_SIZE_SELECTOR_PATTERN = /(?:chart|canvas|graph|plot|visuali[sz]ation)/iu;
const BOUNDED_CHART_SIZE_PATTERN =
	/(?:height|max-height|aspect-ratio)\s*:\s*(?!(?:auto|inherit|initial|unset|100%)\b)(?:clamp\(|min\(|max\(|\d+(?:\.\d+)?(?:px|rem|em|vh|vw)\b)/iu;
const POSITION_RELATIVE_PATTERN = /\bposition\s*:\s*relative\b/iu;
const CANVAS_HEIGHT_ATTRIBUTE_PATTERN = /\bheight\s*=\s*(?:['"]?)(\d+)(?:['"]?)/iu;
const BOUNDED_INLINE_CANVAS_WRAPPER_PATTERN =
	/<[^>]+\bstyle\s*=\s*(['"])(?=[^>]*\bposition\s*:\s*relative\b)(?=[^>]*(?:height|max-height|aspect-ratio)\s*:\s*(?:clamp\(|min\(|max\(|\d+(?:\.\d+)?(?:px|rem|em|vh|vw)\b))[^>]*\1[^>]*>\s*<canvas\b/iu;
const SELECT_TAG_PATTERN = /<select\b([^>]*)>[\s\S]*?<\/select>/giu;
const GENERIC_SELECT_VALUE_HANDLER_PATTERN =
	/(?:querySelectorAll|getElementsByTagName)\(\s*(['"`])select\1\s*\)[\s\S]{0,2048}(?:\.value\b|target\s*\.\s*value\b)/u;
const DYNAMIC_SELECT_ID_HANDLER_PATTERN =
	/\bgetElementById\(\s*[A-Za-z_$][\w$]*\s*\)[\s\S]{0,2048}\baddEventListener\(\s*(['"`])change\1[\s\S]{0,1024}(?:target\s*\.\s*value\b|\.value\b)/u;
const RANDOM_RENDERED_DATA_PATTERN = /\bdata\s*:\s*[\s\S]{0,256}\bMath\.random\s*\(/u;
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
	errors.push(...unwiredSelectErrors(html, scriptSource));
	errors.push(...windowNamedElementChartErrors(htmlIds, scriptSource));
	if (RANDOM_RENDERED_DATA_PATTERN.test(scriptSource)) {
		errors.push("Rendered chart or application data uses Math.random(); interactive results must be deterministic.");
	}
	errors.push(...chartLayoutErrors(html, scripts, stylesheets));
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
	foreground?: CssColor;
	background?: CssColor;
}> {
	const rules: Array<{
		selector: string;
		specificity: number;
		order: number;
		foreground?: CssColor;
		background?: CssColor;
	}> = [];
	let order = 0;
	for (const match of source.matchAll(CSS_RULE_PATTERN)) {
		const declarations = match[2] ?? "";
		const foreground = declarationColor(declarations, "color");
		const background = declarationColor(declarations, "background-color") ?? declarationColor(declarations, "background");
		if (!foreground && !background) continue;
		for (const selector of (match[1] ?? "").split(",").map((value) => value.trim())) {
			if (!selector || /[:>+~\s]/u.test(selector)) continue;
			rules.push({ selector, specificity: selectorSpecificity(selector), order: order++, foreground, background });
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
	let foreground: { color: CssColor; specificity: number; order: number } | undefined;
	let background: { color: CssColor; specificity: number; order: number } | undefined;
	for (const rule of rules) {
		if (!simpleCssSelectorMatches(element, rule.selector)) continue;
		if (rule.foreground && winsCascade(foreground, rule.specificity, rule.order)) {
			foreground = { color: rule.foreground, specificity: rule.specificity, order: rule.order };
		}
		if (rule.background && winsCascade(background, rule.specificity, rule.order)) {
			background = { color: rule.background, specificity: rule.specificity, order: rule.order };
		}
	}
	const inlineForeground = declarationColor(element.style, "color");
	const inlineBackground = declarationColor(element.style, "background-color") ?? declarationColor(element.style, "background");
	return {
		foreground: inlineForeground ?? foreground?.color,
		background: inlineBackground ?? background?.color,
	};
}

function winsCascade(
	current: { specificity: number; order: number } | undefined,
	specificity: number,
	order: number,
): boolean {
	return !current || specificity > current.specificity || (specificity === current.specificity && order >= current.order);
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

function declarationColor(declarations: string, property: "color" | "background" | "background-color"): CssColor | undefined {
	const matches = [...declarations.matchAll(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;!]+)(?:!important)?`, "giu"))];
	const value = matches.at(-1)?.[1]?.trim();
	if (!value) return undefined;
	const token = value.match(/(?:#[\da-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black|transparent)\b)/iu)?.[0];
	return token ? parseCssColor(token) : undefined;
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
	const rgb = normalized.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/u);
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
	return attrs.match(new RegExp(`\\b${escaped}\\s*=\\s*(['\"])(.*?)\\1`, "iu"))?.[2]?.trim() ?? "";
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

function chartLayoutErrors(html: string, scripts: LocalScript[], stylesheets: LocalStylesheet[]): string[] {
	const scriptSource = combinedScriptSource(html, scripts);
	if (
		!CHART_CONSTRUCTOR_PATTERN.test(scriptSource) ||
		!DISABLED_CHART_ASPECT_RATIO_PATTERN.test(scriptSource) ||
		![...html.matchAll(CANVAS_TAG_PATTERN)].length
	) {
		return [];
	}

	const styleSource = [
		...[...html.matchAll(STYLE_TAG_PATTERN)].map((match) => match[1] ?? ""),
		...stylesheets.map((stylesheet) => stylesheet.content),
	].join("\n");
	for (const match of styleSource.matchAll(CSS_RULE_PATTERN)) {
		if (!CHART_SIZE_SELECTOR_PATTERN.test(match[1] ?? "")) continue;
		const declarations = match[2] ?? "";
		if (POSITION_RELATIVE_PATTERN.test(declarations) && BOUNDED_CHART_SIZE_PATTERN.test(declarations)) return [];
	}

	const canvases = [...html.matchAll(CANVAS_TAG_PATTERN)];
	if (BOUNDED_INLINE_CANVAS_WRAPPER_PATTERN.test(html)) return [];
	if (canvases.every((match) => Number(CANVAS_HEIGHT_ATTRIBUTE_PATTERN.exec(match[1] ?? "")?.[1]) > 0)) return [];
	const canvasIds = canvases
		.map((match) => attributeValue(match[1] ?? "", "id"))
		.filter(Boolean)
		.map((id) => `#${id}`);
	const affected = canvasIds.length > 0 ? ` Affected canvases: ${canvasIds.join(", ")}.` : "";

	return [
		`Chart.js uses maintainAspectRatio:false without a bounded chart or canvas height. Wrap each canvas in a dedicated position:relative chart container with an explicit responsive height or max-height to prevent runaway page growth.${affected}`,
	];
}

function combinedScriptSource(html: string, scripts: LocalScript[]): string {
	const inlineScripts = [...html.matchAll(SCRIPT_BLOCK_PATTERN)]
		.filter((match) => !staticHtmlAttributeValue(match[1] ?? "", "src"))
		.map((match) => match[2] ?? "");
	return [...scripts.map((script) => script.content), ...inlineScripts].join("\n");
}

function unwiredSelectErrors(html: string, scriptSource: string): string[] {
	if (GENERIC_SELECT_VALUE_HANDLER_PATTERN.test(scriptSource)) return [];
	const errors: string[] = [];
	for (const match of html.matchAll(SELECT_TAG_PATTERN)) {
		const id = attributeValue(match[1] ?? "", "id");
		if (!id || scriptReferencesId(scriptSource, id)) continue;
		errors.push(`Select control #${id} is never referenced by local JavaScript and cannot affect rendered data.`);
	}
	return errors;
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
