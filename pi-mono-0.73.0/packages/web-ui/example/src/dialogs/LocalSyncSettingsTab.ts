import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { SettingsTab } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import type { LocalSessionSync } from "../storage/local-session-sync.js";

@customElement("local-sync-settings-tab")
export class LocalSyncSettingsTab extends SettingsTab {
	@state() private enabled = false;
	@state() private supported = false;
	@state() private hasDirectory = false;
	@state() private directoryName = "";
	@state() private lastError: string | null = null;

	public syncService!: LocalSessionSync;
	public onChange?: () => void;

	getTabName(): string {
		return "Local Sync";
	}

	override async connectedCallback() {
		super.connectedCallback();
		await this.refreshState();
	}

	private async refreshState() {
		if (!this.syncService) return;
		const status = await this.syncService.getStatus();
		this.supported = status.supported;
		this.enabled = status.enabled;
		this.hasDirectory = status.hasDirectory;
		this.directoryName = status.directoryName ?? "";
		this.lastError = status.lastError;
		this.requestUpdate();
	}

	private async handleChooseDirectory() {
		if (!this.syncService) return;
		await this.syncService.pickDirectory();
		await this.refreshState();
		this.onChange?.();
	}

	private async handleDisable() {
		if (!this.syncService) return;
		await this.syncService.disable();
		await this.refreshState();
		this.onChange?.();
	}

	private async handleClearDirectory() {
		if (!this.syncService) return;
		await this.syncService.clearDirectory();
		await this.refreshState();
		this.onChange?.();
	}

	render(): TemplateResult {
		return html`
			<div class="flex flex-col gap-4">
				<p class="text-sm text-muted-foreground">
					Mirror sessions into a local directory while keeping browser storage enabled.
				</p>

				<div class="rounded-lg border border-border p-4 flex flex-col gap-3">
					<div class="text-sm"><span class="font-medium">Browser support:</span> ${this.supported ? "Available" : "Not available"}</div>
					<div class="text-sm"><span class="font-medium">Directory:</span> ${this.directoryName || "None selected"}</div>
					<div class="text-sm"><span class="font-medium">Status:</span> ${this.enabled ? "Enabled" : "Disabled"}</div>
					${this.lastError ? html`<div class="text-sm text-destructive">${this.lastError}</div>` : ""}
					<div class="flex gap-2">
						${Button({
							variant: "default",
							onClick: () => {
								void this.handleChooseDirectory();
							},
							disabled: !this.supported,
							children: this.hasDirectory ? "Change Directory" : "Choose Directory",
						})}
						${Button({
							variant: "outline",
							onClick: () => {
								void this.handleDisable();
							},
							disabled: !this.enabled,
							children: "Disable",
						})}
						${Button({
							variant: "ghost",
							onClick: () => {
								void this.handleClearDirectory();
							},
							disabled: !this.hasDirectory,
							children: "Clear Directory",
						})}
					</div>
				</div>
			</div>
		`;
	}
}
