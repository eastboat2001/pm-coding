import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import type { AgentV2RunStatus } from "@mariozechner/pi-web-workspace";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { MergedSessionEntry } from "../storage/merged-session-index.js";
import { formatSessionUpdatedAt } from "../storage/session-timestamps.js";

const CANCELLABLE_RUN_STATUSES: ReadonlySet<AgentV2RunStatus> = new Set(["queued", "running"]);
const i18n = (text: string) => text;

export function sessionRunStatusLabel(status: AgentV2RunStatus | undefined): string {
	if (status === "queued") return i18n("Queued");
	if (status === "running") return i18n("Running");
	if (status === "cancelling") return i18n("Cancelling");
	if (status === "failed") return i18n("Failed");
	if (status === "cancelled") return i18n("Cancelled");
	if (status === "interrupted") return i18n("Interrupted");
	return "";
}

export function isCancellableRunStatus(status: AgentV2RunStatus | undefined): status is AgentV2RunStatus {
	return status !== undefined && CANCELLABLE_RUN_STATUSES.has(status);
}

@customElement("local-session-list-dialog")
export class LocalSessionListDialog extends DialogBase {
	@state() private sessions: MergedSessionEntry[] = [];
	@state() private loading = true;

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => Promise<unknown> | unknown;
	private onCancelRunCallback?: (runId: string) => Promise<unknown> | unknown;
	private loadSessionsCallback?: () => Promise<MergedSessionEntry[]>;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		loadSessions: () => Promise<MergedSessionEntry[]>,
		onSelect: (sessionId: string) => void,
		onDelete?: (sessionId: string) => Promise<unknown> | unknown,
		onCancelRun?: (runId: string) => Promise<unknown> | unknown,
	) {
		const dialog = new LocalSessionListDialog();
		dialog.loadSessionsCallback = loadSessions;
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.onCancelRunCallback = onCancelRun;
		dialog.open();
		await dialog.refresh();
	}

	private async refresh(showLoading = true) {
		if (showLoading) {
			this.loading = true;
		}
		this.sessions = this.loadSessionsCallback ? await this.loadSessionsCallback() : [];
		this.loading = false;
	}

	private handleSelect(sessionId: string) {
		this.onSelectCallback?.(sessionId);
		this.close();
	}

	private async handleDelete(sessionId: string, event: Event) {
		event.stopPropagation();
		if (!confirm(i18n("Delete this session?"))) return;
		const previousSessions = this.sessions;
		this.sessions = this.sessions.filter((session) => session.id !== sessionId);
		try {
			await this.onDeleteCallback?.(sessionId);
			await this.refresh(false);
		} catch (error) {
			this.sessions = previousSessions;
			throw error;
		}
	}

	private async handleCancelRun(session: MergedSessionEntry, event: Event) {
		event.stopPropagation();
		if (!session.activeRunId) return;
		const previousSessions = this.sessions;
		this.sessions = this.sessions.map((candidate) =>
			candidate.id === session.id
				? { ...candidate, activeRunId: undefined, runStatus: "cancelling" as const }
				: candidate,
		);
		try {
			await this.onCancelRunCallback?.(session.activeRunId);
			await this.refresh(false);
		} catch (error) {
			this.sessions = previousSessions;
			throw error;
		}
	}

	private sessionSubtitle(session: MergedSessionEntry): string {
		const messages = `${session.messageCount} ${i18n("messages")}`;
		return [messages, session.preferredSource, formatSessionUpdatedAt(session.lastModified)]
			.filter(Boolean)
			.join(" · ");
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({ title: i18n("Sessions"), description: i18n("Load a browser conversation") })}
					<div class="flex-1 overflow-y-auto mt-4 space-y-2">
						${
							this.loading
								? html`<div class="text-center py-8 text-muted-foreground">${i18n("Loading...")}</div>`
								: this.sessions.length === 0
									? html`<div class="text-center py-8 text-muted-foreground">${i18n("No sessions yet")}</div>`
									: this.sessions.map(
											(session) => html`
												<div
													class="group flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-secondary/50 transition-colors"
												>
													<div class="flex-1 min-w-0 cursor-pointer" @click=${() => this.handleSelect(session.id)}>
														<div class="flex items-center gap-2 min-w-0">
															<div class="font-medium text-sm text-foreground truncate">${session.title}</div>
														</div>
														<div class="text-xs text-muted-foreground mt-1">${this.sessionSubtitle(session)}</div>
													</div>
													${
														session.activeRunId && isCancellableRunStatus(session.runStatus)
															? html`<button
																type="button"
																class="shrink-0"
																style="appearance: none; -webkit-appearance: none; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; min-width: 36px; min-height: 36px; padding: 0; border: 0; border-radius: 0; background: transparent; cursor: pointer; line-height: 1; position: relative; z-index: 2; pointer-events: auto;"
																@pointerdown=${(e: Event) => e.stopPropagation()}
																@pointerup=${(e: Event) => e.stopPropagation()}
																@click=${(e: Event) => this.handleCancelRun(session, e)}
																title=${i18n("Cancel run")}
																aria-label=${i18n("Cancel run")}
															>
																<span
																	aria-hidden="true"
																	style="display: block; width: 14px; height: 14px; border-radius: 2px; background: var(--destructive); pointer-events: none;"
																></span>
															</button>`
															: ""
													}
													<button
														class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-destructive transition-opacity"
														type="button"
														@pointerdown=${(e: Event) => e.stopPropagation()}
														@pointerup=${(e: Event) => e.stopPropagation()}
														@click=${(e: Event) => this.handleDelete(session.id, e)}
														title=${i18n("Delete")}
													>
														✕
													</button>
												</div>
											`,
										)
						}
					</div>
				`,
			})}
		`;
	}
}
