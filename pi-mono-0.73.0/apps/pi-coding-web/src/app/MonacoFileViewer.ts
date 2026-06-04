import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { loadMonaco } from "./monaco-loader.js";
import { replaceMonacoEditorModel } from "./monaco-model-state.js";
import { MONACO_FILE_PREVIEW_LIGHT_THEME, monacoThemeForRoot } from "./monaco-theme-state.js";

type Monaco = Awaited<ReturnType<typeof loadMonaco>>;
type MonacoEditor = ReturnType<Monaco["editor"]["create"]>;
type MonacoModel = ReturnType<Monaco["editor"]["createModel"]>;

@customElement("pi-monaco-file-viewer")
export class MonacoFileViewer extends LitElement {
	@property({ type: String }) filename = "";
	@property({ type: String }) language = "plaintext";
	@property({ type: String }) content = "";
	@property({ type: Boolean }) readOnly = true;
	@property({ type: Number }) revision = 0;

	@state() private loading = true;
	@state() private error = "";

	private monaco: Monaco | undefined;
	private editor: MonacoEditor | undefined;
	private model: MonacoModel | undefined;
	private modelKey = "";
	private resizeObserver: ResizeObserver | undefined;
	private themeObserver: MutationObserver | undefined;
	private themeName = MONACO_FILE_PREVIEW_LIGHT_THEME;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.syncTheme();
		this.observeThemeChanges();
		void this.ensureEditor();
	}

	override updated(changed: Map<string, unknown>): void {
		if (
			changed.has("filename") ||
			changed.has("language") ||
			changed.has("content") ||
			changed.has("readOnly") ||
			changed.has("revision")
		) {
			void this.ensureEditor();
		}
	}

	override disconnectedCallback(): void {
		this.resizeObserver?.disconnect();
		this.themeObserver?.disconnect();
		this.editor?.dispose();
		this.model?.dispose();
		this.resizeObserver = undefined;
		this.themeObserver = undefined;
		this.editor = undefined;
		this.model = undefined;
		super.disconnectedCallback();
	}

	override render(): TemplateResult {
		return html`
			<div class="monaco-file-viewer">
				<div class="monaco-file-viewer__editor" aria-label=${this.filename || "File content"}></div>
				${this.loading ? html`<div class="monaco-file-viewer__overlay">Loading editor...</div>` : ""}
				${this.error ? html`<div class="monaco-file-viewer__overlay monaco-file-viewer__overlay--error">${this.error}</div>` : ""}
			</div>
		`;
	}

	getValue(): string {
		return this.editor?.getValue() ?? this.content;
	}

	private async ensureEditor(): Promise<void> {
		const container = this.querySelector<HTMLElement>(".monaco-file-viewer__editor");
		if (!container) return;
		try {
			if (!this.monaco) {
				this.loading = true;
				this.monaco = await loadMonaco();
			}
			if (!this.editor) {
				this.editor = this.monaco.editor.create(container, {
					automaticLayout: true,
					fontFamily:
						'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
					fontSize: 12,
					lineHeight: 20,
					lineNumbers: "on",
					minimap: { enabled: false },
					overviewRulerBorder: false,
					padding: { top: 12, bottom: 12 },
					readOnly: this.readOnly,
					renderLineHighlight: "all",
					scrollBeyondLastLine: false,
					theme: this.themeName,
					wordWrap: "off",
				});
				this.resizeObserver = new ResizeObserver(() => this.editor?.layout());
				this.resizeObserver.observe(container);
			}
			this.editor.updateOptions({ readOnly: this.readOnly });
			this.syncModel();
			this.loading = false;
			this.error = "";
		} catch (error) {
			this.loading = false;
			this.error = error instanceof Error ? error.message : String(error);
		}
	}

	private observeThemeChanges(): void {
		this.themeObserver?.disconnect();
		this.themeObserver = new MutationObserver(() => this.syncTheme());
		this.themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
	}

	private syncTheme(): void {
		this.themeName = monacoThemeForRoot();
		this.monaco?.editor.setTheme(this.themeName);
	}

	private syncModel(): void {
		if (!this.monaco || !this.editor) return;
		const modelKey = `${this.filename}\n${this.language}\n${this.revision}\n${this.content}`;
		if (this.modelKey === modelKey) return;
		const uriPath = this.filename
			.split("/")
			.filter(Boolean)
			.map((part) => encodeURIComponent(part))
			.join("/");
		const model = replaceMonacoEditorModel({
			registry: this.monaco.editor,
			editor: this.editor,
			currentModel: this.model || null,
			content: this.content,
			language: this.language || "plaintext",
			uri: this.monaco.Uri.parse(`pi-project:///${uriPath || "untitled.txt"}`),
		});
		this.model = model;
		this.modelKey = modelKey;
	}
}
