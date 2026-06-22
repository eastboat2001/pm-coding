import { html, LitElement, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { parseTransientStatusText, type TransientStatusKind } from "./transient-status-state.js";

const STATUS_STYLE = html`
	<style>
		@keyframes pi-transient-status-enter {
			from {
				opacity: 0;
				transform: translateY(4px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		.pi-transient-status {
			animation: pi-transient-status-enter 180ms ease-out;
			will-change: opacity, transform;
		}

		@media (prefers-reduced-motion: reduce) {
			.pi-transient-status {
				animation: none;
			}
		}
	</style>
`;

export class TransientStatusIndicator extends LitElement {
	@property({ type: String }) statusText = "";

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override render(): TemplateResult | string {
		const status = parseTransientStatusText(this.statusText);
		if (!status) return "";

		const ariaLabel = status.progress ? `${status.label} ${status.progress}` : status.label;
		return html`${STATUS_STYLE}
			${keyed(
				this.statusText,
				html`<div
					class="pi-transient-status mx-4 flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
					role="status"
					aria-live="polite"
					aria-label=${ariaLabel}
				>
					${this.renderPulse(status.kind)}
					<span class="min-w-0 truncate">${status.label}</span>
					${
						status.progress
							? html`<span
								class="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] leading-none text-foreground"
							>
								${status.progress}
							</span>`
							: ""
					}
				</div>`,
			)}`;
	}

	private renderPulse(kind: TransientStatusKind): TemplateResult {
		const colorClass = kind === "retry" ? "bg-amber-500" : kind === "recovery" ? "bg-sky-500" : "bg-muted-foreground";
		return html`<span class="relative inline-flex h-2.5 w-2.5 shrink-0">
			<span class="absolute inline-flex h-full w-full animate-ping rounded-full ${colorClass} opacity-40"></span>
			<span class="relative inline-flex h-2.5 w-2.5 rounded-full ${colorClass}"></span>
		</span>`;
	}
}

if (!customElements.get("transient-status-indicator")) {
	customElements.define("transient-status-indicator", TransientStatusIndicator);
}
