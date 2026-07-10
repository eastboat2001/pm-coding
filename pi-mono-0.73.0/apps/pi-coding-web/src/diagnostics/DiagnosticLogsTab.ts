import { icon } from "@mariozechner/mini-lit";
import { i18n, SettingsTab, type SessionMetadata } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { Download, RefreshCw, TriangleAlert } from "lucide";
import { diagnosticSessionTitle, downloadDiagnosticSessionExport } from "./diagnostic-export-client.js";
import { getBrowserAppStorage } from "../storage/browser-app-storage.js";
import type { BrowserSessionRecord } from "../runtime/browser-records.js";

const t = (message: string) => i18n(message as Parameters<typeof i18n>[0]);

@customElement("pi-diagnostic-logs-tab")
export class DiagnosticLogsTab extends SettingsTab {
	@state() private sessions: BrowserSessionRecord[] = [];
	@state() private loading = true;
	@state() private error = "";
	@state() private exportingSessionId = "";

	override connectedCallback(): void {
		super.connectedCallback();
		void this.loadSessions();
	}

	getTabName(): string {
		return t("Diagnostic logs");
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-5">
				<div class="flex items-start justify-between gap-3">
					<div>
						<h3 class="text-sm font-semibold text-foreground mb-2">${t("Diagnostic logs")}</h3>
						<p class="text-sm text-muted-foreground">${t("Choose a session to export related PI diagnostics.")}</p>
					</div>
					<button
						type="button"
						class="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm text-foreground hover:bg-secondary disabled:opacity-60"
						@click=${() => this.loadSessions()}
						?disabled=${this.loading}
					>
						${icon(RefreshCw, "sm")}
						<span>${t("Refresh")}</span>
					</button>
				</div>

				${this.error ? this.renderError() : ""}
				${this.renderSessions()}
			</div>
		`;
	}

	private renderSessions(): TemplateResult {
		if (this.loading) {
			return html`<div class="py-8 text-center text-sm text-muted-foreground">${t("Loading...")}</div>`;
		}
		if (this.sessions.length === 0) {
			return html`<div class="py-8 text-center text-sm text-muted-foreground">${t("No sessions yet")}</div>`;
		}
		return html`
			<div class="flex flex-col divide-y divide-border rounded-md border border-border">
				${this.sessions.map((session) => this.renderSession(session))}
			</div>
		`;
	}

	private renderSession(session: BrowserSessionRecord): TemplateResult {
		const exporting = this.exportingSessionId === session.sessionId;
		return html`
			<div class="flex items-center justify-between gap-3 px-4 py-3">
				<div class="min-w-0">
					<div class="truncate text-sm font-medium text-foreground">${diagnosticSessionTitle(session)}</div>
					<div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<span>${this.formatDate(session.updatedAt)}</span>
						<span class="font-mono">${session.sessionId}</span>
						${session.lastRunStatus ? html`<span>${session.lastRunStatus}</span>` : ""}
					</div>
				</div>
				<button
					type="button"
					class="inline-flex flex-shrink-0 items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
					@click=${() => this.exportSession(session)}
					?disabled=${exporting}
				>
					${icon(Download, "sm")}
					<span>${exporting ? t("Exporting...") : t("Export")}</span>
				</button>
			</div>
		`;
	}

	private renderError(): TemplateResult {
		return html`
			<div class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
				${icon(TriangleAlert, "sm")}
				<span>${this.error}</span>
			</div>
		`;
	}

	private async loadSessions(): Promise<void> {
		this.loading = true;
		this.error = "";
		try {
			const storage = getBrowserAppStorage();
			const metadata = (await storage.sessions.getAllMetadata()) as Array<
				SessionMetadata & { runStatus?: BrowserSessionRecord["lastRunStatus"]; lastRunId?: string }
			>;
			this.sessions = metadata.map((session) => ({
				sessionId: session.id,
				clientId: "",
				title: session.title,
				model: {},
				thinkingLevel: session.thinkingLevel,
				createdAt: session.createdAt,
				updatedAt: session.lastModified,
				...(session.runStatus ? { lastRunStatus: session.runStatus } : {}),
				...(session.lastRunId ? { lastRunId: session.lastRunId } : {}),
			}));
		} catch (error) {
			this.sessions = [];
			this.error = errorMessage(error);
		} finally {
			this.loading = false;
		}
	}

	private async exportSession(session: BrowserSessionRecord): Promise<void> {
		this.exportingSessionId = session.sessionId;
		this.error = "";
		try {
			await downloadDiagnosticSessionExport(session);
		} catch (error) {
			this.error = errorMessage(error);
		} finally {
			this.exportingSessionId = "";
		}
	}

	private formatDate(value: string): string {
		const millis = Date.parse(value);
		if (!Number.isFinite(millis)) return value;
		return new Date(millis).toLocaleString();
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
