import { i18n, icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import { Label } from "@mariozechner/mini-lit/dist/Label.js";
import { Select } from "@mariozechner/mini-lit/dist/Select.js";
import { Switch } from "@mariozechner/mini-lit/dist/Switch.js";
import {
	type AssistantMessage,
	type Context,
	completeSimple,
	type Model,
	type SimpleStreamOptions,
	type Tool,
} from "@mariozechner/pi-ai";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import { Plus, X } from "lucide";
import { getAppStorage } from "../storage/app-storage.js";
import type { CustomProvider, CustomProviderType } from "../storage/stores/custom-providers-store.js";
import { discoverModels } from "../utils/model-discovery.js";
import { dispatchCustomProviderSavedEvent } from "./custom-provider-events.js";
import {
	type AnthropicMessagesProfile,
	type AnthropicReasoningReplayFormat,
	type CompatibleMaxTokensField,
	type CompatibleThinkingFormat,
	createManualModelsFromConfigs,
	defaultManualModelConfig,
	type ManualModelConfig,
	manualModelConfigFromModel,
	type OpenAICompletionsProfile,
	type OpenAIResponsesProfile,
} from "./custom-provider-model-config.js";

export class CustomProviderDialog extends DialogBase {
	private provider?: CustomProvider;
	private initialType?: CustomProviderType;
	private onSaveCallback?: () => void;

	@state() private name = "";
	@state() private type: CustomProviderType = "openai-completions";
	@state() private baseUrl = "";
	@state() private apiKey = "";
	@state() private testing = false;
	@state() private testError = "";
	@state() private testSuccess = false;
	@state() private saving = false;
	@state() private saveError = "";
	@state() private discoveredModels: Model<any>[] = [];
	@state() private useNonStreamingToolCalls = false;
	@state() private manualModelConfigs: ManualModelConfig[] = [defaultManualModelConfig()];

	protected modalWidth = "min(800px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(
		provider: CustomProvider | undefined,
		initialType: CustomProviderType | undefined,
		onSave?: () => void,
	) {
		const dialog = new CustomProviderDialog();
		dialog.provider = provider;
		dialog.initialType = initialType;
		dialog.onSaveCallback = onSave;
		document.body.appendChild(dialog);
		dialog.initializeFromProvider();
		dialog.open();
		dialog.requestUpdate();
	}

	private initializeFromProvider() {
		if (this.provider) {
			this.name = this.provider.name;
			this.type = this.provider.type;
			this.baseUrl = this.provider.baseUrl;
			this.apiKey = this.provider.apiKey || "";
			this.discoveredModels = this.provider.models || [];
			this.useNonStreamingToolCalls = this.provider.useNonStreamingToolCalls ?? false;
			this.manualModelConfigs = (this.provider.models || []).map((model) => manualModelConfigFromModel(model));
			if (this.manualModelConfigs.length === 0) this.manualModelConfigs = [defaultManualModelConfig()];
		} else {
			this.name = "";
			this.type = this.initialType || "openai-completions";
			this.baseUrl = "";
			this.updateDefaultBaseUrl();
			this.apiKey = "";
			this.discoveredModels = [];
			this.useNonStreamingToolCalls = false;
			this.manualModelConfigs = [defaultManualModelConfig()];
		}
		this.testError = "";
		this.testSuccess = false;
		this.testing = false;
		this.saving = false;
		this.saveError = "";
	}

	private updateDefaultBaseUrl() {
		if (this.baseUrl) return;

		const defaults: Record<string, string> = {
			ollama: "http://localhost:11434",
			"llama.cpp": "http://localhost:8080",
			vllm: "http://localhost:8000",
			lmstudio: "http://localhost:1234",
			"openai-completions": "",
			"openai-responses": "",
			"anthropic-messages": "",
		};

		this.baseUrl = defaults[this.type] || "";
	}

	private isAutoDiscoveryType(): boolean {
		return this.type === "ollama" || this.type === "llama.cpp" || this.type === "vllm" || this.type === "lmstudio";
	}

	private async testConnection() {
		this.testing = true;
		this.testError = "";
		this.testSuccess = false;
		this.discoveredModels = [];

		try {
			if (this.isAutoDiscoveryType()) {
				const models = await discoverModels(
					this.type as "ollama" | "llama.cpp" | "vllm" | "lmstudio",
					this.baseUrl,
					this.apiKey || undefined,
				);

				this.discoveredModels = models.map((model) => ({
					...model,
					provider: this.name || this.type,
				}));
			} else {
				await this.testManualProvider();
			}
			this.testError = "";
			this.testSuccess = true;
		} catch (error) {
			this.testError = error instanceof Error ? error.message : String(error);
			this.discoveredModels = [];
			this.testSuccess = false;
		} finally {
			this.testing = false;
			this.requestUpdate();
		}
	}

	private async testManualProvider() {
		if (!this.name || !this.baseUrl) throw new Error(i18n("Please fill in all required fields"));
		const models = this.createManualModels({
			id: this.provider?.id || "test-provider",
			name: this.name,
			type: this.type,
			baseUrl: this.baseUrl,
			apiKey: this.apiKey || undefined,
		});
		if (models.length === 0) throw new Error(i18n("Please add at least one model ID"));

		for (const model of models) {
			await this.runCompletionTest(model, this.createTextTestContext(), { maxTokens: 16 }, "text test");

			if (model.input.includes("image")) {
				await this.runCompletionTest(model, this.createVisionTestContext(), { maxTokens: 32 }, "vision test");
			}

			if (model.reasoning) {
				const firstResponse = await this.runCompletionTest(
					model,
					this.createReasoningTestContext(),
					{ maxTokens: 128, reasoning: "low" },
					"reasoning test",
				);
				await this.runCompletionTest(
					model,
					this.createReasoningReplayContext(firstResponse),
					{ maxTokens: 32, reasoning: "low" },
					"reasoning replay test",
				);
				await this.runCompletionTest(
					model,
					this.createToolReplayTestContext(model),
					{ maxTokens: 32, reasoning: "low" },
					"reasoning tool replay test",
				);
			} else {
				await this.runCompletionTest(
					model,
					this.createToolReplayTestContext(model),
					{ maxTokens: 32 },
					"tool replay test",
				);
			}
		}
	}

	private async save() {
		if (this.saving) return;
		if (!this.name || !this.baseUrl) {
			alert(i18n("Please fill in all required fields"));
			return;
		}
		if (!this.isAutoDiscoveryType() && this.parseModelIds().length === 0) {
			alert(i18n("Please add at least one model ID"));
			return;
		}

		try {
			this.saving = true;
			this.saveError = "";
			this.requestUpdate();
			const storage = getAppStorage();
			const baseProvider: Omit<CustomProvider, "models"> = {
				id: this.provider?.id || crypto.randomUUID(),
				name: this.name,
				type: this.type,
				baseUrl: this.baseUrl,
				apiKey: this.apiKey || undefined,
			};
			if (this.isAutoDiscoveryType()) {
				baseProvider.useNonStreamingToolCalls = this.useNonStreamingToolCalls;
			}

			const provider: CustomProvider = {
				...baseProvider,
				models: this.isAutoDiscoveryType() ? undefined : this.createManualModels(baseProvider),
			};

			await storage.customProviders.set(provider);
			dispatchCustomProviderSavedEvent(provider);

			if (this.onSaveCallback) {
				this.onSaveCallback();
			}
			this.close();
		} catch (error) {
			console.error("Failed to save provider:", error);
			this.saveError = error instanceof Error ? error.message : i18n("Failed to save provider");
		} finally {
			this.saving = false;
			this.requestUpdate();
		}
	}

	private async runCompletionTest(
		model: Model<any>,
		context: Context,
		options: Pick<SimpleStreamOptions, "maxTokens" | "reasoning">,
		label: string,
	): Promise<AssistantMessage> {
		const result = await completeSimple(model, context, {
			apiKey: this.apiKey || undefined,
			...options,
		});
		if (result.stopReason === "error") {
			throw new Error(`${model.id} ${label}: ${result.errorMessage || "Connection test failed"}`);
		}
		return result;
	}

	private createTextTestContext(): Context {
		return {
			messages: [{ role: "user", content: "Reply with exactly: ok", timestamp: Date.now() }],
		};
	}

	private createReasoningTestContext(): Context {
		return {
			messages: [{ role: "user", content: "Think briefly, then reply with exactly: ok", timestamp: Date.now() }],
		};
	}

	private createReasoningReplayContext(firstResponse: AssistantMessage): Context {
		const now = Date.now();
		return {
			messages: [
				{ role: "user", content: "Think briefly, then reply with exactly: ok", timestamp: now - 2 },
				firstResponse,
				{ role: "user", content: "Reply with exactly: ok", timestamp: now },
			],
		};
	}

	private createVisionTestContext(): Context {
		return {
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "This is a one-pixel PNG. Reply with exactly: ok" },
						{
							type: "image",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
						},
					],
					timestamp: Date.now(),
				},
			],
		};
	}

	private createToolReplayTestContext(model: Model<any>): Context {
		const now = Date.now();
		const tool: Tool = {
			name: "compat_lookup",
			description: "Returns a fixed compatibility test value.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string" },
				},
				required: ["query"],
			},
		};

		return {
			messages: [
				{ role: "user", content: "Use the compat_lookup tool once.", timestamp: now - 3 },
				{
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [
						{
							type: "toolCall",
							id: "compat_lookup_call",
							name: "compat_lookup",
							arguments: { query: "ping" },
						},
					],
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "toolUse",
					timestamp: now - 2,
				},
				{
					role: "toolResult",
					toolCallId: "compat_lookup_call",
					toolName: "compat_lookup",
					content: [{ type: "text", text: "ok" }],
					isError: false,
					timestamp: now - 1,
				},
				{ role: "user", content: "Reply with exactly: ok", timestamp: now },
			],
			tools: [tool],
		};
	}

	private handleFieldChange(update: () => void) {
		update();
		this.testSuccess = false;
		this.testError = "";
		this.saveError = "";
		this.requestUpdate();
	}

	private parseModelIds(): string[] {
		return this.manualModelConfigs.map((config) => config.id.trim()).filter(Boolean);
	}

	private updateModelId(index: number, value: string) {
		this.updateManualModelConfig(index, { id: value });
	}

	private updateManualModelConfig(index: number, patch: Partial<ManualModelConfig>) {
		this.handleFieldChange(() => {
			this.manualModelConfigs = this.manualModelConfigs.map((config, itemIndex) =>
				itemIndex === index ? { ...config, ...patch } : config,
			);
		});
	}

	private addModelId() {
		this.handleFieldChange(() => {
			this.manualModelConfigs = [...this.manualModelConfigs, defaultManualModelConfig()];
		});
	}

	private removeModelId(index: number) {
		this.handleFieldChange(() => {
			const nextConfigs = this.manualModelConfigs.filter((_, itemIndex) => itemIndex !== index);
			this.manualModelConfigs = nextConfigs.length > 0 ? nextConfigs : [defaultManualModelConfig()];
		});
	}

	private createManualModels(provider: Omit<CustomProvider, "models">): Model<any>[] {
		return createManualModelsFromConfigs(provider, this.manualModelConfigs);
	}

	private updateThinkingFormat(index: number, value: string) {
		const thinkingFormat = value as CompatibleThinkingFormat;
		const supportsReasoningEffort =
			thinkingFormat === "openai" || thinkingFormat === "openrouter" || thinkingFormat === "deepseek";
		this.updateManualModelConfig(index, {
			thinkingFormat,
			supportsReasoningEffort,
			requiresReasoningContentOnAssistantMessages: thinkingFormat === "deepseek",
			maxTokensField: thinkingFormat === "openai" ? "max_completion_tokens" : "max_tokens",
		});
	}

	private updateOpenAICompletionsProfile(index: number, value: string) {
		const profile = value as OpenAICompletionsProfile;
		const patch: Partial<ManualModelConfig> = { openAICompletionsProfile: profile };

		if (profile === "standard") {
			Object.assign(patch, {
				thinkingFormat: "openai",
				requiresReasoningContentOnAssistantMessages: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_completion_tokens",
			});
		} else if (profile === "local-basic") {
			Object.assign(patch, {
				thinkingFormat: "openai",
				requiresReasoningContentOnAssistantMessages: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			});
		} else if (profile === "deepseek-mimo") {
			Object.assign(patch, {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			});
		} else if (profile === "mimo") {
			Object.assign(patch, {
				thinkingFormat: "deepseek",
				requiresReasoningContentOnAssistantMessages: true,
				supportsReasoningEffort: true,
				maxTokensField: "max_completion_tokens",
			});
		} else if (profile === "openrouter") {
			Object.assign(patch, {
				thinkingFormat: "openrouter",
				requiresReasoningContentOnAssistantMessages: false,
				supportsReasoningEffort: true,
				maxTokensField: "max_tokens",
			});
		} else if (profile === "qwen" || profile === "qwen-chat-template" || profile === "zai") {
			Object.assign(patch, {
				thinkingFormat: profile,
				requiresReasoningContentOnAssistantMessages: false,
				supportsReasoningEffort: false,
				maxTokensField: "max_tokens",
			});
		}

		this.updateManualModelConfig(index, patch);
	}

	private updateOpenAIResponsesProfile(index: number, value: string) {
		const profile = value as OpenAIResponsesProfile;
		this.updateManualModelConfig(index, {
			openAIResponsesProfile: profile,
			sendSessionIdHeader: profile !== "generic-gateway",
			openAIResponsesSupportsLongCacheRetention: profile !== "generic-gateway",
		});
	}

	private updateAnthropicMessagesProfile(index: number, value: string) {
		const profile = value as AnthropicMessagesProfile;
		const patch: Partial<ManualModelConfig> = { anthropicMessagesProfile: profile };

		if (profile === "standard") {
			Object.assign(patch, {
				anthropicReasoningReplayFormat: "anthropic-signature",
				supportsEagerToolInputStreaming: true,
				anthropicSupportsLongCacheRetention: true,
			});
		} else if (profile === "mimo-deepseek") {
			Object.assign(patch, {
				anthropicReasoningReplayFormat: "deepseek-reasoning-content",
				supportsEagerToolInputStreaming: true,
				anthropicSupportsLongCacheRetention: true,
			});
		} else if (profile === "legacy-compatible") {
			Object.assign(patch, {
				anthropicReasoningReplayFormat: "anthropic-signature",
				supportsEagerToolInputStreaming: false,
				anthropicSupportsLongCacheRetention: true,
			});
		}

		this.updateManualModelConfig(index, patch);
	}

	private openAICompletionsProfileDescription(config: ManualModelConfig): string {
		switch (config.openAICompletionsProfile) {
			case "standard":
				return i18n("Use when the endpoint closely follows OpenAI Chat Completions.");
			case "local-basic":
				return i18n("Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.");
			case "deepseek-mimo":
				return i18n("Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.");
			case "mimo":
				return i18n("Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.");
			case "openrouter":
				return i18n("Use for OpenRouter endpoints that configure thinking with the nested reasoning field.");
			case "qwen":
				return i18n("Use for Qwen endpoints that enable thinking with enable_thinking.");
			case "qwen-chat-template":
				return i18n("Use when the provider requires chat_template_kwargs.enable_thinking.");
			case "zai":
				return i18n("Use for Z.AI endpoints that enable thinking with enable_thinking.");
			case "custom":
				return i18n("Use only when you need to tune low-level compatibility switches manually.");
		}
	}

	private openAIResponsesProfileDescription(config: ManualModelConfig): string {
		switch (config.openAIResponsesProfile) {
			case "standard":
				return i18n("Use when the endpoint follows the official OpenAI Responses API.");
			case "generic-gateway":
				return i18n("Use for Responses-compatible gateways that reject session_id or long cache retention.");
			case "custom":
				return i18n("Use only when you need to tune low-level compatibility switches manually.");
		}
	}

	private anthropicMessagesProfileDescription(config: ManualModelConfig): string {
		switch (config.anthropicMessagesProfile) {
			case "standard":
				return i18n("Use for official Anthropic or compatible endpoints that replay signed thinking blocks.");
			case "mimo-deepseek":
				return i18n("Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.");
			case "legacy-compatible":
				return i18n("Use for Anthropic-compatible endpoints that reject eager tool input streaming.");
			case "custom":
				return i18n("Use only when you need to tune low-level compatibility switches manually.");
		}
	}

	private renderManualModelConfig(config: ManualModelConfig, index: number): TemplateResult {
		const showOpenAICompat = this.type === "openai-completions";
		const showOpenAIResponsesCompat = this.type === "openai-responses";
		const showAnthropicCompat = this.type === "anthropic-messages";
		const showOpenAIAdvanced = showOpenAICompat && config.openAICompletionsProfile === "custom";
		const showOpenAIResponsesAdvanced = showOpenAIResponsesCompat && config.openAIResponsesProfile === "custom";
		const showAnthropicAdvanced = showAnthropicCompat && config.anthropicMessagesProfile === "custom";
		return html`
			<div class="rounded-md border border-border p-3 flex flex-col gap-3">
				<div class="flex items-center gap-2">
					${Input({
						value: config.id,
						placeholder: i18n("e.g., gpt-oss-120b"),
						onInput: (e: Event) => this.updateModelId(index, (e.target as HTMLInputElement).value),
						className: "flex-1",
					})}
					${Button({
						onClick: () => this.removeModelId(index),
						variant: "ghost",
						size: "icon",
						disabled: this.manualModelConfigs.length === 1 && !config.id.trim(),
						children: icon(X, "sm"),
						title: i18n("Remove model"),
					})}
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
						<span class="text-sm text-foreground">${i18n("Vision")}</span>
						${Switch({
							checked: config.vision,
							onChange: (checked: boolean) => this.updateManualModelConfig(index, { vision: checked }),
						})}
					</div>
					<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
						<span class="text-sm text-foreground">${i18n("Reasoning")}</span>
						${Switch({
							checked: config.reasoning,
							onChange: (checked: boolean) => this.updateManualModelConfig(index, { reasoning: checked }),
						})}
					</div>
				</div>

				<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
					<div class="flex flex-col gap-1">
						${Label({ children: i18n("Context window") })}
						${Input({
							value: config.contextWindow,
							onInput: (e: Event) =>
								this.updateManualModelConfig(index, { contextWindow: (e.target as HTMLInputElement).value }),
						})}
					</div>
					<div class="flex flex-col gap-1">
						${Label({ children: i18n("Max output tokens") })}
						${Input({
							value: config.maxTokens,
							onInput: (e: Event) =>
								this.updateManualModelConfig(index, { maxTokens: (e.target as HTMLInputElement).value }),
						})}
					</div>
				</div>

				${
					showOpenAICompat
						? html`
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
								<div class="flex flex-col gap-1">
									${Label({ children: i18n("Compatibility mode") })}
									${Select({
										value: config.openAICompletionsProfile,
										options: [
											{ value: "standard", label: "Standard OpenAI-compatible" },
											{ value: "local-basic", label: "Local/basic compatible" },
											{ value: "deepseek-mimo", label: "DeepSeek reasoning_content" },
											{ value: "mimo", label: "MiMo reasoning_content" },
											{ value: "openrouter", label: "OpenRouter reasoning" },
											{ value: "qwen", label: "Qwen enable_thinking" },
											{ value: "qwen-chat-template", label: "Qwen chat_template" },
											{ value: "zai", label: "Z.AI enable_thinking" },
											{ value: "custom", label: "Custom advanced" },
										],
										onChange: (value: string) => this.updateOpenAICompletionsProfile(index, value),
										width: "100%",
									})}
									<p class="text-xs text-muted-foreground leading-relaxed">
										${this.openAICompletionsProfileDescription(config)}
									</p>
								</div>
							</div>
							${
								showOpenAIAdvanced
									? html`
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
											<div class="flex flex-col gap-1">
												${Label({ children: i18n("Max tokens field") })}
												${Select({
													value: config.maxTokensField,
													options: [
														{ value: "max_completion_tokens", label: "max_completion_tokens" },
														{ value: "max_tokens", label: "max_tokens" },
													],
													onChange: (value: string) =>
														this.updateManualModelConfig(index, {
															maxTokensField: value as CompatibleMaxTokensField,
														}),
													width: "100%",
												})}
											</div>
											${
												config.reasoning
													? html`
														<div class="flex flex-col gap-1">
															${Label({ children: i18n("Thinking protocol") })}
															${Select({
																value: config.thinkingFormat,
																options: [
																	{ value: "openai", label: "OpenAI reasoning_effort" },
																	{ value: "openrouter", label: "OpenRouter reasoning" },
																	{ value: "deepseek", label: "DeepSeek reasoning_content" },
																	{ value: "qwen", label: "Qwen enable_thinking" },
																	{ value: "qwen-chat-template", label: "Qwen chat_template" },
																	{ value: "zai", label: "Z.AI enable_thinking" },
																],
																onChange: (value: string) => this.updateThinkingFormat(index, value),
																width: "100%",
															})}
														</div>
													`
													: ""
											}
										</div>
										${
											config.reasoning
												? html`
													<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
														<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
															<span class="text-sm text-foreground">${i18n("Send reasoning effort")}</span>
															${Switch({
																checked: config.supportsReasoningEffort,
																onChange: (checked: boolean) =>
																	this.updateManualModelConfig(index, {
																		supportsReasoningEffort: checked,
																	}),
															})}
														</div>
														<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
															<span class="text-sm text-foreground">${i18n("Replay reasoning_content")}</span>
															${Switch({
																checked: config.requiresReasoningContentOnAssistantMessages,
																onChange: (checked: boolean) =>
																	this.updateManualModelConfig(index, {
																		requiresReasoningContentOnAssistantMessages: checked,
																	}),
															})}
														</div>
													</div>
												`
												: ""
										}
									`
									: ""
							}
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
								<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
									<span class="text-sm text-foreground">${i18n("Non-streaming tool calls")}</span>
									${Switch({
										checked: config.useNonStreamingToolCalls,
										onChange: (checked: boolean) =>
											this.updateManualModelConfig(index, {
												useNonStreamingToolCalls: checked,
											}),
									})}
								</div>
							</div>
						`
						: ""
				}
				${
					showOpenAIResponsesCompat
						? html`
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
								<div class="flex flex-col gap-1">
									${Label({ children: i18n("Compatibility mode") })}
									${Select({
										value: config.openAIResponsesProfile,
										options: [
											{ value: "standard", label: "Standard OpenAI Responses" },
											{ value: "generic-gateway", label: "Generic Responses gateway" },
											{ value: "custom", label: "Custom advanced" },
										],
										onChange: (value: string) => this.updateOpenAIResponsesProfile(index, value),
										width: "100%",
									})}
									<p class="text-xs text-muted-foreground leading-relaxed">
										${this.openAIResponsesProfileDescription(config)}
									</p>
								</div>
							</div>
							${
								showOpenAIResponsesAdvanced
									? html`
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
											<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
												<span class="text-sm text-foreground">${i18n("Send session_id header")}</span>
												${Switch({
													checked: config.sendSessionIdHeader,
													onChange: (checked: boolean) =>
														this.updateManualModelConfig(index, { sendSessionIdHeader: checked }),
												})}
											</div>
											<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
												<span class="text-sm text-foreground">${i18n("Long cache retention")}</span>
												${Switch({
													checked: config.openAIResponsesSupportsLongCacheRetention,
													onChange: (checked: boolean) =>
														this.updateManualModelConfig(index, {
															openAIResponsesSupportsLongCacheRetention: checked,
														}),
												})}
											</div>
										</div>
									`
									: ""
							}
						`
						: ""
				}
				${
					showAnthropicCompat
						? html`
							<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
								<div class="flex flex-col gap-1">
									${Label({ children: i18n("Compatibility mode") })}
									${Select({
										value: config.anthropicMessagesProfile,
										options: [
											{ value: "standard", label: "Standard Anthropic signed thinking" },
											{ value: "mimo-deepseek", label: "MiMo / DeepSeek reasoning_content" },
											{ value: "legacy-compatible", label: "Legacy Anthropic-compatible" },
											{ value: "custom", label: "Custom advanced" },
										],
										onChange: (value: string) => this.updateAnthropicMessagesProfile(index, value),
										width: "100%",
									})}
									<p class="text-xs text-muted-foreground leading-relaxed">
										${this.anthropicMessagesProfileDescription(config)}
									</p>
								</div>
							</div>
							${
								showAnthropicAdvanced
									? html`
										<div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
											${
												config.reasoning
													? html`
														<div class="flex flex-col gap-1">
															${Label({ children: i18n("Reasoning replay") })}
															${Select({
																value: config.anthropicReasoningReplayFormat,
																options: [
																	{ value: "anthropic-signature", label: "Anthropic signed thinking" },
																	{
																		value: "deepseek-reasoning-content",
																		label: "DeepSeek / MiMo reasoning_content",
																	},
																],
																onChange: (value: string) =>
																	this.updateManualModelConfig(index, {
																		anthropicReasoningReplayFormat:
																			value as AnthropicReasoningReplayFormat,
																	}),
																width: "100%",
															})}
														</div>
													`
													: ""
											}
											<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
												<span class="text-sm text-foreground">${i18n("Eager tool input streaming")}</span>
												${Switch({
													checked: config.supportsEagerToolInputStreaming,
													onChange: (checked: boolean) =>
														this.updateManualModelConfig(index, {
															supportsEagerToolInputStreaming: checked,
														}),
												})}
											</div>
											<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
												<span class="text-sm text-foreground">${i18n("Long cache retention")}</span>
												${Switch({
													checked: config.anthropicSupportsLongCacheRetention,
													onChange: (checked: boolean) =>
														this.updateManualModelConfig(index, {
															anthropicSupportsLongCacheRetention: checked,
														}),
												})}
											</div>
										</div>
									`
									: ""
							}
						`
						: ""
				}
			</div>
		`;
	}

	protected override renderContent(): TemplateResult {
		const providerTypes = [
			{ value: "ollama", label: "Ollama (auto-discovery)" },
			{ value: "llama.cpp", label: "llama.cpp (auto-discovery)" },
			{ value: "vllm", label: "vLLM (auto-discovery)" },
			{ value: "lmstudio", label: "LM Studio (auto-discovery)" },
			{ value: "openai-completions", label: "OpenAI Completions Compatible" },
			{ value: "openai-responses", label: "OpenAI Responses Compatible" },
			{ value: "anthropic-messages", label: "Anthropic Messages Compatible" },
		];

		return html`
			<div class="flex flex-col h-full overflow-hidden">
				<div class="p-6 flex-shrink-0 border-b border-border">
					<h2 class="text-lg font-semibold text-foreground">
						${this.provider ? i18n("Edit Provider") : i18n("Add Provider")}
					</h2>
				</div>

				<div class="flex-1 overflow-y-auto p-6">
					<div class="flex flex-col gap-4">
						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-name", children: i18n("Provider Name") })}
							${Input({
								value: this.name,
								placeholder: i18n("e.g., My Ollama Server"),
								onInput: (e: Event) => {
									this.handleFieldChange(() => {
										this.name = (e.target as HTMLInputElement).value;
									});
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "provider-type", children: i18n("Provider Type") })}
							${Select({
								value: this.type,
								options: providerTypes.map((pt) => ({
									value: pt.value,
									label: pt.label,
								})),
								onChange: (value: string) => {
									this.handleFieldChange(() => {
										this.type = value as CustomProviderType;
										this.baseUrl = "";
										this.updateDefaultBaseUrl();
									});
								},
								width: "100%",
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "base-url", children: i18n("Base URL") })}
							${Input({
								value: this.baseUrl,
								placeholder: i18n("e.g., http://localhost:11434"),
								onInput: (e: Event) => {
									this.handleFieldChange(() => {
										this.baseUrl = (e.target as HTMLInputElement).value;
									});
								},
							})}
						</div>

						<div class="flex flex-col gap-2">
							${Label({ htmlFor: "api-key", children: i18n("API Key (Optional)") })}
							${Input({
								type: "password",
								value: this.apiKey,
								placeholder: i18n("Leave empty if not required"),
								onInput: (e: Event) => {
									this.handleFieldChange(() => {
										this.apiKey = (e.target as HTMLInputElement).value;
									});
								},
							})}
						</div>

						${
							this.isAutoDiscoveryType()
								? html`
									<div class="flex flex-col gap-2">
										<div class="flex items-center justify-between rounded-md border border-border px-3 py-2">
											<span class="text-sm text-foreground">${i18n("Non-streaming tool calls")}</span>
											${Switch({
												checked: this.useNonStreamingToolCalls,
												onChange: (checked: boolean) =>
													this.handleFieldChange(() => {
														this.useNonStreamingToolCalls = checked;
													}),
											})}
										</div>
										${Button({
											onClick: () => this.testConnection(),
											variant: "outline",
											disabled: this.testing || !this.baseUrl,
											children: this.testing ? i18n("Testing...") : i18n("Test Connection"),
										})}
										${this.testError ? html` <div class="text-sm text-destructive">${this.testError}</div> ` : ""}
										${
											this.discoveredModels.length > 0
												? html`
													<div class="text-sm text-muted-foreground">
														${i18n("Discovered")} ${this.discoveredModels.length} ${i18n("models")}:
														<ul class="list-disc list-inside mt-2">
															${this.discoveredModels.slice(0, 5).map((model) => html`<li>${model.name}</li>`)}
															${
																this.discoveredModels.length > 5
																	? html`<li>...${i18n("and")} ${this.discoveredModels.length - 5} ${i18n("more")}</li>`
																	: ""
															}
														</ul>
													</div>
												`
												: ""
										}
									</div>
								`
								: html` <div class="text-sm text-muted-foreground">
									${i18n("Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.")}
								</div>`
						}
						${
							!this.isAutoDiscoveryType()
								? html`
									<div class="flex flex-col gap-2">
										${Label({ htmlFor: "model-configs", children: i18n("Models") })}
										<div id="model-configs" class="flex flex-col gap-3">
											${this.manualModelConfigs.map((config, index) => this.renderManualModelConfig(config, index))}
										</div>
										<div>
											${Button({
												onClick: () => this.addModelId(),
												variant: "outline",
												size: "sm",
												children: html`<span class="inline-flex items-center gap-1">${icon(Plus, "sm")} ${i18n("Add Model")}</span>`,
											})}
										</div>
									</div>
								`
								: ""
						}
						${
							!this.isAutoDiscoveryType()
								? html`
									<div class="flex flex-col gap-2">
										${Button({
											onClick: () => this.testConnection(),
											variant: "outline",
											disabled:
												this.testing || !this.name || !this.baseUrl || this.parseModelIds().length === 0,
											children: this.testing ? i18n("Testing...") : i18n("Test Connection"),
										})}
										${this.testSuccess ? html` <div class="text-sm text-green-600">${i18n("✓ Valid")}</div> ` : ""}
										${this.testError ? html` <div class="text-sm text-destructive">${this.testError}</div> ` : ""}
										${this.saveError ? html` <div class="text-sm text-destructive">${this.saveError}</div> ` : ""}
									</div>
								`
								: ""
						}
					</div>
				</div>

				<div class="p-6 flex-shrink-0 border-t border-border flex justify-end gap-2">
					${Button({
						onClick: () => this.close(),
						variant: "ghost",
						disabled: this.saving,
						children: i18n("Cancel"),
					})}
					${Button({
						onClick: () => this.save(),
						variant: "default",
						disabled:
							this.saving ||
							!this.name ||
							!this.baseUrl ||
							(!this.isAutoDiscoveryType() && this.parseModelIds().length === 0),
						children: this.saving ? i18n("Saving...") : i18n("Save"),
					})}
				</div>
			</div>
		`;
	}
}

customElements.define("custom-provider-dialog", CustomProviderDialog);
