import { icon } from "@mariozechner/mini-lit";
import { i18n, SettingsTab, type SkillDiagnostic } from "@mariozechner/pi-web-ui";
import { html, type TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { ChevronDown, CircleAlert, GitCompareArrows, TriangleAlert } from "lucide";
import type { SkillSummary } from "./schemas.js";
import {
	createSkillDiagnosticPresentation,
	type SkillDiagnosticPresentation,
	type SkillStatusSummary,
	summarizeSkillStatus,
} from "./skill-status-summary.js";

const t = (message: string) => i18n(message as Parameters<typeof i18n>[0]);

@customElement("pi-skill-status-tab")
export class SkillStatusTab extends SettingsTab {
	@property({ attribute: false }) skills: SkillSummary[] = [];
	@property({ attribute: false }) diagnostics: SkillDiagnostic[] = [];
	@state() private expandedDiagnosticKeys = new Set<string>();

	getTabName(): string {
		return t("Skill status");
	}

	render(): TemplateResult {
		const summary = summarizeSkillStatus({
			skills: this.skills,
			diagnostics: this.diagnostics,
		});

		return html`
			<div class="flex flex-col gap-6">
				<div>
					<h3 class="text-sm font-semibold text-foreground mb-2">${t("Skill status")}</h3>
					<p class="text-sm text-muted-foreground">
						${t("Review configured PI skills and format diagnostics.")}
					</p>
				</div>

				<div class="grid gap-3 sm:grid-cols-4">
					${this.renderMetric(t("Available skills"), summary.availableCount)}
					${this.renderMetric(t("Implicit skills"), summary.implicitCount)}
					${this.renderMetric(t("Explicit-only skills"), summary.explicitOnlyCount)}
					${this.renderMetric(t("Issues"), summary.issueCount, summary.errorCount > 0 ? "error" : "neutral")}
				</div>

				${this.renderDiagnostics(summary)}
				${this.renderSkillList(t("Available skills"), this.skills)}
			</div>
		`;
	}

	private renderMetric(label: string, value: number, tone: "error" | "neutral" = "neutral"): TemplateResult {
		const valueClass = tone === "error" ? "text-destructive" : "text-foreground";
		return html`
			<div class="rounded-md border border-border bg-card px-3 py-3">
				<div class="text-xs text-muted-foreground">${label}</div>
				<div class="mt-1 text-lg font-semibold ${valueClass}">${value}</div>
			</div>
		`;
	}

	private renderDiagnostics(summary: SkillStatusSummary): TemplateResult {
		if (this.diagnostics.length === 0) {
			return html`
				<section class="rounded-md border border-border bg-card px-4 py-4">
					<h4 class="text-sm font-semibold text-foreground">${t("Diagnostics")}</h4>
					<p class="mt-2 text-sm text-muted-foreground">${t("All configured skills are valid.")}</p>
				</section>
			`;
		}

		return html`
			<section class="rounded-md border border-border bg-card px-4 py-4">
				<div class="flex flex-wrap items-center justify-between gap-2">
					<h4 class="text-sm font-semibold text-foreground">${t("Diagnostics")}</h4>
					<div class="text-xs text-muted-foreground">
						${t("Errors")}: ${summary.errorCount} · ${t("Warnings")}: ${summary.warningCount} ·
						${t("Collisions")}: ${summary.collisionCount}
					</div>
				</div>
				<div class="mt-3 flex flex-col gap-3">
					${this.diagnostics.map((diagnostic, index) => this.renderDiagnostic(diagnostic, index))}
				</div>
			</section>
		`;
	}

	private renderDiagnostic(diagnostic: SkillDiagnostic, index: number): TemplateResult {
		const presentation = createSkillDiagnosticPresentation(diagnostic, index);
		const expanded = this.expandedDiagnosticKeys.has(presentation.key);
		return html`
			<div class=${`skill-diagnostic ${presentation.toneClass}`}>
				<button
					type="button"
					class="skill-diagnostic__summary"
					aria-expanded=${expanded ? "true" : "false"}
					aria-label=${expanded ? t("Collapse diagnostic") : t("Expand diagnostic")}
					@click=${() => this.toggleDiagnostic(presentation.key)}
				>
					<span class="skill-diagnostic__icon">${this.renderDiagnosticIcon(presentation)}</span>
					<div class="skill-diagnostic__main">
						<div class="skill-diagnostic__meta">
							<span class="skill-diagnostic__badge">${this.diagnosticLabel(diagnostic.type)}</span>
							${diagnostic.path ? html`<span class="skill-diagnostic__path">${diagnostic.path}</span>` : ""}
						</div>
						${expanded ? "" : html`<div class="skill-diagnostic__message" title=${diagnostic.message}>${diagnostic.message}</div>`}
					</div>
					<span class=${`skill-diagnostic__chevron ${expanded ? "skill-diagnostic__chevron--expanded" : ""}`}>
						${icon(ChevronDown, "sm")}
					</span>
				</button>
				${
					expanded
						? html`
							<div class="skill-diagnostic__details">
								<div class="grid gap-3 text-xs text-left">
									<div>
										<div class="font-medium text-muted-foreground">${t("Message")}</div>
										<div class="mt-1 whitespace-pre-wrap break-words text-left text-sm text-foreground">${diagnostic.message}</div>
									</div>
									${
										diagnostic.path
											? html`
												<div>
													<div class="font-medium text-muted-foreground">${t("Path")}</div>
													<div class="mt-1 break-all font-mono text-xs text-foreground">${diagnostic.path}</div>
												</div>
											`
											: ""
									}
									<div>
										<div class="font-medium text-muted-foreground">${t("Suggestion")}</div>
										<div class="mt-1 whitespace-pre-wrap break-words text-left text-sm text-foreground">${presentation.suggestion}</div>
									</div>
								</div>
							</div>
						`
						: ""
				}
			</div>
		`;
	}

	private renderSkillList(title: string, skills: SkillSummary[]): TemplateResult {
		return html`
			<section class="rounded-md border border-border bg-card px-4 py-4">
				<h4 class="text-sm font-semibold text-foreground">${title}</h4>
				${
					skills.length === 0
						? html`<p class="mt-2 text-sm text-muted-foreground">${t("No skills available")}</p>`
						: html`
							<div class="mt-3 flex flex-col divide-y divide-border">
								${skills.map(
									(skill) => html`
									<div class="py-3">
											<div class="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
												<span>${skill.interface?.displayName || skill.name}</span>
												<span class="rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
													${skill.allowImplicitInvocation ? t("Implicit skills") : t("Explicit-only skills")}
												</span>
											</div>
											<div class="mt-1 text-xs text-muted-foreground break-words">${skill.description}</div>
											<div class="mt-1 text-[11px] text-muted-foreground break-all">${skill.location}</div>
										</div>
									`,
								)}
							</div>
						`
				}
			</section>
		`;
	}

	private diagnosticLabel(type: SkillDiagnostic["type"]): string {
		if (type === "error") return t("Error");
		if (type === "collision") return t("Collision");
		return t("Warning");
	}

	private renderDiagnosticIcon(presentation: SkillDiagnosticPresentation): TemplateResult {
		if (presentation.icon === "error") return icon(CircleAlert, "sm");
		if (presentation.icon === "collision") return icon(GitCompareArrows, "sm");
		return icon(TriangleAlert, "sm");
	}

	private toggleDiagnostic(key: string): void {
		const expandedKeys = new Set(this.expandedDiagnosticKeys);
		if (expandedKeys.has(key)) {
			expandedKeys.delete(key);
		} else {
			expandedKeys.add(key);
		}
		this.expandedDiagnosticKeys = expandedKeys;
	}
}
