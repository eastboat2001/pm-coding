import { existsSync, readFileSync } from "node:fs";
import { join, normalize } from "node:path";

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

const ID_ATTRIBUTE_PATTERN = /\bid\s*=\s*(['"])([^'"]+)\1/g;
const CLASS_ATTRIBUTE_PATTERN = /\bclass\s*=\s*(['"])([^'"]*)\1/;
const STYLE_ATTRIBUTE_PATTERN = /\bstyle\s*=\s*(['"])([^'"]*)\1/;
const SCRIPT_SRC_PATTERN = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
const LINK_HREF_PATTERN = /<link\b[^>]*\bhref\s*=\s*(['"])([^'"]+)\1[^>]*>/gi;
const OPEN_TAG_PATTERN = /<([a-z][\w:-]*)\b([^>]*)>/gi;
const GET_ELEMENT_BY_ID_PATTERN = /\bdocument\.getElementById\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const QUERY_SELECTOR_PATTERN = /\b(?:document\.)?(?:querySelector|querySelectorAll)\(\s*(['"`])([^'"`$]+)\1\s*\)/g;
const DOLLAR_SELECTOR_PATTERN = /\$\(\s*(['"`])([^'"`$]+)\1\s*\)/g;

export function assessStaticPreviewQuality(input: StaticPreviewQualityGateInput): StaticPreviewQualityGateResult {
	const indexPath = input.indexFile ? join(input.serveRoot, input.indexFile) : join(input.serveRoot, "index.html");
	const errors: string[] = [];
	const warnings: string[] = [];
	const checkedFiles: string[] = [];

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
	const scripts = readLocalScripts(input.serveRoot, html, warnings);
	checkedFiles.push(...scripts.map((script) => script.src));
	const referencedIds = collectReferencedIds(scripts);

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

	warnings.push(...externalResourceWarnings(html));

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		checkedFiles,
	};
}

function extractHtmlIds(html: string): Set<string> {
	const ids = new Set<string>();
	for (const match of html.matchAll(ID_ATTRIBUTE_PATTERN)) {
		const id = match[2]?.trim();
		if (id) ids.add(id);
	}
	return ids;
}

function readLocalScripts(serveRoot: string, html: string, warnings: string[]): LocalScript[] {
	const scripts: LocalScript[] = [];
	for (const match of html.matchAll(SCRIPT_SRC_PATTERN)) {
		const src = match[2]?.trim();
		if (!src || isExternalResource(src) || src.startsWith("/") || src.startsWith("data:")) continue;
		const scriptPath = normalize(join(serveRoot, src));
		if (!pathIsInside(serveRoot, scriptPath) || !existsSync(scriptPath)) {
			warnings.push(`Local script ${src} could not be read by the static quality gate.`);
			continue;
		}
		scripts.push({
			src,
			path: scriptPath,
			content: readFileSync(scriptPath, "utf8"),
		});
	}
	return scripts;
}

function collectReferencedIds(scripts: LocalScript[]): Map<string, string[]> {
	const ids = new Map<string, string[]>();
	for (const script of scripts) {
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
	for (const match of html.matchAll(SCRIPT_SRC_PATTERN)) {
		const src = match[2]?.trim();
		if (src && isExternalResource(src)) warnings.push(`External script ${src} should have a local fallback.`);
	}
	for (const match of html.matchAll(LINK_HREF_PATTERN)) {
		const href = match[2]?.trim();
		if (href && isExternalResource(href)) warnings.push(`External stylesheet ${href} should have a local fallback.`);
	}
	return warnings;
}

function stripTags(value: string): string {
	return value.replace(/<[^>]+>/g, " ");
}

function isExternalResource(value: string): boolean {
	return /^https?:\/\//i.test(value) || value.startsWith("//");
}

function pathIsInside(root: string, target: string): boolean {
	const normalizedRoot = normalize(root);
	const normalizedTarget = normalize(target);
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
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
