import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker.js?worker";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker.js?worker";
import "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker.js?worker";
import "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker.js?worker";
import "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker.js?worker";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";
import { MONACO_FILE_PREVIEW_DARK_THEME, MONACO_FILE_PREVIEW_LIGHT_THEME } from "./monaco-theme-state.js";

type MonacoWorkerLabel = "css" | "html" | "json" | "javascript" | "typescript" | string;

const globalScope = globalThis as typeof globalThis & {
	MonacoEnvironment?: {
		getWorker: (_moduleId: string, label: MonacoWorkerLabel) => Worker;
	};
};

globalScope.MonacoEnvironment = {
	getWorker(_moduleId: string, label: MonacoWorkerLabel): Worker {
		if (label === "json") return new JsonWorker();
		if (label === "css" || label === "scss" || label === "less") return new CssWorker();
		if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
		if (label === "typescript" || label === "javascript") return new TsWorker();
		return new EditorWorker();
	},
};

monaco.editor.defineTheme(MONACO_FILE_PREVIEW_LIGHT_THEME, {
	base: "vs",
	inherit: true,
	rules: [],
	colors: {
		"editor.background": "#00000000",
		"editor.lineHighlightBackground": "#006DFF0F",
		"editorLineNumber.foreground": "#7E8CAD",
		"editorLineNumber.activeForeground": "#006DFF",
		"scrollbarSlider.background": "#7E8CAD33",
		"scrollbarSlider.hoverBackground": "#7E8CAD55",
		"scrollbarSlider.activeBackground": "#7E8CAD77",
	},
});

monaco.editor.defineTheme(MONACO_FILE_PREVIEW_DARK_THEME, {
	base: "vs-dark",
	inherit: true,
	rules: [
		{ token: "", foreground: "EAF2FF" },
		{ token: "comment", foreground: "7F92B2", fontStyle: "italic" },
		{ token: "delimiter", foreground: "B8C7E6" },
		{ token: "number", foreground: "9CDCFE" },
		{ token: "string", foreground: "D7BA7D" },
		{ token: "type", foreground: "4EC9B0" },
		{ token: "keyword", foreground: "C586C0" },
		{ token: "tag", foreground: "7DD3FC" },
		{ token: "attribute.name", foreground: "F8C471" },
		{ token: "attribute.value", foreground: "D7BA7D" },
		{ token: "metatag", foreground: "9FB5DF" },
		{ token: "variable", foreground: "EAF2FF" },
		{ token: "variable.css", foreground: "BEE3F8" },
		{ token: "property", foreground: "9CDCFE" },
	],
	colors: {
		"editor.background": "#00000000",
		"editor.foreground": "#EAF2FF",
		"editor.lineHighlightBackground": "#3F7BFF18",
		"editor.selectionBackground": "#3F7BFF55",
		"editor.inactiveSelectionBackground": "#3F7BFF2E",
		"editorCursor.foreground": "#EAF2FF",
		"editorLineNumber.foreground": "#8FA6CE",
		"editorLineNumber.activeForeground": "#D7E6FF",
		"scrollbarSlider.background": "#8FA6CE33",
		"scrollbarSlider.hoverBackground": "#8FA6CE55",
		"scrollbarSlider.activeBackground": "#8FA6CE77",
	},
});

export { monaco };
