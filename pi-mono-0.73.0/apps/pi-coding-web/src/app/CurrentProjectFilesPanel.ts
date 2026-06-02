import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	File,
	FileCode,
	FileText,
	Folder,
	RefreshCw,
	Search,
	X,
} from "lucide";
import {
	buildCurrentProjectFileTree,
	filterCurrentProjectFiles,
	type CurrentProjectFilePreview,
	type CurrentProjectFilesResult,
	type CurrentProjectFileTreeNode,
	loadCurrentProjectFilePreview,
	loadCurrentProjectFiles,
} from "./current-project-files-state.js";

@customElement("pi-current-project-files-panel")
export class CurrentProjectFilesPanel extends LitElement {
	@property({ type: String }) sessionId = "";
	@property({ type: String }) title = "";
	@property({ type: String }) selectedFilename = "";

	@state() private project: CurrentProjectFilesResult | null = null;
	@state() private loading = false;
	@state() private error = "";
	@state() private query = "";
	@state() private collapsedDirectories = new Set<string>();

	private lastLoadKey = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.refresh();
	}

	override updated(changed: Map<string, unknown>): void {
		if (changed.has("sessionId") || changed.has("title")) {
			void this.refresh();
		}
	}

	async refresh(): Promise<void> {
		const loadKey = `${this.sessionId}\n${this.title}`;
		if (this.loading || (!this.sessionId && this.lastLoadKey === loadKey)) return;
		this.lastLoadKey = loadKey;
		if (!this.sessionId) {
			this.project = null;
			this.error = "";
			return;
		}
		this.loading = true;
		this.error = "";
		try {
			this.project = await loadCurrentProjectFiles({ sessionId: this.sessionId, title: this.title });
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
		}
	}

	override render(): TemplateResult {
		const files = this.project?.files || [];
		const visibleFiles = filterCurrentProjectFiles(files, this.query);
		const tree = buildCurrentProjectFileTree(visibleFiles, this.project?.title || this.title || t("Current Project"));
		return html`
			<div class="current-project-files-panel">
				<header class="current-project-files-panel__header">
					<div class="current-project-files-panel__header-top">
						<div>
							<h2>${t("Current Project Files")}</h2>
							<div class="current-project-files-panel__count">
								${this.loading ? t("Loading...") : countLabel(visibleFiles.length, files.length, this.query)}
							</div>
						</div>
						<button
							type="button"
							class="current-project-files-panel__header-button"
							@click=${() => void this.refresh()}
							title=${t("Refresh")}
							aria-label=${t("Refresh")}
						>
							<span class=${this.loading ? "current-project-files-panel__spin" : ""}>${icon(RefreshCw, "sm")}</span>
						</button>
					</div>
					<label class="current-project-files-panel__search">
						<span>${icon(Search, "sm")}</span>
						<input
							type="search"
							.value=${this.query}
							placeholder=${t("Search files")}
							aria-label=${t("Search files")}
							@input=${(event: Event) => {
								this.query = (event.target as HTMLInputElement).value;
							}}
						/>
					</label>
				</header>
				<div class="current-project-files-panel__body">${this.renderBody(files, visibleFiles, tree)}</div>
			</div>
		`;
	}

	private renderBody(
		allFiles: string[],
		visibleFiles: string[],
		tree: CurrentProjectFileTreeNode,
	): TemplateResult {
		if (this.error) {
			return html`
				<div class="current-project-files-panel__state current-project-files-panel__state--error">
					<span>${icon(AlertCircle, "md")}</span>
					<div>
						<div class="current-project-files-panel__state-title">${t("Failed to load project files")}</div>
						<div class="current-project-files-panel__state-text">${this.error}</div>
					</div>
				</div>
			`;
		}
		if (!this.sessionId) {
			return html`
				<div class="current-project-files-panel__state">
					<span>${icon(Folder, "md")}</span>
					<div>
						<div class="current-project-files-panel__state-title">${t("No active session")}</div>
						<div class="current-project-files-panel__state-text">${t("Send a message to create a project workspace.")}</div>
					</div>
				</div>
			`;
		}
		if (!this.loading && allFiles.length === 0) {
			return html`
				<div class="current-project-files-panel__state">
					<span>${icon(Folder, "md")}</span>
					<div>
						<div class="current-project-files-panel__state-title">${t("No project files yet")}</div>
						<div class="current-project-files-panel__state-text">${t("Generated project files will appear here.")}</div>
					</div>
				</div>
			`;
		}
		if (!this.loading && visibleFiles.length === 0) {
			return html`
				<div class="current-project-files-panel__state">
					<span>${icon(Search, "md")}</span>
					<div>
						<div class="current-project-files-panel__state-title">${t("No matching files")}</div>
						<div class="current-project-files-panel__state-text">${t("Try another file name or path.")}</div>
					</div>
				</div>
			`;
		}
		return html`<div class="current-project-file-tree">${this.renderDirectory(tree, 0, true)}</div>`;
	}

	private renderDirectory(node: CurrentProjectFileTreeNode, depth: number, isRoot = false): TemplateResult {
		const key = node.path || "__root__";
		const collapsed = !this.query.trim() && this.collapsedDirectories.has(key);
		return html`
			<div class="current-project-file-tree__group">
				<button
					type="button"
					class=${`current-project-file-tree__row current-project-file-tree__row--directory ${isRoot ? "current-project-file-tree__row--root" : ""}`}
					style=${`--tree-depth: ${depth};`}
					@click=${() => this.toggleDirectory(key)}
					title=${node.path || node.name}
					aria-expanded=${collapsed ? "false" : "true"}
				>
					<span class="current-project-file-tree__chevron">${collapsed ? icon(ChevronRight, "sm") : icon(ChevronDown, "sm")}</span>
					<span class="current-project-file-tree__icon">${icon(Folder, "sm")}</span>
					<span class="current-project-file-tree__name">${node.name}</span>
					<span class="current-project-file-tree__count">${node.fileCount}</span>
				</button>
				${
					collapsed
						? ""
						: html`<div>
								${node.children.map((child) =>
									child.type === "directory"
										? this.renderDirectory(child, depth + 1)
										: this.renderFile(child, depth + 1),
								)}
							</div>`
				}
			</div>
		`;
	}

	private renderFile(node: CurrentProjectFileTreeNode, depth: number): TemplateResult {
		const selected = this.selectedFilename === node.path;
		return html`
			<button
				type="button"
				class=${`current-project-file-tree__row current-project-file-tree__row--file ${selected ? "current-project-file-tree__row--selected" : ""}`}
				style=${`--tree-depth: ${depth};`}
				@click=${() => this.openFile(node.path)}
				title=${node.path}
				aria-pressed=${selected ? "true" : "false"}
			>
				<span class="current-project-file-tree__spacer"></span>
				<span class="current-project-file-tree__icon">${fileIcon(node.extension || "")}</span>
				<span class="current-project-file-tree__name">${node.name}</span>
				${node.extension ? html`<span class="current-project-file-tree__badge">${node.extension}</span>` : ""}
			</button>
		`;
	}

	private toggleDirectory(key: string): void {
		const next = new Set(this.collapsedDirectories);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		this.collapsedDirectories = next;
	}

	private openFile(filename: string): void {
		this.dispatchEvent(
			new CustomEvent("pi-open-current-project-file-preview", {
				bubbles: true,
				composed: true,
				detail: { filename },
			}),
		);
	}
}

