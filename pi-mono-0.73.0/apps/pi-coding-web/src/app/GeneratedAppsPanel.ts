import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { AlertCircle, ExternalLink, PanelsTopLeft, Pencil, RefreshCw, Search, Square, Trash2, X } from "lucide";
import {
	cancelGeneratedAppRunWithRollback,
	filterGeneratedApps,
	formatGeneratedAppUpdatedAt,
	type GeneratedAppRecord,
	loadGeneratedApps,
	projectSessionStatusLabel,
	renameGeneratedApp,
} from "./generated-apps-state.js";

@customElement("pi-generated-apps-panel")
export class GeneratedAppsPanel extends LitElement {
	@property({ attribute: false }) openSession: (sessionId: string) => Promise<unknown> | unknown = () => undefined;
	@property({ attribute: false }) deleteSession: (sessionId: string) => Promise<unknown> | unknown = () => undefined;
	@property({ attribute: false }) cancelRun: (runId: string) => Promise<unknown> | unknown = () => undefined;
	@property({ attribute: false }) renameProject: (
		project: GeneratedAppRecord,
		title: string,
	) => Promise<unknown> | unknown = (project, title) => renameGeneratedApp(project.projectId, title);
	@property({ attribute: false }) loadProjects: () => Promise<GeneratedAppRecord[]> = () => loadGeneratedApps();
	@property({ type: String }) selectedSessionStatus: "running" | "idle" = "idle";

	@state() private projects: GeneratedAppRecord[] = [];
	@state() private loading = false;
	@state() private error = "";
	@state() private query = "";
	@state() private editingProjectId = "";
	@state() private editingTitle = "";
	@state() private renamingProjectId = "";
	@state() private renameError = "";
	@state() private deleteProjectId = "";
	@state() private deletingProjectId = "";
	@state() private deleteError = "";

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
			this.projects = await this.loadProjects();
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
				<footer class="generated-apps-panel__footer">
					<span class=${`generated-app-card__status generated-app-card__status--${this.selectedSessionStatus}`}>
						<span></span>${this.selectedSessionStatus === "running" ? t("正在执行") : t("空闲")}
					</span>
				</footer>
				${this.renderRenameDialog()}
				${this.renderDeleteDialog()}
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
						<div class="generated-apps-panel__state-title">${t("No session projects yet")}</div>
						<div class="generated-apps-panel__state-text">${t("Send a message to create a session project.")}</div>
					</div>
				</div>
			`;
		}
		if (!this.loading && visibleProjects.length === 0) {
			return html`
				<div class="generated-apps-panel__state">
					<span>${icon(Search, "md")}</span>
					<div>
						<div class="generated-apps-panel__state-title">${t("No matching sessions")}</div>
						<div class="generated-apps-panel__state-text">${t("Try another session title or preview URL.")}</div>
					</div>
				</div>
			`;
		}
		return html`<div class="generated-apps-panel__list">${visibleProjects.map((project) => this.renderProject(project))}</div>`;
	}

	private renderProject(project: GeneratedAppRecord): TemplateResult {
		const canOpen = Boolean(project.previewUrl);
		const running = project.status === "running";
		const editing = this.editingProjectId === project.projectId;
		const renaming = this.renamingProjectId === project.projectId;
		const deleting = this.deletingProjectId === project.projectId;
		const statusLabel = projectSessionStatusLabel(project.runStatus || project.status);
		return html`
			<article
				class="generated-app-card"
				role="button"
				tabindex="0"
				title=${t("Open session")}
				@click=${() => void this.openProjectSession(project)}
				@keydown=${(event: KeyboardEvent) => this.handleProjectKeydown(event, project)}
			>
				<div class="generated-app-card__icon">${icon(PanelsTopLeft, "md")}</div>
				<div class="generated-app-card__main">
					<div class="generated-app-card__title" title=${project.title}>${project.title}</div>
					${canOpen ? html`<div class="generated-app-card__url">${project.previewUrl}</div>` : ""}
					<div class="generated-app-card__meta">
						<span class=${`generated-app-card__status generated-app-card__status--${project.status}`}>
							<span></span>${statusLabel}
						</span>
						<span>${project.fileCount} ${t("files")}</span>
						<span>${formatGeneratedAppUpdatedAt(project.updatedAt)}</span>
					</div>
				</div>
				<div
					class="generated-app-card__actions"
					@click=${(event: MouseEvent) => event.stopPropagation()}
					@keydown=${(event: KeyboardEvent) => event.stopPropagation()}
				>
					<button
						type="button"
						class="generated-app-card__action"
						?disabled=${editing || renaming || deleting}
						@click=${(event: MouseEvent) => {
							event.stopPropagation();
							this.startRename(project);
						}}
						title=${t("Rename APP")}
						aria-label=${t("Rename APP")}
					>
						${icon(Pencil, "sm")}
					</button>
					${
						canOpen
							? html`
								<button
									type="button"
									class="generated-app-card__action"
									?disabled=${deleting}
									@click=${(event: MouseEvent) => {
										event.stopPropagation();
										this.openPreview(project);
									}}
									title=${t("Open preview")}
									aria-label=${t("Open preview")}
								>
									${icon(ExternalLink, "sm")}
								</button>
							`
							: ""
					}
					<button
						type="button"
						class=${`generated-app-card__action generated-app-card__action--danger ${running ? "generated-app-card__action--stop" : ""}`}
						?disabled=${editing || renaming || deleting}
						@click=${(event: MouseEvent) => {
							event.stopPropagation();
							if (running) void this.stopRun(project);
							else this.startDelete(project);
						}}
						title=${running ? t("Stop run") : t("Delete session")}
						aria-label=${running ? t("Stop run") : t("Delete session")}
					>
						${running ? icon(Square, "sm") : icon(Trash2, "sm")}
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

