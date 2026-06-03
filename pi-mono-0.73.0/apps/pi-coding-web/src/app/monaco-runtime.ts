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

monaco.editor.defineTheme("pi-file-preview", {
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

export { monaco };
