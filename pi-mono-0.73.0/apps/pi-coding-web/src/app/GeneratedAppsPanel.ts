import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { AlertCircle, Check, Copy, PanelsTopLeft, Pencil, RefreshCw, Search, X } from "lucide";
import {
	filterGeneratedApps,
	type GeneratedAppRecord,
	loadGeneratedApps,
	renameGeneratedApp,
} from "./generated-apps-state.js";

@customElement("pi-generated-apps-panel")
export class GeneratedAppsPanel extends LitElement {
	@state() private projects: GeneratedAppRecord[] = [];
	@state() private loading = false;
	@state() private error = "";
	@state() private copiedProjectId = "";
	@state() private query = "";
	@state() private editingProjectId = "";
	@state() private editingTitle = "";
	@state() private renamingProjectId = "";
	@state() private renameError = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		void this.refresh();
	}

	async refresh(): Promise<void> {
		if (this.loading) return;
		this.loading = true;
		this.error = "";
		try {
			this.projects = await loadGeneratedApps();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.loading = false;
		}
	}

	override render(): TemplateResult {
		const visibleProjects = filterGeneratedApps(this.projects, this.query);
		return html`
			<div class="generated-apps-panel">
				<header class="generated-apps-panel__header">
					<div class="generated-apps-panel__header-top">
						<div>
							<h2>${t("Generated Apps")}</h2>
							<div class="generated-apps-panel__count">
								${this.loading ? t("Loading...") : countLabel(visibleProjects.length, this.projects.length, this.query)}
							</div>
						</div>
						<button
							type="button"
							class="generated-apps-panel__header-button"
							@click=${() => void this.refresh()}
							title=${t("Refresh")}
							aria-label=${t("Refresh")}
						>
							<span class=${this.loading ? "generated-apps-panel__spin" : ""}>${icon(RefreshCw, "sm")}</span>
						</button>
					</div>
					<label class="generated-apps-panel__search">
						<span>${icon(Search, "sm")}</span>
						<input
							type="search"
							.value=${this.query}
							placeholder=${t("Search apps")}
							aria-label=${t("Search apps")}
							@input=${(event: Event) => {
								this.query = (event.target as HTMLInputElement).value;
							}}
						/>
					</label>
				</header>
				<div class="generated-apps-panel__body">
					${this.renderBody(visibleProjects)}
				</div>
				${this.renderRenameDialog()}
			</div>
		`;
	}

	private renderBody(visibleProjects: GeneratedAppRecord[]): TemplateResult {
		if (this.error) {
			return html`
				<div class="generated-apps-panel__state generated-apps-panel__state--error">
					<span>${icon(AlertCircle, "md")}</span>
					<div>
						<div class="generated-apps-panel__state-title">${t("Failed to load generated apps")}</div>
						<div class="generated-apps-panel__state-text">${this.error}</div>
					</div>
				</div>
			`;
		}
		if (!this.loading && this.projects.length === 0) {
			return html`
				<div class="generated-apps-panel__state">
					<span>${icon(PanelsTopLeft, "md")}</span>
					<div>
						<div class="generated-apps-panel__state-title">${t("No generated apps yet")}</div>
						<div class="generated-apps-panel__state-text">${t("Preview a project to make it appear here.")}</div>
					</div>
				</div>
			`;
		}
		if (!this.loading && visibleProjects.length === 0) {
			return html`
				<div class="generated-apps-panel__state">
					<span>${icon(Search, "md")}</span>
					<div>
						<div class="generated-apps-panel__state-title">${t("No matching apps")}</div>
						<div class="generated-apps-panel__state-text">${t("Try another app name or preview URL.")}</div>
					</div>
				</div>
			`;
		}
		return html`<div class="generated-apps-panel__list">${visibleProjects.map((project) => this.renderProject(project))}</div>`;
	}

	private renderProject(project: GeneratedAppRecord): TemplateResult {
		const canOpen = Boolean(project.previewUrl);
		const copied = this.copiedProjectId === project.projectId;
		const editing = this.editingProjectId === project.projectId;
		const renaming = this.renamingProjectId === project.projectId;
		const statusLabel = projectStatusLabel(project.status);
		return html`
			<article class="generated-app-card">
				<div class="generated-app-card__icon">${icon(PanelsTopLeft, "md")}</div>
				<div class="generated-app-card__main">
					<div class="generated-app-card__title" title=${project.title}>${project.title}</div>
					${
						canOpen
							? html`<a class="generated-app-card__url" href=${project.previewUrl} target="_blank" rel="noreferrer">${project.previewUrl}</a>`
							: html`<div class="generated-app-card__url generated-app-card__url--muted">${t("Preview unavailable")}</div>`
					}
					<div class="generated-app-card__meta">
						<span class=${`generated-app-card__status generated-app-card__status--${project.status === "running" ? "running" : "failed"}`}>
							<span></span>${statusLabel}
						</span>
						<span>${project.fileCount} ${t("files")}</span>
						<span>${formatUpdatedAt(project.updatedAt)}</span>
					</div>
				</div>
				<div class="generated-app-card__actions">
					<button
						type="button"
						class="generated-app-card__action"
						?disabled=${editing || renaming}
						@click=${() => this.startRename(project)}
						title=${t("Rename APP")}
						aria-label=${t("Rename APP")}
					>
						${icon(Pencil, "sm")}
					</button>
					<button
						type="button"
						class="generated-app-card__action"
						?disabled=${!canOpen}
						@click=${() => void this.copyPreviewUrl(project)}
						title=${t("Copy URL")}
						aria-label=${t("Copy URL")}
					>
						${copied ? icon(Check, "sm") : icon(Copy, "sm")}
					</button>
				</div>
			</article>
		`;
	}

	private renderRenameDialog(): TemplateResult | string {
		if (!this.editingProjectId) return "";
		const project = this.projects.find((candidate) => candidate.projectId === this.editingProjectId);
		if (!project) return "";
		const renaming = this.renamingProjectId === project.projectId;
		return html`
			<div class="generated-apps-rename-backdrop" @click=${() => this.cancelRename()}>
				<form
					class="generated-apps-rename-dialog"
					@click=${(event: MouseEvent) => event.stopPropagation()}
					@submit=${(event: SubmitEvent) => this.submitRename(event, project)}
				>
					<div class="generated-apps-rename-dialog__header">
						<h3>${t("Rename APP")}</h3>
						<button
							type="button"
							class="generated-apps-rename-dialog__icon-button"
							?disabled=${renaming}
							@click=${() => this.cancelRename()}
							title=${t("Cancel")}
							aria-label=${t("Cancel")}
						>
							${icon(X, "sm")}
						</button>
					</div>
					<div class="generated-apps-rename-dialog__current" title=${project.title}>${project.title}</div>
					<label class="generated-apps-rename-dialog__field">
						<span>${t("APP name")}</span>
						<input
							data-rename-project-id=${project.projectId}
							type="text"
							maxlength="160"
							.value=${this.editingTitle}
							aria-label=${t("APP name")}
							@keydown=${(event: KeyboardEvent) => {
								if (event.key === "Escape") this.cancelRename();
							}}
							@input=${(event: Event) => {
								this.editingTitle = (event.target as HTMLInputElement).value;
							}}
						/>
					</label>
					${this.renameError ? html`<div class="generated-apps-rename-dialog__error">${this.renameError}</div>` : ""}
					<div class="generated-apps-rename-dialog__actions">
						<button
							type="button"
							class="generated-apps-rename-dialog__button"
							?disabled=${renaming}
							@click=${() => this.cancelRename()}
						>
							${t("Cancel")}
						</button>
						<button
							type="submit"
							class="generated-apps-rename-dialog__button generated-apps-rename-dialog__button--primary"
							?disabled=${renaming || !this.editingTitle.trim()}
						>
							${renaming ? t("Saving...") : t("Save")}
						</button>
					</div>
				</form>
			</div>
		`;
	}

	private startRename(project: GeneratedAppRecord): void {
		this.editingProjectId = project.projectId;
		this.editingTitle = project.title;
		this.renameError = "";
		void this.updateComplete.then(() => {
			const input = this.querySelector<HTMLInputElement>(`input[data-rename-project-id="${project.projectId}"]`);
			input?.focus();
			input?.select();
		});
	}

	private cancelRename(): void {
		this.editingProjectId = "";
		this.editingTitle = "";
		this.renameError = "";
	}

	private async submitRename(event: SubmitEvent, project: GeneratedAppRecord): Promise<void> {
		event.preventDefault();
		const title = this.editingTitle.replace(/\s+/g, " ").trim();
		if (!title) {
			this.renameError = t("App name is required.");
			return;
		}
		if (title === project.title) {
			this.cancelRename();
			return;
		}
		this.renamingProjectId = project.projectId;
		this.renameError = "";
		try {
			const renamed = await renameGeneratedApp(project.projectId, title);
			this.projects = this.projects.map((candidate) =>
				candidate.projectId === renamed.projectId ? renamed : candidate,
			);
			this.cancelRename();
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.renamingProjectId === project.projectId) this.renamingProjectId = "";
		}
	}

	private async copyPreviewUrl(project: GeneratedAppRecord): Promise<void> {
		if (!project.previewUrl || !navigator.clipboard) return;
		await navigator.clipboard.writeText(project.previewUrl);
		this.copiedProjectId = project.projectId;
		window.setTimeout(() => {
			if (this.copiedProjectId === project.projectId) this.copiedProjectId = "";
		}, 1200);
	}
}

function t(message: string): string {
	return message;
}

function countLabel(visibleCount: number, totalCount: number, query: string): string {
	if (query.trim()) return `${visibleCount} / ${totalCount} ${t("apps")}`;
	return `${totalCount} ${t("apps")}`;
}

function projectStatusLabel(status: string): string {
	if (status === "running") return t("available");
	return status;
}

function formatUpdatedAt(value: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return value;
	const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (deltaSeconds < 60) return t("Updated just now");
	const deltaMinutes = Math.floor(deltaSeconds / 60);
	if (deltaMinutes < 60) return `${t("Updated")} ${deltaMinutes}m ${t("ago")}`;
	const deltaHours = Math.floor(deltaMinutes / 60);
	if (deltaHours < 24) return `${t("Updated")} ${deltaHours}h ${t("ago")}`;
	const deltaDays = Math.floor(deltaHours / 24);
	return `${t("Updated")} ${deltaDays}d ${t("ago")}`;
}