	private renderDeleteDialog(): TemplateResult | string {
		if (!this.deleteProjectId) return "";
		const project = this.projects.find((candidate) => candidate.projectId === this.deleteProjectId);
		if (!project) return "";
		const deleting = this.deletingProjectId === project.projectId;
		return html`
			<div class="generated-apps-rename-backdrop" @click=${() => this.cancelDelete()}>
				<div class="generated-apps-rename-dialog" @click=${(event: MouseEvent) => event.stopPropagation()}>
					<div class="generated-apps-rename-dialog__header">
						<h3>${t("Delete APP")}</h3>
						<button
							type="button"
							class="generated-apps-rename-dialog__icon-button"
							?disabled=${deleting}
							@click=${() => this.cancelDelete()}
							title=${t("Cancel")}
							aria-label=${t("Cancel")}
						>
							${icon(X, "sm")}
						</button>
					</div>
					<div class="generated-apps-rename-dialog__current" title=${project.title}>${project.title}</div>
					<div class="generated-apps-delete-dialog__text">
						${t("Deleting this app will also delete the linked session and its project files.")}
					</div>
					${this.deleteError ? html`<div class="generated-apps-rename-dialog__error">${this.deleteError}</div>` : ""}
					<div class="generated-apps-rename-dialog__actions">
						<button
							type="button"
							class="generated-apps-rename-dialog__button"
							?disabled=${deleting}
							@click=${() => this.cancelDelete()}
						>
							${t("Cancel")}
						</button>
						<button
							type="button"
							class="generated-apps-rename-dialog__button generated-apps-rename-dialog__button--danger"
							?disabled=${deleting}
							@click=${() => void this.confirmDelete(project)}
						>
							${deleting ? t("Deleting...") : t("Delete")}
						</button>
					</div>
				</div>
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
			await this.renameProject(project, title);
			this.projects = this.projects.map((candidate) =>
				candidate.sessionId === project.sessionId ? { ...candidate, title } : candidate,
			);
			this.cancelRename();
		} catch (error) {
			this.renameError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.renamingProjectId === project.projectId) this.renamingProjectId = "";
		}
	}

	private openPreview(project: GeneratedAppRecord): void {
		if (!project.previewUrl) return;
		window.open(project.previewUrl, "_blank", "noopener,noreferrer");
	}

	private handleProjectKeydown(event: KeyboardEvent, project: GeneratedAppRecord): void {
		if (event.key !== "Enter" && event.key !== " ") return;
		event.preventDefault();
		void this.openProjectSession(project);
	}

	private async openProjectSession(project: GeneratedAppRecord): Promise<void> {
		if (this.editingProjectId || this.deleteProjectId || this.deletingProjectId) return;
		await this.openSession(project.sessionId);
	}

	private startDelete(project: GeneratedAppRecord): void {
		this.deleteProjectId = project.projectId;
		this.deleteError = "";
	}

	private async stopRun(project: GeneratedAppRecord): Promise<void> {
		await cancelGeneratedAppRunWithRollback(this.projects, project, this.cancelRun, (projects) => {
			this.projects = projects;
		});
	}

	private cancelDelete(): void {
		if (this.deletingProjectId) return;
		this.deleteProjectId = "";
		this.deleteError = "";
	}

	private async confirmDelete(project: GeneratedAppRecord): Promise<void> {
		this.deletingProjectId = project.projectId;
		this.deleteError = "";
		try {
			await this.deleteSession(project.sessionId);
			this.projects = this.projects.filter((candidate) => candidate.projectId !== project.projectId);
			this.deleteProjectId = "";
		} catch (error) {
			this.deleteError = error instanceof Error ? error.message : String(error);
		} finally {
			if (this.deletingProjectId === project.projectId) this.deletingProjectId = "";
		}
	}
}

function t(message: string): string {
	return message;
}

function countLabel(visibleCount: number, totalCount: number, query: string): string {
	if (query.trim()) return `${visibleCount} / ${totalCount} ${t("apps")}`;
	return `${totalCount} ${t("apps")}`;
}
