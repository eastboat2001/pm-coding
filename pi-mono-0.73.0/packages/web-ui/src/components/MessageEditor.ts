import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import type { Model } from "@mariozechner/pi-ai";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { ArrowLeft, Brain, Check, ChevronRight, Loader2, Paperclip, Send, Sparkles, Square, X } from "lucide";
import { type Attachment, loadAttachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	applySlashSuggestionToState,
	applySlashSuggestionToValue,
	buildSlashSuggestionState,
	getSlashSelections,
	getSlashSuggestionSkills,
	resolveSlashSuggestionCursorPosition,
	resolveTextareaCursorPosition,
	type SlashSelections,
	type SlashSuggestionItem,
	type SlashSuggestionState,
	shouldStackSlashSelections,
	toggleSlashSelection,
} from "./slash-suggestions.js";

function isConfiguredModel(model: Model<any> | undefined): model is Model<any> {
	return !!model && model.provider !== "unknown" && model.id !== "unknown";
}

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}

	@property() isStreaming = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property({ attribute: false }) slashSuggestions: SlashSuggestionItem[] = [];
	@property() attachments: Attachment[] = [];
	@property() maxFiles = 10;
	@property() maxFileSize = 20 * 1024 * 1024; // 20MB
	@property() acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";

	@state() processingFiles = false;
	@state() isDragging = false;
	@state() private selectedSlashSuggestionIndex = 0;
	@state() private slashSuggestionsSuppressed = false;
	@state() private pendingSlashSuggestionCursorPosition?: number;
	@state() private extensionsMenuOpen = false;
	@state() private extensionsMenuView: "main" | "skills" = "main";
	private fileInputRef = createRef<HTMLInputElement>();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		document.addEventListener("pointerdown", this.handleDocumentPointerDown, true);
	}

	override disconnectedCallback(): void {
		document.removeEventListener("pointerdown", this.handleDocumentPointerDown, true);
		super.disconnectedCallback();
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		const selections = this.slashSelections;
		this.value = selections.items.length > 0 ? `${selections.prefix}${textarea.value}` : textarea.value;
		this.selectedSlashSuggestionIndex = 0;
		this.slashSuggestionsSuppressed = false;
		this.pendingSlashSuggestionCursorPosition = undefined;
		this.onInput?.(this.value);
	};

	private toggleExtensionsMenu = (event?: Event) => {
		event?.preventDefault();
		this.extensionsMenuOpen = !this.extensionsMenuOpen;
		this.extensionsMenuView = "main";
		requestAnimationFrame(() => this.textareaRef.value?.focus());
	};

	private closeExtensionsMenu() {
		if (!this.extensionsMenuOpen) return;
		this.extensionsMenuOpen = false;
		this.extensionsMenuView = "main";
	}

	private handleDocumentPointerDown = (event: PointerEvent) => {
		if (!this.extensionsMenuOpen) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		const menu = this.querySelector(".message-editor-extensions-menu");
		const trigger = this.querySelector(".message-editor-extensions-trigger");
		if (menu?.contains(target) || trigger?.contains(target)) return;
		this.closeExtensionsMenu();
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		// Ignore key events during IME composition (e.g. CJK input)
		if (e.isComposing || e.key === "Process") return;

		const slashSuggestionState = this.slashSuggestionState;
		if (slashSuggestionState.open) {
			if (e.key === "Escape") {
				e.preventDefault();
				this.slashSuggestionsSuppressed = true;
				return;
			}
			if (slashSuggestionState.items.length === 0) {
				if (e.key === "Enter" || e.key === "Tab") {
					e.preventDefault();
				}
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				this.selectedSlashSuggestionIndex =
					(this.selectedSlashSuggestionIndex + 1) % slashSuggestionState.items.length;
				return;
			}
			if (e.key === "ArrowUp") {
				e.preventDefault();
				this.selectedSlashSuggestionIndex =
					(this.selectedSlashSuggestionIndex - 1 + slashSuggestionState.items.length) %
					slashSuggestionState.items.length;
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				const selectedIndex = Math.min(this.selectedSlashSuggestionIndex, slashSuggestionState.items.length - 1);
				this.applySlashSuggestion(slashSuggestionState.items[selectedIndex], slashSuggestionState);
				return;
			}
		}

		const selections = this.slashSelections;
		const textarea = e.target as HTMLTextAreaElement;
		if (
			selections.items.length > 0 &&
			e.key === "Backspace" &&
			textarea.selectionStart === 0 &&
			textarea.selectionEnd === 0
		) {
			e.preventDefault();
			const oldValue = this.value;
			const remainingItems = selections.items.slice(0, -1);
			this.value = `${remainingItems.map((item) => item.insertText).join("")}${selections.text}`;
			this.slashSuggestionsSuppressed = false;
			this.onInput?.(this.value);
			this.requestUpdate("value", oldValue);
			return;
		}

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.isStreaming && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private handlePaste = async (e: ClipboardEvent) => {
		const items = e.clipboardData?.items;
		if (!items) return;

		const imageFiles: File[] = [];

		// Check for image items in clipboard
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) {
					imageFiles.push(file);
				}
			}
		}

		// If we found images, process them
		if (imageFiles.length > 0) {
			e.preventDefault(); // Prevent default paste behavior

			if (imageFiles.length + this.attachments.length > this.maxFiles) {
				alert(`Maximum ${this.maxFiles} files allowed`);
				return;
			}

			this.processingFiles = true;
			const newAttachments: Attachment[] = [];

			for (const file of imageFiles) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`Image exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}

					const attachment = await loadAttachment(file);
					newAttachments.push(attachment);
				} catch (error) {
					console.error("Error processing pasted image:", error);
					alert(`Failed to process pasted image: ${String(error)}`);
				}
			}

			this.attachments = [...this.attachments, ...newAttachments];
			this.onFilesChange?.(this.attachments);
			this.processingFiles = false;
		}
	};

	private handleSend = () => {
		this.onSend?.(this.value, this.attachments);
	};

	private get slashSuggestionState() {
		if (this.slashSuggestionsSuppressed || this.isStreaming) {
			return { open: false, items: [], query: "", trigger: "" };
		}
		return buildSlashSuggestionState(this.value, this.slashSuggestions, this.slashSuggestionCursorPosition);
	}

	private get slashSelections(): SlashSelections {
		return getSlashSelections(this.value, this.slashSuggestions);
	}

	private get slashSuggestionCursorPosition() {
		const textarea = this.textareaRef.value;
		return resolveSlashSuggestionCursorPosition(
			this.value,
			textarea?.selectionStart ?? this.value.length,
			this.slashSuggestions,
			this.pendingSlashSuggestionCursorPosition,
		);
	}

	private applySlashSuggestion(suggestion: SlashSuggestionItem | undefined, state?: SlashSuggestionState) {
		if (!suggestion) return;
		const oldValue = this.value;
		const result = state
			? applySlashSuggestionToState(this.value, suggestion, this.slashSuggestions, state)
			: applySlashSuggestionToValue(
					this.value,
					suggestion,
					this.slashSuggestions,
					this.slashSuggestionCursorPosition,
				);
		this.value = result.value;
		this.selectedSlashSuggestionIndex = 0;
		this.slashSuggestionsSuppressed = suggestion.keepOpen !== true;
		this.pendingSlashSuggestionCursorPosition = suggestion.keepOpen === true ? result.cursor : undefined;
		this.onInput?.(this.value);
		this.requestUpdate("value", oldValue);
		requestAnimationFrame(() => {
			const textarea = this.textareaRef.value;
			const cursorPosition = resolveTextareaCursorPosition(this.value, result.cursor, this.slashSuggestions);
			textarea?.focus();
			textarea?.setSelectionRange(cursorPosition, cursorPosition);
			if (this.pendingSlashSuggestionCursorPosition === result.cursor) {
				this.pendingSlashSuggestionCursorPosition = undefined;
			}
		});
	}

	private removeSlashSelection(index: number) {
		const selections = this.slashSelections;
		const oldValue = this.value;
		const remainingItems = selections.items.filter((_, itemIndex) => itemIndex !== index);
		this.value = `${remainingItems.map((item) => item.insertText).join("")}${selections.text}`;
		this.slashSuggestionsSuppressed = false;
		this.onInput?.(this.value);
		this.requestUpdate("value", oldValue);
		requestAnimationFrame(() => this.textareaRef.value?.focus());
	}

	private handleAttachmentClick = () => {
		this.fileInputRef.value?.click();
	};

	private toggleSkillSelection(item: SlashSuggestionItem, event?: Event) {
		event?.preventDefault();
		const oldValue = this.value;
		this.value = toggleSlashSelection(this.value, item, this.slashSuggestions);
		this.slashSuggestionsSuppressed = false;
		this.pendingSlashSuggestionCursorPosition = undefined;
		this.onInput?.(this.value);
		this.requestUpdate("value", oldValue);
		requestAnimationFrame(() => this.textareaRef.value?.focus());
	}

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			input.value = "";
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
		input.value = ""; // Reset input
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;

		const files = Array.from(e.dataTransfer?.files || []);
		if (files.length === 0) return;

		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}

		this.processingFiles = true;
		const newAttachments: Attachment[] = [];

		for (const file of files) {
			try {
				if (file.size > this.maxFileSize) {
					alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
					continue;
				}

				const attachment = await loadAttachment(file);
				newAttachments.push(attachment);
			} catch (error) {
				console.error(`Error processing ${file.name}:`, error);
				alert(`Failed to process ${file.name}: ${String(error)}`);
			}
		}

		this.attachments = [...this.attachments, ...newAttachments];
		this.onFilesChange?.(this.attachments);
		this.processingFiles = false;
	};

	override firstUpdated() {
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = isConfiguredModel(this.currentModel) ? this.currentModel : undefined;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				${this.renderSlashSuggestions()}
				${this.renderExtensionsMenu()}

				<!-- Attachments -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2">
								${this.attachments.map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
							</div>
						`
						: ""
				}

				${this.renderMessageInput()}

				<!-- Hidden file input -->
				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

				<!-- Button Row -->
				<div class="px-2 pb-2 flex items-center justify-between">
					<!-- Left side - attachment and thinking selector -->
					<div class="flex gap-2 items-center">
						${
							this.showAttachmentButton
								? this.processingFiles
									? html`
										<div class="h-8 w-8 flex items-center justify-center">
											${icon(Loader2, "sm", "animate-spin text-muted-foreground")}
										</div>
									`
									: html`
										${Button({
											variant: "ghost",
											size: "icon",
											className: "h-8 w-8",
											onClick: this.handleAttachmentClick,
											children: icon(Paperclip, "sm"),
										})}
									`
								: ""
						}
						${
							supportsThinking && this.showThinkingSelector
								? html`
									${Select({
										value: this.thinkingLevel,
										placeholder: i18n("Off"),
										options: [
											{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
											{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
											{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
											{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
											{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
										] as SelectOption[],
										onChange: (value: string) => {
											const level = value as "off" | "minimal" | "low" | "medium" | "high";
											this.thinkingLevel = level;
											this.onThinkingChange?.(level);
										},
										width: "80px",
										size: "sm",
										variant: "ghost",
										fitContent: true,
									})}
								`
								: ""
						}
						${Button({
							variant: this.extensionsMenuOpen ? "secondary" : "ghost",
							size: "sm",
							onClick: this.toggleExtensionsMenu,
							children: html`${icon(Sparkles, "sm")}<span class="ml-1">${i18n("Extensions")}</span>`,
							className: "message-editor-extensions-trigger h-8 text-xs",
						})}
					</div>

					<!-- Model selector and send on the right -->
					<div class="flex gap-2 items-center">
						${
							this.showModelSelector
								? html`
									${Button({
										variant: "ghost",
										size: "sm",
										onClick: () => {
											// Focus textarea before opening model selector so focus returns there
											this.textareaRef.value?.focus();
											// Wait for next frame to ensure focus takes effect before dialog captures it
											requestAnimationFrame(() => {
												this.onModelSelect?.();
											});
										},
										children: html`
											${icon(Sparkles, "sm")}
											<span class="ml-1">${model?.id || i18n("Select Model")}</span>
										`,
										className: "h-8 text-xs truncate",
									})}
								`
								: ""
						}
						${
							this.isStreaming
								? html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.onAbort,
										children: icon(Square, "sm"),
										className: "h-8 w-8",
									})}
								`
								: html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.handleSend,
										disabled: (!this.value.trim() && this.attachments.length === 0) || this.processingFiles,
										children: html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`,
										className: "h-8 w-8",
									})}
								`
						}
					</div>
				</div>
			</div>
		`;
	}

	private renderSlashSuggestions() {
		const state = this.slashSuggestionState;
		if (!state.open) return "";
		const selectedIndex = Math.min(this.selectedSlashSuggestionIndex, state.items.length - 1);
		return html`
			<div class="absolute left-2 right-2 bottom-full mb-2 z-20 rounded-md border border-border bg-card shadow-lg overflow-hidden">
				<div class="max-h-64 overflow-y-auto py-1">
					${
						state.items.length === 0
							? html`
								<div class="px-3 py-3">
									<div class="text-sm font-medium text-muted-foreground">${state.emptyLabel}</div>
									${state.emptyDetail ? html`<div class="text-xs text-muted-foreground mt-1">${state.emptyDetail}</div>` : ""}
								</div>
							`
							: state.items.map((item, index) => {
									const selected = index === selectedIndex;
									return html`
										<button
											type="button"
											class="w-full px-3 py-2 text-left ${selected ? "bg-secondary text-secondary-foreground" : "hover:bg-secondary/70"}"
											@mousedown=${(event: MouseEvent) => {
												event.preventDefault();
												this.applySlashSuggestion(item, state);
											}}
										>
											<div class="text-sm font-medium font-mono truncate">${item.insertText.trim()}</div>
											${item.detail ? html`<div class="text-xs text-muted-foreground truncate">${item.detail}</div>` : ""}
										</button>
									`;
								})
					}
				</div>
			</div>
		`;
	}

	private renderExtensionsMenu() {
		if (!this.extensionsMenuOpen) return "";
		const skillItems = getSlashSuggestionSkills(this.slashSuggestions);
		const selectedIds = new Set(this.slashSelections.items.map((item) => item.id));

		return html`
			<div class="message-editor-extensions-menu absolute left-12 bottom-12 z-30 w-72 rounded-md border border-border bg-card shadow-lg overflow-hidden">
				${
					this.extensionsMenuView === "main"
						? html`
							<div class="py-1">
								<button
									type="button"
									class="w-full px-3 py-2 text-left hover:bg-secondary/70 flex items-center gap-2"
									@mousedown=${(event: MouseEvent) => {
										event.preventDefault();
										this.extensionsMenuView = "skills";
									}}
								>
									${icon(Sparkles, "sm", "text-muted-foreground")}
									<div class="min-w-0 flex-1">
										<div class="text-sm font-medium">${i18n("Skill")}</div>
										<div class="text-xs text-muted-foreground truncate">${i18n("Select global skills")}</div>
									</div>
									${icon(ChevronRight, "sm", "text-muted-foreground")}
								</button>
							</div>
						`
						: html`
							<div class="border-b border-border px-2 py-1 flex items-center gap-1">
								<button
									type="button"
									class="h-8 w-8 inline-flex items-center justify-center rounded-md hover:bg-secondary"
									title=${i18n("Back")}
									@mousedown=${(event: MouseEvent) => {
										event.preventDefault();
										this.extensionsMenuView = "main";
									}}
								>
									${icon(ArrowLeft, "sm")}
								</button>
								<div class="text-sm font-medium">${i18n("Skill")}</div>
							</div>
							<div class="max-h-64 overflow-y-auto py-1">
								${
									skillItems.length === 0
										? html`
											<div class="px-3 py-3">
												<div class="text-sm font-medium text-muted-foreground">${i18n("No skills available")}</div>
												<div class="text-xs text-muted-foreground mt-1">${i18n("Add SKILL.md files under the configured skills directory.")}</div>
											</div>
										`
										: skillItems.map((item) => {
												const selected = selectedIds.has(item.id);
												return html`
													<button
														type="button"
														class="w-full px-3 py-2 text-left hover:bg-secondary/70 flex items-center gap-2 ${selected ? "bg-primary/10 text-primary" : ""}"
														@mousedown=${(event: MouseEvent) => this.toggleSkillSelection(item, event)}
													>
														<span class="h-5 w-5 inline-flex items-center justify-center shrink-0">
															${selected ? icon(Check, "sm", "text-primary") : ""}
														</span>
														<div class="min-w-0 flex-1">
															<div class="text-sm font-medium truncate">${item.label}</div>
															${item.detail ? html`<div class="text-xs text-muted-foreground truncate">${item.detail}</div>` : ""}
														</div>
													</button>
												`;
											})
								}
							</div>
						`
				}
			</div>
		`;
	}

	private renderMessageInput() {
		const selections = this.slashSelections;
		if (selections.items.length === 0) {
			return html`
				<textarea
					class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
					placeholder=${i18n("Type a message...")}
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${this.value}
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					@paste=${this.handlePaste}
					${ref(this.textareaRef)}
				></textarea>
			`;
		}

		const stackSelections = shouldStackSlashSelections(selections.text, selections.items.length);
		const containerClass = stackSelections
			? "px-4 pt-4 pb-2 flex flex-col items-stretch gap-2"
			: "px-4 pt-4 pb-2 flex items-start gap-2";
		const selectionClass = stackSelections
			? "flex flex-wrap items-center gap-1 max-w-full"
			: "shrink-0 flex flex-wrap items-center gap-1 max-w-[55%]";
		const textareaClass = stackSelections
			? "w-full bg-transparent text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
			: "min-w-0 flex-1 bg-transparent text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto";

		return html`
			<div class=${containerClass}>
				<div class=${selectionClass}>
					${selections.items.map(
						(item, index) => html`
							<div
								class="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary/10 px-2 py-1 text-sm font-medium text-primary"
								title=${item.insertText.trim()}
							>
								${icon(Sparkles, "sm", "text-primary")}
								<span class="truncate max-w-40">${item.label}</span>
								<button
									type="button"
									class="ml-1 inline-flex rounded-sm text-primary/70 hover:text-primary"
									@mousedown=${(event: MouseEvent) => {
										event.preventDefault();
										this.removeSlashSelection(index);
									}}
									title=${i18n("Remove")}
								>
									${icon(X, "sm")}
								</button>
							</div>
						`,
					)}
				</div>
				<textarea
					class=${textareaClass}
					placeholder=${i18n("Type a message...")}
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${selections.text}
					spellcheck="true"
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					@paste=${this.handlePaste}
					${ref(this.textareaRef)}
				></textarea>
			</div>
		`;
	}
}
