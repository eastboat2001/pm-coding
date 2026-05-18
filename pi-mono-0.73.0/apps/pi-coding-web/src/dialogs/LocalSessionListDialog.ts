import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { i18n } from "@mariozechner/pi-web-ui";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { MergedSessionEntry } from "../storage/merged-session-index.js";

@customElement("local-session-list-dialog")
export class LocalSessionListDialog extends DialogBase {
	@state() private sessions: MergedSessionEntry[] = [];
	@state() private loading = true;

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => void;
	private loadSessionsCallback?: () => Promise<MergedSessionEntry[]>;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		loadSessions: () => Promise<MergedSessionEntry[]>,
		onSelect: (sessionId: string) => void,
		onDelete?: (sessionId: string) => void,
	) {
		const dialog = new LocalSessionListDialog();
		dialog.loadSessionsCallback = loadSessions;
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.open();
		await dialog.refresh();
	}

	private async refresh() {
		this.loading = true;
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
		this.onDeleteCallback?.(sessionId);
		await this.refresh();
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
													class="group flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-secondary/50 cursor-pointer transition-colors"
													@click=${() => this.handleSelect(session.id)}
												>
													<div class="flex-1 min-w-0">
														<div class="font-medium text-sm text-foreground truncate">${session.title}</div>
														<div class="text-xs text-muted-foreground mt-1">${session.messageCount} ${i18n("messages")} · ${session.preferredSource}</div>
													</div>
													<button
														class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-destructive transition-opacity"
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