@customElement("pi-current-project-file-preview-drawer")
export class CurrentProjectFilePreviewDrawer extends LitElement {
	@property({ type: String }) sessionId = "";
	@property({ type: String }) title = "";
	@property({ type: String }) filename = "";

	@state() private preview: CurrentProjectFilePreview | null = null;
	@state() private loading = false;
	@state() private error = "";

	private lastLoadKey = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.loadPreview();
	}

	override updated(changed: Map<string, unknown>): void {
		if (changed.has("sessionId") || changed.has("title") || changed.has("filename")) {
			void this.loadPreview();
		}
	}

	override render(): TemplateResult {
		return html`
			<aside class="current-project-file-preview-drawer" aria-label=${t("File preview")}>
				<header class="current-project-file-preview-drawer__header">
					<div class="current-project-file-preview-drawer__title" title=${this.filename}>
						<span>${fileIcon(fileExtension(this.filename))}</span>
						<strong>${basename(this.filename) || t("File preview")}</strong>
						<small>${this.filename}</small>
					</div>
					<button
						type="button"
						class="current-project-file-preview-drawer__close"
						@click=${() => this.close()}
						title=${t("Close preview")}
						aria-label=${t("Close preview")}
					>
						${icon(X, "sm")}
					</button>
				</header>
				<div class="current-project-file-preview-drawer__body">${this.renderPreviewBody()}</div>
			</aside>
		`;
	}

	private renderPreviewBody(): TemplateResult {
		if (this.loading) {
			return html`<div class="current-project-file-preview-drawer__state">${t("Loading preview...")}</div>`;
		}
		if (this.error) {
			return html`
				<div class="current-project-file-preview-drawer__state current-project-file-preview-drawer__state--error">
					<span>${icon(AlertCircle, "md")}</span>
					<div>
						<div class="current-project-file-preview-drawer__state-title">${t("Failed to load file")}</div>
						<div class="current-project-file-preview-drawer__state-text">${this.error}</div>
					</div>
				</div>
			`;
		}
		if (!this.preview) {
			return html`<div class="current-project-file-preview-drawer__state">${t("Select a file to preview.")}</div>`;
		}
		if (this.preview.binary) {
			return html`
				<div class="current-project-file-preview-drawer__state">
					<span>${icon(File, "md")}</span>
					<div>
						<div class="current-project-file-preview-drawer__state-title">${t("Binary file")}</div>
						<div class="current-project-file-preview-drawer__state-text">${formatBytes(this.preview.size)}</div>
					</div>
				</div>
			`;
		}
		return html`
			<div class="current-project-file-preview-drawer__meta">
				<span>${this.preview.language || t("text")}</span>
				<span>${formatBytes(this.preview.size)}</span>
				${this.preview.truncated ? html`<span>${t("truncated")}</span>` : ""}
			</div>
			<pre class="current-project-file-preview-drawer__code"><code>${this.preview.content}</code></pre>
		`;
	}

	private async loadPreview(): Promise<void> {
		const loadKey = `${this.sessionId}\n${this.title}\n${this.filename}`;
		if (this.loading || this.lastLoadKey === loadKey) return;
		this.lastLoadKey = loadKey;
		this.preview = null;
		this.error = "";
		if (!this.sessionId || !this.filename) return;
		this.loading = true;
		try {
			this.preview = await loadCurrentProjectFilePreview({
				sessionId: this.sessionId,
				title: this.title,
				filename: this.filename,
			});
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
		}
	}

	private close(): void {
		this.dispatchEvent(new CustomEvent("pi-close-current-project-file-preview", { bubbles: true, composed: true }));
	}
}

function fileIcon(extension: string): TemplateResult {
	const normalized = extension.toLowerCase();
	if (["css", "html", "js", "json", "jsx", "ts", "tsx", "vue"].includes(normalized)) return icon(FileCode, "sm");
	if (["md", "txt"].includes(normalized)) return icon(FileText, "sm");
	return icon(File, "sm");
}

function countLabel(visibleCount: number, totalCount: number, query: string): string {
	if (query.trim()) return `${visibleCount} / ${totalCount} ${t("files")}`;
	return `${totalCount} ${t("files")}`;
}

function basename(path: string): string {
	return path.split("/").pop() || path;
}

function fileExtension(path: string): string {
	return (path.match(/\.([^.]+)$/)?.[1] || "").toUpperCase();
}

function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function t(message: string): string {
	return message;
}
