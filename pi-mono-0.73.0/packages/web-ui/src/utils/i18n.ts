import {
	defaultEnglish,
	defaultGerman,
	type LanguageCode,
	type MiniLitRequiredMessages,
	setTranslations,
} from "@mariozechner/mini-lit";

export const LANGUAGE_CHANGE_EVENT = "pi-language-change";

export function setLanguage(code: LanguageCode) {
	localStorage.setItem("language", code);
	window.dispatchEvent(new CustomEvent(LANGUAGE_CHANGE_EVENT, { detail: { language: code } }));
}

declare module "@mariozechner/mini-lit" {
	interface i18nMessages extends MiniLitRequiredMessages {
		Free: string;
		"Input Required": string;
		Cancel: string;
		Confirm: string;
		"Select Model": string;
		"Please select a model first.": string;
		"Search models...": string;
		Format: string;
		Thinking: string;
		Vision: string;
		Reasoning: string;
		You: string;
		Assistant: string;
		"Thinking...": string;
		"Type your message...": string;
		"API Keys Configuration": string;
		"Configure API keys for LLM providers. Keys are stored locally in your browser.": string;
		Configured: string;
		"Not configured": string;
		"✓ Valid": string;
		"✗ Invalid": string;
		"Testing...": string;
		Update: string;
		Test: string;
		Remove: string;
		Save: string;
		"Saving...": string;
		"Update API key": string;
		"Enter API key": string;
		"Type a message...": string;
		Extensions: string;
		Skill: string;
		"Select global skills": string;
		Back: string;
		"No skills available": string;
		"Add SKILL.md files under the configured skills directory.": string;
		"Failed to fetch file": string;
		"Invalid source type": string;
		PDF: string;
		Document: string;
		Presentation: string;
		Spreadsheet: string;
		Text: string;
		"Error loading file": string;
		"No text content available": string;
		"Failed to load PDF": string;
		"Failed to load document": string;
		"Failed to load spreadsheet": string;
		"Error loading PDF": string;
		"Error loading document": string;
		"Error loading spreadsheet": string;
		"Preview not available for this file type.": string;
		"Click the download button above to view it on your computer.": string;
		"No content available": string;
		"Failed to display text content": string;
		"API keys are required to use AI models. Get your keys from the provider's website.": string;
		console: string;
		"Copy output": string;
		"Copied!": string;
		"Error:": string;
		"Request aborted": string;
		Call: string;
		Result: string;
		"(no result)": string;
		"Waiting for tool result…": string;
		"Call was aborted; no result.": string;
		"No session available": string;
		"No session set": string;
		"Preparing tool parameters...": string;
		"(no output)": string;
		Input: string;
		Output: string;
		"Writing expression...": string;
		"Waiting for expression...": string;
		Calculating: string;
		"Getting current time in": string;
		"Getting current date and time": string;
		"Waiting for command...": string;
		"Writing command...": string;
		"Running command...": string;
		"Command failed:": string;
		"Enter Auth Token": string;
		"Please enter your auth token.": string;
		"Auth token is required for proxy transport": string;
		// JavaScript REPL strings
		"Execution aborted": string;
		"Code parameter is required": string;
		"Unknown error": string;
		"Code executed successfully (no output)": string;
		"Execution failed": string;
		"JavaScript REPL": string;
		"JavaScript code to execute": string;
		"Writing JavaScript code...": string;
		"Executing JavaScript": string;
		"Preparing JavaScript...": string;
		"Preparing command...": string;
		"Preparing calculation...": string;
		"Preparing tool...": string;
		"Getting time...": string;
		// Artifacts strings
		"Processing artifact...": string;
		"Preparing artifact...": string;
		"Processing artifact": string;
		"Processed artifact": string;
		"Creating artifact": string;
		"Created artifact": string;
		"Updating artifact": string;
		"Updated artifact": string;
		"Rewriting artifact": string;
		"Rewrote artifact": string;
		"Getting artifact": string;
		"Got artifact": string;
		"Deleting artifact": string;
		"Deleted artifact": string;
		"Getting logs": string;
		"Got logs": string;
		"An error occurred": string;
		"Copy logs": string;
		"Autoscroll enabled": string;
		"Autoscroll disabled": string;
		Processing: string;
		Create: string;
		Rewrite: string;
		Get: string;
		Delete: string;
		"Get logs": string;
		"Show artifacts": string;
		"Close artifacts": string;
		Artifacts: string;
		"Copy HTML": string;
		"Download HTML": string;
		"Reload HTML": string;
		"Copy SVG": string;
		"Download SVG": string;
		"Copy Markdown": string;
		"Download Markdown": string;
		Download: string;
		"No logs for {filename}": string;
		"API Keys Settings": string;
		Settings: string;
		"API Keys": string;
		Proxy: string;
		"Use CORS Proxy": string;
		"Proxy URL": string;
		"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>": string;
		"Settings are stored locally in your browser": string;
		Clear: string;
		"API Key Required": string;
		"Enter your API key for {provider}": string;
		"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.": string;
		Off: string;
		Minimal: string;
		Low: string;
		Medium: string;
		High: string;
		"Storage Permission Required": string;
		"This app needs persistent storage to save your conversations": string;
		"Why is this needed?": string;
		"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.": string;
		"What this means:": string;
		"Your conversations will be saved locally in your browser": string;
		"Data will not be deleted automatically to free up space": string;
		"You can still manually clear data at any time": string;
		"No data is sent to external servers": string;
		"Continue Anyway": string;
		"Requesting...": string;
		"Grant Permission": string;
		Sessions: string;
		"Load a previous conversation": string;
		"No sessions yet": string;
		"Delete this session?": string;
		Today: string;
		Yesterday: string;
		"{days} days ago": string;
		messages: string;
		tokens: string;
		"Drop files here": string;
		// Providers & Models
		"Providers & Models": string;
		"Cloud Providers": string;
		"Cloud LLM providers with predefined models. API keys are stored locally in your browser.": string;
		"Custom Providers": string;
		"User-configured servers with auto-discovered or manually defined models.": string;
		"Add Provider": string;
		"No custom providers configured. Click 'Add Provider' to get started.": string;
		"No custom models configured. Add a custom provider in Settings first.": string;
		Models: string;
		"auto-discovered": string;
		Refresh: string;
		Edit: string;
		"Are you sure you want to delete this provider?": string;
		"Edit Provider": string;
		"Provider Name": string;
		"e.g., My Ollama Server": string;
		"Provider Type": string;
		"Base URL": string;
		"e.g., http://localhost:11434": string;
		"API Key (Optional)": string;
		"Leave empty if not required": string;
		"Test Connection": string;
		Discovered: string;
		models: string;
		and: string;
		more: string;
		"For manual provider types, add models after saving the provider.": string;
		"Enter one or more model IDs. Separate multiple models with new lines or commas.": string;
		"Enter one model ID per row. Use the exact ID reported by your model service.": string;
		"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.": string;
		"Model IDs": string;
		"Add Model": string;
		"Remove model": string;
		"e.g., gpt-oss-120b": string;
		"Context window": string;
		"Max output tokens": string;
		"Max tokens field": string;
		"Thinking protocol": string;
		"Send reasoning effort": string;
		"Replay reasoning_content": string;
		"Non-streaming tool calls": string;
		"Compatibility profile": string;
		"Compatibility mode": string;
		"Use when the endpoint closely follows OpenAI Chat Completions.": string;
		"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.": string;
		"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.": string;
		"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.": string;
		"Use for Qwen endpoints that enable thinking with enable_thinking.": string;
		"Use when the provider requires chat_template_kwargs.enable_thinking.": string;
		"Use for Z.AI endpoints that enable thinking with enable_thinking.": string;
		"Use only when you need to tune low-level compatibility switches manually.": string;
		"Use when the endpoint follows the official OpenAI Responses API.": string;
		"Use for Responses-compatible gateways that reject session_id or long cache retention.": string;
		"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.": string;
		"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.": string;
		"Use for Anthropic-compatible endpoints that reject eager tool input streaming.": string;
		"Send session_id header": string;
		"Long cache retention": string;
		"Reasoning replay": string;
		"Eager tool input streaming": string;
		"Please fill in all required fields": string;
		"Please add at least one model ID": string;
		"Failed to save provider": string;
		"OpenAI Completions Compatible": string;
		"OpenAI Responses Compatible": string;
		"Anthropic Messages Compatible": string;
		"Checking...": string;
		Disconnected: string;
		Language: string;
		"Display language": string;
		"Choose the interface language for this browser.": string;
		"Language changes are saved locally in this browser.": string;
		"Interface language": string;
		English: string;
		"Simplified Chinese": string;
		German: string;
		Malay: string;
		"AI Coding Platform": string;
		"New Session": string;
		"Click to edit title": string;
		"Demo: Add Custom Notification": string;
		"AITC platform logo": string;
		"Load a browser or configured local conversation": string;
		"Load a browser conversation": string;
		"Creating file": string;
		"Created file": string;
		"Rewriting file": string;
		"Updating file": string;
		"Updated file": string;
		"Reading file": string;
		"Read file": string;
		"Deleting file": string;
		"Deleted file": string;
		"Listing project files": string;
		"Listed project files": string;
		"File operation failed": string;
		"Processing file": string;
		"Processed file": string;
		"Running command": string;
		"Ran command": string;
		"Preview ready": string;
		"Preparing preview": string;
		"Prepared preview": string;
	}
}

export const translations = {
	en: {
		...defaultEnglish,
		Free: "Free",
		"Input Required": "Input Required",
		Cancel: "Cancel",
		Confirm: "Confirm",
		"Select Model": "Select Model",
		"Please select a model first.": "Please select a model first.",
		"Search models...": "Search models...",
		Format: "Format",
		Thinking: "Thinking",
		Vision: "Vision",
		Reasoning: "Reasoning",
		You: "You",
		Assistant: "Assistant",
		"Thinking...": "Thinking...",
		"Type your message...": "Type your message...",
		"API Keys Configuration": "API Keys Configuration",
		"Configure API keys for LLM providers. Keys are stored locally in your browser.":
			"Configure API keys for LLM providers. Keys are stored locally in your browser.",
		Configured: "Configured",
		"Not configured": "Not configured",
		"✓ Valid": "✓ Valid",
		"✗ Invalid": "✗ Invalid",
		"Testing...": "Testing...",
		Update: "Update",
		Test: "Test",
		Remove: "Remove",
		Save: "Save",
		"Saving...": "Saving...",
		"Update API key": "Update API key",
		"Enter API key": "Enter API key",
		"Type a message...": "Type a message...",
		Extensions: "Extensions",
		Skill: "Skill",
		"Select global skills": "Select global skills",
		Back: "Back",
		"No skills available": "No skills available",
		"Add SKILL.md files under the configured skills directory.":
			"Add SKILL.md files under the configured skills directory.",
		"Failed to fetch file": "Failed to fetch file",
		"Invalid source type": "Invalid source type",
		PDF: "PDF",
		Document: "Document",
		Presentation: "Presentation",
		Spreadsheet: "Spreadsheet",
		Text: "Text",
		"Error loading file": "Error loading file",
		"No text content available": "No text content available",
		"Failed to load PDF": "Failed to load PDF",
		"Failed to load document": "Failed to load document",
		"Failed to load spreadsheet": "Failed to load spreadsheet",
		"Error loading PDF": "Error loading PDF",
		"Error loading document": "Error loading document",
		"Error loading spreadsheet": "Error loading spreadsheet",
		"Preview not available for this file type.": "Preview not available for this file type.",
		"Click the download button above to view it on your computer.":
			"Click the download button above to view it on your computer.",
		"No content available": "No content available",
		"Failed to display text content": "Failed to display text content",
		"API keys are required to use AI models. Get your keys from the provider's website.":
			"API keys are required to use AI models. Get your keys from the provider's website.",
		console: "console",
		"Copy output": "Copy output",
		"Copied!": "Copied!",
		"Error:": "Error:",
		"Request aborted": "Request aborted",
		Call: "Call",
		Result: "Result",
		"(no result)": "(no result)",
		"Waiting for tool result…": "Waiting for tool result…",
		"Call was aborted; no result.": "Call was aborted; no result.",
		"No session available": "No session available",
		"No session set": "No session set",
		"Preparing tool parameters...": "Preparing tool parameters...",
		"(no output)": "(no output)",
		Input: "Input",
		Output: "Output",
		"Waiting for expression...": "Waiting for expression...",
		"Writing expression...": "Writing expression...",
		Calculating: "Calculating",
		"Getting current time in": "Getting current time in",
		"Getting current date and time": "Getting current date and time",
		"Waiting for command...": "Waiting for command...",
		"Writing command...": "Writing command...",
		"Running command...": "Running command...",
		"Command failed": "Command failed",
		"Enter Auth Token": "Enter Auth Token",
		"Please enter your auth token.": "Please enter your auth token.",
		"Auth token is required for proxy transport": "Auth token is required for proxy transport",
		// JavaScript REPL strings
		"Execution aborted": "Execution aborted",
		"Code parameter is required": "Code parameter is required",
		"Unknown error": "Unknown error",
		"Code executed successfully (no output)": "Code executed successfully (no output)",
		"Execution failed": "Execution failed",
		"JavaScript REPL": "JavaScript REPL",
		"JavaScript code to execute": "JavaScript code to execute",
		"Writing JavaScript code...": "Writing JavaScript code...",
		"Executing JavaScript": "Executing JavaScript",
		"Preparing JavaScript...": "Preparing JavaScript...",
		"Preparing command...": "Preparing command...",
		"Preparing calculation...": "Preparing calculation...",
		"Preparing tool...": "Preparing tool...",
		"Getting time...": "Getting time...",
		// Artifacts strings
		"Processing artifact...": "Processing artifact...",
		"Preparing artifact...": "Preparing artifact...",
		"Processing artifact": "Processing artifact",
		"Processed artifact": "Processed artifact",
		"Creating artifact": "Creating artifact",
		"Created artifact": "Created artifact",
		"Updating artifact": "Updating artifact",
		"Updated artifact": "Updated artifact",
		"Rewriting artifact": "Rewriting artifact",
		"Rewrote artifact": "Rewrote artifact",
		"Getting artifact": "Getting artifact",
		"Got artifact": "Got artifact",
		"Deleting artifact": "Deleting artifact",
		"Deleted artifact": "Deleted artifact",
		"Getting logs": "Getting logs",
		"Got logs": "Got logs",
		"An error occurred": "An error occurred",
		"Copy logs": "Copy logs",
		"Autoscroll enabled": "Autoscroll enabled",
		"Autoscroll disabled": "Autoscroll disabled",
		Processing: "Processing",
		Create: "Create",
		Rewrite: "Rewrite",
		Get: "Get",
		"Get logs": "Get logs",
		"Show artifacts": "Show artifacts",
		"Close artifacts": "Close artifacts",
		Artifacts: "Artifacts",
		"Copy HTML": "Copy HTML",
		"Download HTML": "Download HTML",
		"Reload HTML": "Reload HTML",
		"Copy SVG": "Copy SVG",
		"Download SVG": "Download SVG",
		"Copy Markdown": "Copy Markdown",
		"Download Markdown": "Download Markdown",
		Download: "Download",
		"No logs for {filename}": "No logs for {filename}",
		"API Keys Settings": "API Keys Settings",
		Settings: "Settings",
		"API Keys": "API Keys",
		Proxy: "Proxy",
		"Use CORS Proxy": "Use CORS Proxy",
		"Proxy URL": "Proxy URL",
		"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>":
			"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>",
		"Settings are stored locally in your browser": "Settings are stored locally in your browser",
		Clear: "Clear",
		"API Key Required": "API Key Required",
		"Enter your API key for {provider}": "Enter your API key for {provider}",
		"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.":
			"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.",
		Off: "Off",
		Minimal: "Minimal",
		Low: "Low",
		Medium: "Medium",
		High: "High",
		"Storage Permission Required": "Storage Permission Required",
		"This app needs persistent storage to save your conversations":
			"This app needs persistent storage to save your conversations",
		"Why is this needed?": "Why is this needed?",
		"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.":
			"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.",
		"What this means:": "What this means:",
		"Your conversations will be saved locally in your browser":
			"Your conversations will be saved locally in your browser",
		"Data will not be deleted automatically to free up space":
			"Data will not be deleted automatically to free up space",
		"You can still manually clear data at any time": "You can still manually clear data at any time",
		"No data is sent to external servers": "No data is sent to external servers",
		"Continue Anyway": "Continue Anyway",
		"Requesting...": "Requesting...",
		"Grant Permission": "Grant Permission",
		Sessions: "Sessions",
		"Load a previous conversation": "Load a previous conversation",
		"No sessions yet": "No sessions yet",
		"Delete this session?": "Delete this session?",
		Today: "Today",
		Yesterday: "Yesterday",
		"{days} days ago": "{days} days ago",
		messages: "messages",
		tokens: "tokens",
		Delete: "Delete",
		"Drop files here": "Drop files here",
		"Command failed:": "Command failed:",
		// Providers & Models
		"Providers & Models": "Providers & Models",
		"Cloud Providers": "Cloud Providers",
		"Cloud LLM providers with predefined models. API keys are stored locally in your browser.":
			"Cloud LLM providers with predefined models. API keys are stored locally in your browser.",
		"Custom Providers": "Custom Providers",
		"User-configured servers with auto-discovered or manually defined models.":
			"User-configured servers with auto-discovered or manually defined models.",
		"Add Provider": "Add Provider",
		"No custom providers configured. Click 'Add Provider' to get started.":
			"No custom providers configured. Click 'Add Provider' to get started.",
		"No custom models configured. Add a custom provider in Settings first.":
			"No custom models configured. Add a custom provider in Settings first.",
		"auto-discovered": "auto-discovered",
		Refresh: "Refresh",
		Edit: "Edit",
		"Are you sure you want to delete this provider?": "Are you sure you want to delete this provider?",
		"Edit Provider": "Edit Provider",
		"Provider Name": "Provider Name",
		"e.g., My Ollama Server": "e.g., My Ollama Server",
		"Provider Type": "Provider Type",
		"Base URL": "Base URL",
		"e.g., http://localhost:11434": "e.g., http://localhost:11434",
		"API Key (Optional)": "API Key (Optional)",
		"Leave empty if not required": "Leave empty if not required",
		"Test Connection": "Test Connection",
		Discovered: "Discovered",
		Models: "Models",
		models: "models",
		and: "and",
		more: "more",
		"For manual provider types, add models after saving the provider.":
			"For manual provider types, add models after saving the provider.",
		"Enter one or more model IDs. Separate multiple models with new lines or commas.":
			"Enter one or more model IDs. Separate multiple models with new lines or commas.",
		"Enter one model ID per row. Use the exact ID reported by your model service.":
			"Enter one model ID per row. Use the exact ID reported by your model service.",
		"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.":
			"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.",
		"Model IDs": "Model IDs",
		"Add Model": "Add Model",
		"Remove model": "Remove model",
		"e.g., gpt-oss-120b": "e.g., gpt-oss-120b",
		"Context window": "Context window",
		"Max output tokens": "Max output tokens",
		"Max tokens field": "Max tokens field",
		"Thinking protocol": "Thinking protocol",
		"Send reasoning effort": "Send reasoning effort",
		"Replay reasoning_content": "Replay reasoning_content",
		"Non-streaming tool calls": "Non-streaming output",
		"Compatibility profile": "Compatibility profile",
		"Compatibility mode": "Compatibility mode",
		"Use when the endpoint closely follows OpenAI Chat Completions.":
			"Use when the endpoint closely follows OpenAI Chat Completions.",
		"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.":
			"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.",
		"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.":
			"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.",
		"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.":
			"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.",
		"Use for Qwen endpoints that enable thinking with enable_thinking.":
			"Use for Qwen endpoints that enable thinking with enable_thinking.",
		"Use when the provider requires chat_template_kwargs.enable_thinking.":
			"Use when the provider requires chat_template_kwargs.enable_thinking.",
		"Use for Z.AI endpoints that enable thinking with enable_thinking.":
			"Use for Z.AI endpoints that enable thinking with enable_thinking.",
		"Use only when you need to tune low-level compatibility switches manually.":
			"Use only when you need to tune low-level compatibility switches manually.",
		"Use when the endpoint follows the official OpenAI Responses API.":
			"Use when the endpoint follows the official OpenAI Responses API.",
		"Use for Responses-compatible gateways that reject session_id or long cache retention.":
			"Use for Responses-compatible gateways that reject session_id or long cache retention.",
		"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.":
			"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.",
		"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.":
			"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.",
		"Use for Anthropic-compatible endpoints that reject eager tool input streaming.":
			"Use for Anthropic-compatible endpoints that reject eager tool input streaming.",
		"Send session_id header": "Send session_id header",
		"Long cache retention": "Long cache retention",
		"Reasoning replay": "Reasoning replay",
		"Eager tool input streaming": "Eager tool input streaming",
		"Please fill in all required fields": "Please fill in all required fields",
		"Please add at least one model ID": "Please add at least one model ID",
		"Failed to save provider": "Failed to save provider",
		"OpenAI Completions Compatible": "OpenAI Completions Compatible",
		"OpenAI Responses Compatible": "OpenAI Responses Compatible",
		"Anthropic Messages Compatible": "Anthropic Messages Compatible",
		"Checking...": "Checking...",
		Disconnected: "Disconnected",
		Language: "Language",
		"Display language": "Display language",
		"Choose the interface language for this browser.": "Choose the interface language for this browser.",
		"Language changes are saved locally in this browser.": "Language changes are saved locally in this browser.",
		"Interface language": "Interface language",
		English: "English",
		"Simplified Chinese": "Simplified Chinese",
		German: "German",
		Malay: "Malay",
		"AI Coding Platform": "AI Coding Platform",
		"New Session": "New Session",
		"Click to edit title": "Click to edit title",
		"Demo: Add Custom Notification": "Demo: Add Custom Notification",
		"AITC platform logo": "AITC platform logo",
		"Load a browser or configured local conversation": "Load a browser or configured local conversation",
		"Load a browser conversation": "Load a browser conversation",
		"Creating file": "Creating file",
		"Created file": "Created file",
		"Rewriting file": "Rewriting file",
		"Updating file": "Updating file",
		"Updated file": "Updated file",
		"Reading file": "Reading file",
		"Read file": "Read file",
		"Deleting file": "Deleting file",
		"Deleted file": "Deleted file",
		"Listing project files": "Listing project files",
		"Listed project files": "Listed project files",
		"File operation failed": "File operation failed",
		"Processing file": "Processing file",
		"Processed file": "Processed file",
		"Running command": "Running command",
		"Ran command": "Ran command",
		"Preview ready": "Preview ready",
		"Preparing preview": "Preparing preview",
		"Prepared preview": "Prepared preview",
	},
	de: {
		...defaultGerman,
		Free: "Kostenlos",
		"Input Required": "Eingabe erforderlich",
		Cancel: "Abbrechen",
		Confirm: "Bestätigen",
		"Select Model": "Modell auswählen",
		"Please select a model first.": "Bitte wählen Sie zuerst ein Modell aus.",
		"Search models...": "Modelle suchen...",
		Format: "Formatieren",
		Thinking: "Thinking",
		Vision: "Vision",
		Reasoning: "Reasoning",
		You: "Sie",
		Assistant: "Assistent",
		"Thinking...": "Denkt nach...",
		"Type your message...": "Geben Sie Ihre Nachricht ein...",
		"API Keys Configuration": "API-Schlüssel-Konfiguration",
		"Configure API keys for LLM providers. Keys are stored locally in your browser.":
			"Konfigurieren Sie API-Schlüssel für LLM-Anbieter. Schlüssel werden lokal in Ihrem Browser gespeichert.",
		Configured: "Konfiguriert",
		"Not configured": "Nicht konfiguriert",
		"✓ Valid": "✓ Gültig",
		"✗ Invalid": "✗ Ungültig",
		"Testing...": "Teste...",
		Update: "Aktualisieren",
		Test: "Testen",
		Remove: "Entfernen",
		Save: "Speichern",
		"Saving...": "Speichert...",
		"Update API key": "API-Schlüssel aktualisieren",
		"Enter API key": "API-Schlüssel eingeben",
		"Type a message...": "Nachricht eingeben...",
		Extensions: "Erweiterungen",
		Skill: "Fähigkeit",
		"Select global skills": "Globale Fähigkeiten auswählen",
		Back: "Zurück",
		"No skills available": "Keine Fähigkeiten verfügbar",
		"Add SKILL.md files under the configured skills directory.":
			"Fügen Sie SKILL.md-Dateien im konfigurierten Skills-Verzeichnis hinzu.",
		"Failed to fetch file": "Datei konnte nicht abgerufen werden",
		"Invalid source type": "Ungültiger Quellentyp",
		PDF: "PDF",
		Document: "Dokument",
		Presentation: "Präsentation",
		Spreadsheet: "Tabelle",
		Text: "Text",
		"Error loading file": "Fehler beim Laden der Datei",
		"No text content available": "Kein Textinhalt verfügbar",
		"Failed to load PDF": "PDF konnte nicht geladen werden",
		"Failed to load document": "Dokument konnte nicht geladen werden",
		"Failed to load spreadsheet": "Tabelle konnte nicht geladen werden",
		"Error loading PDF": "Fehler beim Laden des PDFs",
		"Error loading document": "Fehler beim Laden des Dokuments",
		"Error loading spreadsheet": "Fehler beim Laden der Tabelle",
		"Preview not available for this file type.": "Vorschau für diesen Dateityp nicht verfügbar.",
		"Click the download button above to view it on your computer.":
			"Klicken Sie oben auf die Download-Schaltfläche, um die Datei auf Ihrem Computer anzuzeigen.",
		"No content available": "Kein Inhalt verfügbar",
		"Failed to display text content": "Textinhalt konnte nicht angezeigt werden",
		"API keys are required to use AI models. Get your keys from the provider's website.":
			"API-Schlüssel sind erforderlich, um KI-Modelle zu verwenden. Holen Sie sich Ihre Schlüssel von der Website des Anbieters.",
		console: "Konsole",
		"Copy output": "Ausgabe kopieren",
		"Copied!": "Kopiert!",
		"Error:": "Fehler:",
		"Request aborted": "Anfrage abgebrochen",
		Call: "Aufruf",
		Result: "Ergebnis",
		"(no result)": "(kein Ergebnis)",
		"Waiting for tool result…": "Warte auf Tool-Ergebnis…",
		"Call was aborted; no result.": "Aufruf wurde abgebrochen; kein Ergebnis.",
		"No session available": "Keine Sitzung verfügbar",
		"No session set": "Keine Sitzung gesetzt",
		"Preparing tool parameters...": "Bereite Tool-Parameter vor...",
		"(no output)": "(keine Ausgabe)",
		Input: "Eingabe",
		Output: "Ausgabe",
		"Waiting for expression...": "Warte auf Ausdruck",
		"Writing expression...": "Schreibe Ausdruck...",
		Calculating: "Berechne",
		"Getting current time in": "Hole aktuelle Zeit in",
		"Getting current date and time": "Hole aktuelles Datum und Uhrzeit",
		"Waiting for command...": "Warte auf Befehl...",
		"Writing command...": "Schreibe Befehl...",
		"Running command...": "Führe Befehl aus...",
		"Command failed": "Befehl fehlgeschlagen",
		"Enter Auth Token": "Auth-Token eingeben",
		"Please enter your auth token.": "Bitte geben Sie Ihr Auth-Token ein.",
		"Auth token is required for proxy transport": "Auth-Token ist für Proxy-Transport erforderlich",
		// JavaScript REPL strings
		"Execution aborted": "Ausführung abgebrochen",
		"Code parameter is required": "Code-Parameter ist erforderlich",
		"Unknown error": "Unbekannter Fehler",
		"Code executed successfully (no output)": "Code erfolgreich ausgeführt (keine Ausgabe)",
		"Execution failed": "Ausführung fehlgeschlagen",
		"JavaScript REPL": "JavaScript REPL",
		"JavaScript code to execute": "Auszuführender JavaScript-Code",
		"Writing JavaScript code...": "Schreibe JavaScript-Code...",
		"Executing JavaScript": "Führe JavaScript aus",
		"Preparing JavaScript...": "Bereite JavaScript vor...",
		"Preparing command...": "Bereite Befehl vor...",
		"Preparing calculation...": "Bereite Berechnung vor...",
		"Preparing tool...": "Bereite Tool vor...",
		"Getting time...": "Hole Zeit...",
		// Artifacts strings
		"Processing artifact...": "Verarbeite Artefakt...",
		"Preparing artifact...": "Bereite Artefakt vor...",
		"Processing artifact": "Verarbeite Artefakt",
		"Processed artifact": "Artefakt verarbeitet",
		"Creating artifact": "Erstelle Artefakt",
		"Created artifact": "Artefakt erstellt",
		"Updating artifact": "Aktualisiere Artefakt",
		"Updated artifact": "Artefakt aktualisiert",
		"Rewriting artifact": "Überschreibe Artefakt",
		"Rewrote artifact": "Artefakt überschrieben",
		"Getting artifact": "Hole Artefakt",
		"Got artifact": "Artefakt geholt",
		"Deleting artifact": "Lösche Artefakt",
		"Deleted artifact": "Artefakt gelöscht",
		"Getting logs": "Hole Logs",
		"Got logs": "Logs geholt",
		"An error occurred": "Ein Fehler ist aufgetreten",
		"Copy logs": "Logs kopieren",
		"Autoscroll enabled": "Automatisches Scrollen aktiviert",
		"Autoscroll disabled": "Automatisches Scrollen deaktiviert",
		Processing: "Verarbeitung",
		Create: "Erstellen",
		Rewrite: "Überschreiben",
		Get: "Abrufen",
		"Get logs": "Logs abrufen",
		"Show artifacts": "Artefakte anzeigen",
		"Close artifacts": "Artefakte schließen",
		Artifacts: "Artefakte",
		"Copy HTML": "HTML kopieren",
		"Download HTML": "HTML herunterladen",
		"Reload HTML": "HTML neu laden",
		"Copy SVG": "SVG kopieren",
		"Download SVG": "SVG herunterladen",
		"Copy Markdown": "Markdown kopieren",
		"Download Markdown": "Markdown herunterladen",
		Download: "Herunterladen",
		"No logs for {filename}": "Keine Logs für {filename}",
		"API Keys Settings": "API-Schlüssel Einstellungen",
		Settings: "Einstellungen",
		"API Keys": "API-Schlüssel",
		Proxy: "Proxy",
		"Use CORS Proxy": "CORS-Proxy verwenden",
		"Proxy URL": "Proxy-URL",
		"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>":
			"Format: Der Proxy muss Anfragen als <proxy-url>/?url=<ziel-url> akzeptieren",
		"Settings are stored locally in your browser": "Einstellungen werden lokal in Ihrem Browser gespeichert",
		Clear: "Löschen",
		"API Key Required": "API-Schlüssel erforderlich",
		"Enter your API key for {provider}": "Geben Sie Ihren API-Schlüssel für {provider} ein",
		"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.":
			"Ermöglicht browserbasierten Anwendungen, CORS-Einschränkungen beim Aufruf von LLM-Anbietern zu umgehen. Erforderlich für Z-AI und Anthropic mit OAuth-Token.",
		Off: "Aus",
		Minimal: "Minimal",
		Low: "Niedrig",
		Medium: "Mittel",
		High: "Hoch",
		"Storage Permission Required": "Speicherberechtigung erforderlich",
		"This app needs persistent storage to save your conversations":
			"Diese App benötigt dauerhaften Speicher, um Ihre Konversationen zu speichern",
		"Why is this needed?": "Warum wird das benötigt?",
		"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.":
			"Ohne dauerhaften Speicher kann Ihr Browser gespeicherte Konversationen löschen, wenn Speicherplatz benötigt wird. Diese Berechtigung stellt sicher, dass Ihr Chatverlauf erhalten bleibt.",
		"What this means:": "Was das bedeutet:",
		"Your conversations will be saved locally in your browser":
			"Ihre Konversationen werden lokal in Ihrem Browser gespeichert",
		"Data will not be deleted automatically to free up space":
			"Daten werden nicht automatisch gelöscht, um Speicherplatz freizugeben",
		"You can still manually clear data at any time": "Sie können Daten jederzeit manuell löschen",
		"No data is sent to external servers": "Keine Daten werden an externe Server gesendet",
		"Continue Anyway": "Trotzdem fortfahren",
		"Requesting...": "Anfrage läuft...",
		"Grant Permission": "Berechtigung erteilen",
		Sessions: "Sitzungen",
		"Load a previous conversation": "Frühere Konversation laden",
		"No sessions yet": "Noch keine Sitzungen",
		"Delete this session?": "Diese Sitzung löschen?",
		Today: "Heute",
		Yesterday: "Gestern",
		"{days} days ago": "vor {days} Tagen",
		messages: "Nachrichten",
		tokens: "Tokens",
		Delete: "Löschen",
		"Drop files here": "Dateien hier ablegen",
		"Command failed:": "Befehl fehlgeschlagen:",
		// Providers & Models
		"Providers & Models": "Anbieter & Modelle",
		"Cloud Providers": "Cloud-Anbieter",
		"Cloud LLM providers with predefined models. API keys are stored locally in your browser.":
			"Cloud-LLM-Anbieter mit vordefinierten Modellen. API-Schlüssel werden lokal in Ihrem Browser gespeichert.",
		"Custom Providers": "Benutzerdefinierte Anbieter",
		"User-configured servers with auto-discovered or manually defined models.":
			"Benutzerkonfigurierte Server mit automatisch erkannten oder manuell definierten Modellen.",
		"Add Provider": "Anbieter hinzufügen",
		"No custom providers configured. Click 'Add Provider' to get started.":
			"Keine benutzerdefinierten Anbieter konfiguriert. Klicken Sie auf 'Anbieter hinzufügen', um zu beginnen.",
		"No custom models configured. Add a custom provider in Settings first.":
			"Keine benutzerdefinierten Modelle konfiguriert. Fügen Sie zuerst in den Einstellungen einen Anbieter hinzu.",
		"auto-discovered": "automatisch erkannt",
		Refresh: "Aktualisieren",
		Edit: "Bearbeiten",
		"Are you sure you want to delete this provider?": "Sind Sie sicher, dass Sie diesen Anbieter löschen möchten?",
		"Edit Provider": "Anbieter bearbeiten",
		"Provider Name": "Anbietername",
		"e.g., My Ollama Server": "z.B. Mein Ollama Server",
		"Provider Type": "Anbietertyp",
		"Base URL": "Basis-URL",
		"e.g., http://localhost:11434": "z.B. http://localhost:11434",
		"API Key (Optional)": "API-Schlüssel (Optional)",
		"Leave empty if not required": "Leer lassen, falls nicht erforderlich",
		"Test Connection": "Verbindung testen",
		Discovered: "Erkannt",
		Models: "Modelle",
		models: "Modelle",
		and: "und",
		more: "mehr",
		"For manual provider types, add models after saving the provider.":
			"Für manuelle Anbietertypen fügen Sie Modelle nach dem Speichern des Anbieters hinzu.",
		"Enter one or more model IDs. Separate multiple models with new lines or commas.":
			"Geben Sie eine oder mehrere Modell-IDs ein. Trennen Sie mehrere Modelle mit Zeilenumbrüchen oder Kommas.",
		"Enter one model ID per row. Use the exact ID reported by your model service.":
			"Geben Sie eine Modell-ID pro Zeile ein. Verwenden Sie die exakte ID Ihres Modelldienstes.",
		"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.":
			"Konfigurieren Sie jedes Modell separat. Verwenden Sie die exakte ID Ihres Modelldienstes und aktivieren Sie nur unterstützte Fähigkeiten.",
		"Model IDs": "Modell-IDs",
		"Add Model": "Modell hinzufügen",
		"Remove model": "Modell entfernen",
		"e.g., gpt-oss-120b": "z.B. gpt-oss-120b",
		"Context window": "Kontextfenster",
		"Max output tokens": "Max. Ausgabetokens",
		"Max tokens field": "Max-Tokens-Feld",
		"Thinking protocol": "Thinking-Protokoll",
		"Send reasoning effort": "Reasoning effort senden",
		"Replay reasoning_content": "reasoning_content wiedergeben",
		"Non-streaming tool calls": "Nicht-streamende Ausgabe",
		"Compatibility profile": "Kompatibilitätsprofil",
		"Compatibility mode": "Kompatibilitätsmodus",
		"Use when the endpoint closely follows OpenAI Chat Completions.":
			"Für Endpunkte, die OpenAI Chat Completions eng folgen.",
		"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.":
			"Für lokale oder einfache OpenAI-kompatible Server, die erweiterte OpenAI-Felder ablehnen.",
		"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.":
			"Für DeepSeek- oder MiMo-Chat-Completions-Endpunkte, die reasoning_content-Wiedergabe verlangen.",
		"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.":
			"Für OpenRouter-Endpunkte, die Denken über das verschachtelte reasoning-Feld konfigurieren.",
		"Use for Qwen endpoints that enable thinking with enable_thinking.":
			"Für Qwen-Endpunkte, die Denken mit enable_thinking aktivieren.",
		"Use when the provider requires chat_template_kwargs.enable_thinking.":
			"Verwenden, wenn der Anbieter chat_template_kwargs.enable_thinking verlangt.",
		"Use for Z.AI endpoints that enable thinking with enable_thinking.":
			"Für Z.AI-Endpunkte, die Denken mit enable_thinking aktivieren.",
		"Use only when you need to tune low-level compatibility switches manually.":
			"Nur verwenden, wenn Low-Level-Kompatibilitätsschalter manuell angepasst werden müssen.",
		"Use when the endpoint follows the official OpenAI Responses API.":
			"Für Endpunkte, die der offiziellen OpenAI Responses API folgen.",
		"Use for Responses-compatible gateways that reject session_id or long cache retention.":
			"Für Responses-kompatible Gateways, die session_id oder lange Cache-Aufbewahrung ablehnen.",
		"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.":
			"Für offizielle Anthropic- oder kompatible Endpunkte, die signierte Thinking-Blöcke wiedergeben.",
		"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.":
			"Für Anthropic-Endpunkte im MiMo- oder DeepSeek-Stil, die reasoning_content-Wiedergabe verlangen.",
		"Use for Anthropic-compatible endpoints that reject eager tool input streaming.":
			"Für Anthropic-kompatible Endpunkte, die Eager Tool Input Streaming ablehnen.",
		"Send session_id header": "session_id-Header senden",
		"Long cache retention": "Lange Cache-Aufbewahrung",
		"Reasoning replay": "Reasoning-Wiedergabe",
		"Eager tool input streaming": "Eager Tool Input Streaming",
		"Please fill in all required fields": "Bitte füllen Sie alle erforderlichen Felder aus",
		"Please add at least one model ID": "Bitte fügen Sie mindestens eine Modell-ID hinzu",
		"Failed to save provider": "Fehler beim Speichern des Anbieters",
		"OpenAI Completions Compatible": "OpenAI Completions Kompatibel",
		"OpenAI Responses Compatible": "OpenAI Responses Kompatibel",
		"Anthropic Messages Compatible": "Anthropic Messages Kompatibel",
		"Checking...": "Überprüfe...",
		Disconnected: "Getrennt",
		Language: "Sprache",
		"Display language": "Anzeigesprache",
		"Choose the interface language for this browser.": "Wählen Sie die Sprache der Oberfläche für diesen Browser.",
		"Language changes are saved locally in this browser.":
			"Sprachänderungen werden lokal in diesem Browser gespeichert.",
		"Interface language": "Oberflächensprache",
		English: "Englisch",
		"Simplified Chinese": "Vereinfachtes Chinesisch",
		German: "Deutsch",
		Malay: "Malaiisch",
		"AI Coding Platform": "AI Coding Platform",
		"New Session": "Neue Sitzung",
		"Click to edit title": "Klicken, um den Titel zu bearbeiten",
		"Demo: Add Custom Notification": "Demo: Benutzerdefinierte Benachrichtigung hinzufügen",
		"AITC platform logo": "AITC-Plattformlogo",
		"Load a browser or configured local conversation": "Browser- oder konfigurierte lokale Konversation laden",
		"Load a browser conversation": "Browser-Konversation laden",
		"Creating file": "Erstelle Datei",
		"Created file": "Datei erstellt",
		"Rewriting file": "Schreibe Datei neu",
		"Updating file": "Aktualisiere Datei",
		"Updated file": "Datei aktualisiert",
		"Reading file": "Lese Datei",
		"Read file": "Datei gelesen",
		"Deleting file": "Lösche Datei",
		"Deleted file": "Datei gelöscht",
		"Listing project files": "Liste Projektdateien auf",
		"Listed project files": "Projektdateien aufgelistet",
		"File operation failed": "Dateivorgang fehlgeschlagen",
		"Processing file": "Verarbeite Datei",
		"Processed file": "Datei verarbeitet",
		"Running command": "Führe Befehl aus",
		"Ran command": "Befehl ausgeführt",
		"Preview ready": "Vorschau bereit",
		"Preparing preview": "Bereite Vorschau vor",
		"Prepared preview": "Vorschau vorbereitet",
	},
};

const mutableTranslations = translations as Record<string, typeof translations.en>;

mutableTranslations.zh = {
	...translations.en,
	"*": "*",
	Copy: "复制",
	"Copy code": "复制代码",
	"Copied!": "已复制！",
	Download: "下载",
	Close: "关闭",
	Preview: "预览",
	Code: "代码",
	"Loading...": "加载中...",
	"Select an option": "选择一个选项",
	"Mode 1": "模式 1",
	"Mode 2": "模式 2",
	Required: "必填",
	Optional: "可选",
	Free: "免费",
	"Input Required": "需要输入",
	Cancel: "取消",
	Confirm: "确认",
	"Select Model": "选择模型",
	"Please select a model first.": "请先选择模型。",
	"Search models...": "搜索模型...",
	Format: "格式",
	Thinking: "思考",
	Vision: "视觉",
	Reasoning: "思考",
	You: "你",
	Assistant: "助手",
	"Thinking...": "思考中...",
	"Type your message...": "输入消息...",
	"API Keys Configuration": "API Key 配置",
	"Configure API keys for LLM providers. Keys are stored locally in your browser.":
		"配置大模型服务商的 API Key。Key 会保存在当前浏览器本地。",
	Configured: "已配置",
	"Not configured": "未配置",
	"✓ Valid": "✓ 有效",
	"✗ Invalid": "✗ 无效",
	"Testing...": "测试中...",
	Update: "更新",
	Test: "测试",
	Remove: "移除",
	Save: "保存",
	"Saving...": "保存中...",
	"Update API key": "更新 API Key",
	"Enter API key": "输入 API Key",
	"Type a message...": "输入消息...",
	Extensions: "扩展",
	Skill: "技能",
	"Select global skills": "选择全局技能",
	Back: "返回",
	"No skills available": "没有可用技能",
	"Add SKILL.md files under the configured skills directory.": "请在配置的 skills 目录下添加 SKILL.md 文件。",
	"Failed to fetch file": "获取文件失败",
	"Invalid source type": "无效的来源类型",
	PDF: "PDF",
	Document: "文档",
	Presentation: "演示文稿",
	Spreadsheet: "表格",
	Text: "文本",
	"Error loading file": "加载文件出错",
	"No text content available": "没有可用文本内容",
	"Failed to load PDF": "PDF 加载失败",
	"Failed to load document": "文档加载失败",
	"Failed to load spreadsheet": "表格加载失败",
	"Error loading PDF": "加载 PDF 出错",
	"Error loading document": "加载文档出错",
	"Error loading spreadsheet": "加载表格出错",
	"Preview not available for this file type.": "此文件类型不支持预览。",
	"Click the download button above to view it on your computer.": "点击上方下载按钮在本机查看。",
	"No content available": "没有可用内容",
	"Failed to display text content": "文本内容显示失败",
	"API keys are required to use AI models. Get your keys from the provider's website.":
		"使用 AI 模型需要 API Key。请从服务商网站获取。",
	console: "控制台",
	"Copy output": "复制输出",
	"Error:": "错误：",
	"Request aborted": "请求已取消",
	Call: "调用",
	Result: "结果",
	"(no result)": "（无结果）",
	"Waiting for tool result…": "等待工具结果…",
	"Call was aborted; no result.": "调用已取消，没有结果。",
	"No session available": "没有可用会话",
	"No session set": "未设置会话",
	"Preparing tool parameters...": "正在准备工具参数...",
	"(no output)": "（无输出）",
	Input: "输入",
	Output: "输出",
	"Writing expression...": "正在写入表达式...",
	"Waiting for expression...": "等待表达式...",
	Calculating: "正在计算",
	"Getting current time in": "正在获取当前时间：",
	"Getting current date and time": "正在获取当前日期和时间",
	"Waiting for command...": "等待命令...",
	"Writing command...": "正在写入命令...",
	"Running command...": "正在运行命令...",
	"Command failed:": "命令失败：",
	"Command failed": "命令失败",
	"Enter Auth Token": "输入认证令牌",
	"Please enter your auth token.": "请输入认证令牌。",
	"Auth token is required for proxy transport": "代理传输需要认证令牌",
	"Execution aborted": "执行已取消",
	"Code parameter is required": "需要代码参数",
	"Unknown error": "未知错误",
	"Code executed successfully (no output)": "代码执行成功（无输出）",
	"Execution failed": "执行失败",
	"JavaScript REPL": "JavaScript REPL",
	"JavaScript code to execute": "要执行的 JavaScript 代码",
	"Writing JavaScript code...": "正在写入 JavaScript 代码...",
	"Executing JavaScript": "正在执行 JavaScript",
	"Preparing JavaScript...": "正在准备 JavaScript...",
	"Preparing command...": "正在准备命令...",
	"Preparing calculation...": "正在准备计算...",
	"Preparing tool...": "正在准备工具...",
	"Getting time...": "正在获取时间...",
	"Processing artifact...": "正在处理产物...",
	"Preparing artifact...": "正在准备产物...",
	"Processing artifact": "正在处理产物",
	"Processed artifact": "产物已处理",
	"Creating artifact": "正在创建产物",
	"Created artifact": "已创建产物",
	"Updating artifact": "正在更新产物",
	"Updated artifact": "已更新产物",
	"Rewriting artifact": "正在重写产物",
	"Rewrote artifact": "已重写产物",
	"Getting artifact": "正在获取产物",
	"Got artifact": "已获取产物",
	"Deleting artifact": "正在删除产物",
	"Deleted artifact": "已删除产物",
	"Getting logs": "正在获取日志",
	"Got logs": "已获取日志",
	"An error occurred": "发生错误",
	"Copy logs": "复制日志",
	"Autoscroll enabled": "自动滚动已启用",
	"Autoscroll disabled": "自动滚动已禁用",
	Processing: "处理中",
	Create: "创建",
	Rewrite: "重写",
	Get: "获取",
	Delete: "删除",
	"Get logs": "获取日志",
	"Show artifacts": "显示产物",
	"Close artifacts": "关闭产物",
	Artifacts: "产物",
	"Copy HTML": "复制 HTML",
	"Download HTML": "下载 HTML",
	"Reload HTML": "重新加载 HTML",
	"Copy SVG": "复制 SVG",
	"Download SVG": "下载 SVG",
	"Copy Markdown": "复制 Markdown",
	"Download Markdown": "下载 Markdown",
	"No logs for {filename}": "{filename} 没有日志",
	"API Keys Settings": "API Key 设置",
	Settings: "设置",
	"API Keys": "API Key",
	Proxy: "代理",
	"Use CORS Proxy": "使用 CORS 代理",
	"Proxy URL": "代理 URL",
	"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>":
		"格式：代理必须接受 <proxy-url>/?url=<target-url> 形式的请求",
	"Settings are stored locally in your browser": "设置保存在当前浏览器本地",
	Clear: "清除",
	"API Key Required": "需要 API Key",
	"Enter your API key for {provider}": "输入 {provider} 的 API Key",
	"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.":
		"允许浏览器应用调用大模型服务商时绕过 CORS 限制。Z-AI 和使用 OAuth 令牌的 Anthropic 需要此设置。",
	Off: "关闭",
	Minimal: "最小",
	Low: "低",
	Medium: "中",
	High: "高",
	"Storage Permission Required": "需要存储权限",
	"This app needs persistent storage to save your conversations": "此应用需要持久化存储来保存会话",
	"Why is this needed?": "为什么需要？",
	"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.":
		"如果没有持久化存储，浏览器可能在需要空间时删除已保存会话。授予权限可确保聊天记录被保留。",
	"What this means:": "这意味着：",
	"Your conversations will be saved locally in your browser": "会话会保存在当前浏览器本地",
	"Data will not be deleted automatically to free up space": "数据不会为了释放空间而被自动删除",
	"You can still manually clear data at any time": "你仍然可以随时手动清除数据",
	"No data is sent to external servers": "不会向外部服务器发送数据",
	"Continue Anyway": "仍然继续",
	"Requesting...": "请求中...",
	"Grant Permission": "授予权限",
	Sessions: "会话",
	"Load a previous conversation": "加载历史会话",
	"No sessions yet": "暂无会话",
	"Delete this session?": "删除此会话？",
	Today: "今天",
	Yesterday: "昨天",
	"{days} days ago": "{days} 天前",
	messages: "条消息",
	tokens: "tokens",
	"Drop files here": "将文件拖到这里",
	"Providers & Models": "服务商与模型",
	"Cloud Providers": "云服务商",
	"Cloud LLM providers with predefined models. API keys are stored locally in your browser.":
		"带有预设模型的云端大模型服务商。API Key 保存在当前浏览器本地。",
	"Custom Providers": "自定义服务商",
	"User-configured servers with auto-discovered or manually defined models.":
		"用户配置的服务，可自动发现或手动定义模型。",
	"Add Provider": "添加服务商",
	"No custom providers configured. Click 'Add Provider' to get started.": "暂无自定义服务商。点击“添加服务商”开始。",
	"No custom models configured. Add a custom provider in Settings first.":
		"暂无自定义模型。请先在设置中添加自定义服务商。",
	Models: "模型",
	"auto-discovered": "自动发现",
	Refresh: "刷新",
	Edit: "编辑",
	"Are you sure you want to delete this provider?": "确定要删除此服务商吗？",
	"Edit Provider": "编辑服务商",
	"Provider Name": "服务商名称",
	"e.g., My Ollama Server": "例如：我的 Ollama 服务",
	"Provider Type": "服务商类型",
	"Base URL": "基础 URL",
	"e.g., http://localhost:11434": "例如：http://localhost:11434",
	"API Key (Optional)": "API Key（可选）",
	"Leave empty if not required": "不需要时可留空",
	"Test Connection": "测试连接",
	Discovered: "已发现",
	models: "个模型",
	and: "和",
	more: "更多",
	"For manual provider types, add models after saving the provider.": "手动服务商类型需要保存后再添加模型。",
	"Enter one or more model IDs. Separate multiple models with new lines or commas.":
		"输入一个或多个模型 ID，多个模型可用换行或逗号分隔。",
	"Enter one model ID per row. Use the exact ID reported by your model service.":
		"每行输入一个模型 ID。请使用模型服务返回的准确 ID。",
	"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.":
		"分别配置每个模型。请使用模型服务返回的准确 ID，并且只开启该模型支持的能力。",
	"Model IDs": "模型 ID",
	"Add Model": "添加模型",
	"Remove model": "移除模型",
	"e.g., gpt-oss-120b": "例如：gpt-oss-120b",
	"Context window": "上下文窗口",
	"Max output tokens": "最大输出 tokens",
	"Max tokens field": "最大 tokens 字段",
	"Thinking protocol": "思考协议",
	"Send reasoning effort": "发送思考等级",
	"Replay reasoning_content": "回放 reasoning_content",
	"Non-streaming tool calls": "非流式输出",
	"Compatibility profile": "兼容档案",
	"Compatibility mode": "兼容协议",
	"Use when the endpoint closely follows OpenAI Chat Completions.": "适用于严格兼容 OpenAI Chat Completions 的接口。",
	"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.":
		"适用于本地或简化的 OpenAI 兼容服务，这类服务可能不支持高级 OpenAI 字段。",
	"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.":
		"适用于要求在历史消息中回传 reasoning_content 的 DeepSeek 或 MiMo Chat Completions 接口。",
	"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.":
		"适用于通过嵌套 reasoning 字段配置思考的 OpenRouter 接口。",
	"Use for Qwen endpoints that enable thinking with enable_thinking.":
		"适用于通过 enable_thinking 开启思考的 Qwen 接口。",
	"Use when the provider requires chat_template_kwargs.enable_thinking.":
		"适用于要求通过 chat_template_kwargs.enable_thinking 开启思考的接口。",
	"Use for Z.AI endpoints that enable thinking with enable_thinking.":
		"适用于通过 enable_thinking 开启思考的 Z.AI 接口。",
	"Use only when you need to tune low-level compatibility switches manually.": "仅在需要手动调整底层兼容开关时选择。",
	"Use when the endpoint follows the official OpenAI Responses API.": "适用于遵循官方 OpenAI Responses API 的接口。",
	"Use for Responses-compatible gateways that reject session_id or long cache retention.":
		"适用于兼容 Responses 但不支持 session_id 或长缓存保留的网关。",
	"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.":
		"适用于官方 Anthropic 或支持回放签名 thinking block 的兼容接口。",
	"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.":
		"适用于要求回传 reasoning_content 的 MiMo 或 DeepSeek 风格 Anthropic 接口。",
	"Use for Anthropic-compatible endpoints that reject eager tool input streaming.":
		"适用于不支持 eager tool input streaming 的 Anthropic 兼容接口。",
	"Send session_id header": "发送 session_id 请求头",
	"Long cache retention": "长缓存保留",
	"Reasoning replay": "思考回放",
	"Eager tool input streaming": "Eager 工具输入流",
	"Please fill in all required fields": "请填写所有必填字段",
	"Please add at least one model ID": "请至少添加一个模型 ID",
	"Failed to save provider": "保存服务商失败",
	"OpenAI Completions Compatible": "兼容 OpenAI Completions",
	"OpenAI Responses Compatible": "兼容 OpenAI Responses",
	"Anthropic Messages Compatible": "兼容 Anthropic Messages",
	"Checking...": "检查中...",
	Disconnected: "未连接",
	Language: "语言",
	"Display language": "显示语言",
	"Choose the interface language for this browser.": "选择当前浏览器的界面语言。",
	"Language changes are saved locally in this browser.": "语言设置会保存在当前浏览器本地。",
	"Interface language": "界面语言",
	English: "英语",
	"Simplified Chinese": "简体中文",
	German: "德语",
	Malay: "马来语",
	"AI Coding Platform": "AI 编码平台",
	"New Session": "新建会话",
	"Click to edit title": "点击编辑标题",
	"Demo: Add Custom Notification": "演示：添加自定义通知",
	"AITC platform logo": "AITC 平台标识",
	"Load a browser or configured local conversation": "加载浏览器或配置目录中的本地会话",
	"Load a browser conversation": "加载当前浏览器中的会话",
	"Creating file": "正在创建文件",
	"Created file": "已创建文件",
	"Rewriting file": "正在重写文件",
	"Updating file": "正在更新文件",
	"Updated file": "已更新文件",
	"Reading file": "正在读取文件",
	"Read file": "已读取文件",
	"Deleting file": "正在删除文件",
	"Deleted file": "已删除文件",
	"Listing project files": "正在列出项目文件",
	"Listed project files": "已列出项目文件",
	"File operation failed": "文件操作失败",
	"Processing file": "正在处理文件",
	"Processed file": "已处理文件",
	"Running command": "正在运行命令",
	"Ran command": "命令已运行",
	"Preview ready": "预览已就绪",
	"Preparing preview": "正在准备预览",
	"Prepared preview": "预览已准备",
};

mutableTranslations.ms = {
	...translations.en,
	Copy: "Salin",
	"Copy code": "Salin kod",
	"Copied!": "Disalin!",
	Download: "Muat turun",
	Close: "Tutup",
	Preview: "Pratonton",
	Code: "Kod",
	"Loading...": "Memuatkan...",
	"Select an option": "Pilih pilihan",
	Required: "Wajib",
	Optional: "Pilihan",
	Free: "Percuma",
	"Input Required": "Input diperlukan",
	Cancel: "Batal",
	Confirm: "Sahkan",
	"Select Model": "Pilih model",
	"Please select a model first.": "Sila pilih model dahulu.",
	"Search models...": "Cari model...",
	Format: "Format",
	Thinking: "Pemikiran",
	Vision: "Visi",
	Reasoning: "Pemikiran",
	You: "Anda",
	Assistant: "Pembantu",
	"Thinking...": "Sedang berfikir...",
	"Type your message...": "Taip mesej anda...",
	"API Keys Configuration": "Konfigurasi API Key",
	"Configure API keys for LLM providers. Keys are stored locally in your browser.":
		"Konfigurasikan API Key untuk penyedia LLM. Key disimpan secara setempat dalam pelayar anda.",
	Configured: "Dikonfigurasi",
	"Not configured": "Belum dikonfigurasi",
	"✓ Valid": "✓ Sah",
	"✗ Invalid": "✗ Tidak sah",
	"Testing...": "Menguji...",
	Update: "Kemas kini",
	Test: "Uji",
	Remove: "Alih keluar",
	Save: "Simpan",
	"Saving...": "Menyimpan...",
	"Update API key": "Kemas kini API Key",
	"Enter API key": "Masukkan API Key",
	"Type a message...": "Taip mesej...",
	Extensions: "Sambungan",
	Skill: "Kemahiran",
	"Select global skills": "Pilih kemahiran global",
	Back: "Kembali",
	"No skills available": "Tiada kemahiran tersedia",
	"Add SKILL.md files under the configured skills directory.":
		"Tambah fail SKILL.md di bawah direktori kemahiran yang dikonfigurasi.",
	"Failed to fetch file": "Gagal mendapatkan fail",
	"Invalid source type": "Jenis sumber tidak sah",
	Document: "Dokumen",
	Presentation: "Pembentangan",
	Spreadsheet: "Hamparan",
	Text: "Teks",
	"Error loading file": "Ralat memuatkan fail",
	"No text content available": "Tiada kandungan teks tersedia",
	"Failed to load PDF": "Gagal memuatkan PDF",
	"Failed to load document": "Gagal memuatkan dokumen",
	"Failed to load spreadsheet": "Gagal memuatkan hamparan",
	"Error loading PDF": "Ralat memuatkan PDF",
	"Error loading document": "Ralat memuatkan dokumen",
	"Error loading spreadsheet": "Ralat memuatkan hamparan",
	"Preview not available for this file type.": "Pratonton tidak tersedia untuk jenis fail ini.",
	"Click the download button above to view it on your computer.":
		"Klik butang muat turun di atas untuk melihatnya pada komputer anda.",
	"No content available": "Tiada kandungan tersedia",
	"Failed to display text content": "Gagal memaparkan kandungan teks",
	"API keys are required to use AI models. Get your keys from the provider's website.":
		"API Key diperlukan untuk menggunakan model AI. Dapatkan key daripada laman penyedia.",
	console: "konsol",
	"Copy output": "Salin output",
	"Error:": "Ralat:",
	"Request aborted": "Permintaan dibatalkan",
	Call: "Panggilan",
	Result: "Keputusan",
	"(no result)": "(tiada keputusan)",
	"Waiting for tool result…": "Menunggu keputusan alat…",
	"Call was aborted; no result.": "Panggilan dibatalkan; tiada keputusan.",
	"No session available": "Tiada sesi tersedia",
	"No session set": "Tiada sesi ditetapkan",
	"Preparing tool parameters...": "Menyediakan parameter alat...",
	"(no output)": "(tiada output)",
	Input: "Input",
	Output: "Output",
	"Waiting for expression...": "Menunggu ungkapan...",
	"Writing expression...": "Menulis ungkapan...",
	Calculating: "Mengira",
	"Getting current time in": "Mendapatkan masa semasa di",
	"Getting current date and time": "Mendapatkan tarikh dan masa semasa",
	"Waiting for command...": "Menunggu arahan...",
	"Writing command...": "Menulis arahan...",
	"Running command...": "Menjalankan arahan...",
	"Command failed": "Arahan gagal",
	"Command failed:": "Arahan gagal:",
	"Enter Auth Token": "Masukkan token pengesahan",
	"Please enter your auth token.": "Sila masukkan token pengesahan anda.",
	"Auth token is required for proxy transport": "Token pengesahan diperlukan untuk pengangkutan proksi",
	"Execution aborted": "Pelaksanaan dibatalkan",
	"Code parameter is required": "Parameter kod diperlukan",
	"Unknown error": "Ralat tidak diketahui",
	"Code executed successfully (no output)": "Kod berjaya dilaksanakan (tiada output)",
	"Execution failed": "Pelaksanaan gagal",
	"JavaScript REPL": "JavaScript REPL",
	"JavaScript code to execute": "Kod JavaScript untuk dilaksanakan",
	"Writing JavaScript code...": "Menulis kod JavaScript...",
	"Executing JavaScript": "Melaksanakan JavaScript",
	"Preparing JavaScript...": "Menyediakan JavaScript...",
	"Preparing command...": "Menyediakan arahan...",
	"Preparing calculation...": "Menyediakan pengiraan...",
	"Preparing tool...": "Menyediakan alat...",
	"Getting time...": "Mendapatkan masa...",
	"Processing artifact...": "Memproses artifak...",
	"Preparing artifact...": "Menyediakan artifak...",
	"Processing artifact": "Memproses artifak",
	"Processed artifact": "Artifak diproses",
	"Creating artifact": "Mencipta artifak",
	"Created artifact": "Artifak dicipta",
	"Updating artifact": "Mengemas kini artifak",
	"Updated artifact": "Artifak dikemas kini",
	"Rewriting artifact": "Menulis semula artifak",
	"Rewrote artifact": "Artifak ditulis semula",
	"Getting artifact": "Mendapatkan artifak",
	"Got artifact": "Artifak diperoleh",
	"Deleting artifact": "Memadam artifak",
	"Deleted artifact": "Artifak dipadam",
	"Getting logs": "Mendapatkan log",
	"Got logs": "Log diperoleh",
	"An error occurred": "Ralat berlaku",
	"Copy logs": "Salin log",
	"Autoscroll enabled": "Autotatal diaktifkan",
	"Autoscroll disabled": "Autotatal dinyahaktifkan",
	Processing: "Memproses",
	Create: "Cipta",
	Rewrite: "Tulis semula",
	Get: "Dapatkan",
	Delete: "Padam",
	"Get logs": "Dapatkan log",
	"Show artifacts": "Tunjuk artifak",
	"Close artifacts": "Tutup artifak",
	Artifacts: "Artifak",
	"Copy HTML": "Salin HTML",
	"Download HTML": "Muat turun HTML",
	"Reload HTML": "Muat semula HTML",
	"Copy SVG": "Salin SVG",
	"Download SVG": "Muat turun SVG",
	"Copy Markdown": "Salin Markdown",
	"Download Markdown": "Muat turun Markdown",
	"No logs for {filename}": "Tiada log untuk {filename}",
	"API Keys Settings": "Tetapan API Key",
	Settings: "Tetapan",
	"API Keys": "API Key",
	Proxy: "Proksi",
	"Use CORS Proxy": "Gunakan proksi CORS",
	"Proxy URL": "URL proksi",
	"Format: The proxy must accept requests as <proxy-url>/?url=<target-url>":
		"Format: proksi mesti menerima permintaan sebagai <proxy-url>/?url=<target-url>",
	"Settings are stored locally in your browser": "Tetapan disimpan secara setempat dalam pelayar anda",
	Clear: "Kosongkan",
	"API Key Required": "API Key diperlukan",
	"Enter your API key for {provider}": "Masukkan API Key anda untuk {provider}",
	"Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.":
		"Membenarkan aplikasi pelayar memintas sekatan CORS ketika memanggil penyedia LLM. Diperlukan untuk Z-AI dan Anthropic dengan token OAuth.",
	Off: "Mati",
	Minimal: "Minimum",
	Low: "Rendah",
	Medium: "Sederhana",
	High: "Tinggi",
	"Storage Permission Required": "Kebenaran storan diperlukan",
	"This app needs persistent storage to save your conversations":
		"Aplikasi ini memerlukan storan kekal untuk menyimpan perbualan anda",
	"Why is this needed?": "Mengapa ini diperlukan?",
	"Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.":
		"Tanpa storan kekal, pelayar mungkin memadam perbualan tersimpan apabila memerlukan ruang. Kebenaran ini memastikan sejarah chat dikekalkan.",
	"What this means:": "Maksudnya:",
	"Your conversations will be saved locally in your browser":
		"Perbualan anda akan disimpan secara setempat dalam pelayar",
	"Data will not be deleted automatically to free up space":
		"Data tidak akan dipadam secara automatik untuk mengosongkan ruang",
	"You can still manually clear data at any time": "Anda masih boleh mengosongkan data secara manual bila-bila masa",
	"No data is sent to external servers": "Tiada data dihantar ke pelayan luaran",
	"Continue Anyway": "Teruskan juga",
	"Requesting...": "Meminta...",
	"Grant Permission": "Beri kebenaran",
	Sessions: "Sesi",
	"Load a previous conversation": "Muatkan perbualan terdahulu",
	"No sessions yet": "Belum ada sesi",
	"Delete this session?": "Padam sesi ini?",
	Today: "Hari ini",
	Yesterday: "Semalam",
	"{days} days ago": "{days} hari lalu",
	messages: "mesej",
	tokens: "token",
	"Drop files here": "Lepaskan fail di sini",
	"Providers & Models": "Penyedia & Model",
	"Cloud Providers": "Penyedia awan",
	"Cloud LLM providers with predefined models. API keys are stored locally in your browser.":
		"Penyedia LLM awan dengan model pratakrif. API Key disimpan secara setempat dalam pelayar anda.",
	"Custom Providers": "Penyedia tersuai",
	"User-configured servers with auto-discovered or manually defined models.":
		"Pelayan dikonfigurasi pengguna dengan model auto-ditemui atau ditakrifkan secara manual.",
	"Add Provider": "Tambah penyedia",
	"No custom providers configured. Click 'Add Provider' to get started.":
		"Tiada penyedia tersuai dikonfigurasi. Klik 'Tambah penyedia' untuk bermula.",
	"No custom models configured. Add a custom provider in Settings first.":
		"Tiada model tersuai dikonfigurasi. Tambah penyedia tersuai dalam Tetapan dahulu.",
	Models: "Model",
	"auto-discovered": "auto-ditemui",
	Refresh: "Segar semula",
	Edit: "Edit",
	"Are you sure you want to delete this provider?": "Anda pasti mahu memadam penyedia ini?",
	"Edit Provider": "Edit penyedia",
	"Provider Name": "Nama penyedia",
	"e.g., My Ollama Server": "cth., Pelayan Ollama Saya",
	"Provider Type": "Jenis penyedia",
	"Base URL": "URL asas",
	"e.g., http://localhost:11434": "cth., http://localhost:11434",
	"API Key (Optional)": "API Key (pilihan)",
	"Leave empty if not required": "Biarkan kosong jika tidak diperlukan",
	"Test Connection": "Uji sambungan",
	Discovered: "Ditemui",
	models: "model",
	and: "dan",
	more: "lagi",
	"For manual provider types, add models after saving the provider.":
		"Untuk jenis penyedia manual, tambah model selepas menyimpan penyedia.",
	"Enter one or more model IDs. Separate multiple models with new lines or commas.":
		"Masukkan satu atau lebih ID model. Pisahkan beberapa model dengan baris baharu atau koma.",
	"Enter one model ID per row. Use the exact ID reported by your model service.":
		"Masukkan satu ID model bagi setiap baris. Gunakan ID tepat yang dilaporkan oleh servis model anda.",
	"Configure each model separately. Use the exact ID reported by your model service, and only enable capabilities supported by that model.":
		"Konfigurasikan setiap model secara berasingan. Gunakan ID tepat daripada servis model dan hanya aktifkan keupayaan yang disokong.",
	"Model IDs": "ID model",
	"Add Model": "Tambah model",
	"Remove model": "Alih keluar model",
	"e.g., gpt-oss-120b": "cth., gpt-oss-120b",
	"Context window": "Tetingkap konteks",
	"Max output tokens": "Token output maksimum",
	"Max tokens field": "Medan token maksimum",
	"Thinking protocol": "Protokol pemikiran",
	"Send reasoning effort": "Hantar tahap pemikiran",
	"Replay reasoning_content": "Main semula reasoning_content",
	"Non-streaming tool calls": "Output bukan penstriman",
	"Compatibility profile": "Profil keserasian",
	"Compatibility mode": "Mod keserasian",
	"Use when the endpoint closely follows OpenAI Chat Completions.":
		"Gunakan apabila endpoint rapat mengikuti OpenAI Chat Completions.",
	"Use for local or simple OpenAI-compatible servers that reject advanced OpenAI fields.":
		"Gunakan untuk pelayan tempatan atau ringkas yang serasi OpenAI tetapi menolak medan OpenAI lanjutan.",
	"Use for DeepSeek or MiMo Chat Completions endpoints that require reasoning_content replay.":
		"Gunakan untuk endpoint DeepSeek atau MiMo Chat Completions yang memerlukan main semula reasoning_content.",
	"Use for OpenRouter endpoints that configure thinking with the nested reasoning field.":
		"Gunakan untuk endpoint OpenRouter yang menetapkan pemikiran melalui medan reasoning bersarang.",
	"Use for Qwen endpoints that enable thinking with enable_thinking.":
		"Gunakan untuk endpoint Qwen yang mengaktifkan pemikiran dengan enable_thinking.",
	"Use when the provider requires chat_template_kwargs.enable_thinking.":
		"Gunakan apabila penyedia memerlukan chat_template_kwargs.enable_thinking.",
	"Use for Z.AI endpoints that enable thinking with enable_thinking.":
		"Gunakan untuk endpoint Z.AI yang mengaktifkan pemikiran dengan enable_thinking.",
	"Use only when you need to tune low-level compatibility switches manually.":
		"Gunakan hanya apabila anda perlu melaras suis keserasian tahap rendah secara manual.",
	"Use when the endpoint follows the official OpenAI Responses API.":
		"Gunakan apabila endpoint mengikuti API OpenAI Responses rasmi.",
	"Use for Responses-compatible gateways that reject session_id or long cache retention.":
		"Gunakan untuk gateway serasi Responses yang menolak session_id atau pengekalan cache panjang.",
	"Use for official Anthropic or compatible endpoints that replay signed thinking blocks.":
		"Gunakan untuk Anthropic rasmi atau endpoint serasi yang memainkan semula blok thinking bertandatangan.",
	"Use for MiMo or DeepSeek-style Anthropic endpoints that require reasoning_content replay.":
		"Gunakan untuk endpoint Anthropic gaya MiMo atau DeepSeek yang memerlukan main semula reasoning_content.",
	"Use for Anthropic-compatible endpoints that reject eager tool input streaming.":
		"Gunakan untuk endpoint serasi Anthropic yang menolak penstriman input alat eager.",
	"Send session_id header": "Hantar pengepala session_id",
	"Long cache retention": "Pengekalan cache panjang",
	"Reasoning replay": "Main semula pemikiran",
	"Eager tool input streaming": "Penstriman input alat eager",
	"Please fill in all required fields": "Sila isi semua medan wajib",
	"Please add at least one model ID": "Sila tambah sekurang-kurangnya satu ID model",
	"Failed to save provider": "Gagal menyimpan penyedia",
	"OpenAI Completions Compatible": "Serasi OpenAI Completions",
	"OpenAI Responses Compatible": "Serasi OpenAI Responses",
	"Anthropic Messages Compatible": "Serasi Anthropic Messages",
	"Checking...": "Menyemak...",
	Disconnected: "Terputus",
	Language: "Bahasa",
	"Display language": "Bahasa paparan",
	"Choose the interface language for this browser.": "Pilih bahasa antara muka untuk pelayar ini.",
	"Language changes are saved locally in this browser.":
		"Perubahan bahasa disimpan secara setempat dalam pelayar ini.",
	"Interface language": "Bahasa antara muka",
	English: "Inggeris",
	"Simplified Chinese": "Cina Ringkas",
	German: "Jerman",
	Malay: "Bahasa Melayu",
	"AI Coding Platform": "Platform Pengekodan AI",
	"New Session": "Sesi baharu",
	"Click to edit title": "Klik untuk mengedit tajuk",
	"Demo: Add Custom Notification": "Demo: Tambah pemberitahuan tersuai",
	"AITC platform logo": "Logo platform AITC",
	"Load a browser or configured local conversation": "Muatkan perbualan pelayar atau tempatan yang dikonfigurasi",
	"Load a browser conversation": "Muatkan perbualan pelayar",
	"Creating file": "Mencipta fail",
	"Created file": "Fail dicipta",
	"Rewriting file": "Menulis semula fail",
	"Updating file": "Mengemas kini fail",
	"Updated file": "Fail dikemas kini",
	"Reading file": "Membaca fail",
	"Read file": "Fail dibaca",
	"Deleting file": "Memadam fail",
	"Deleted file": "Fail dipadam",
	"Listing project files": "Menyenaraikan fail projek",
	"Listed project files": "Fail projek disenaraikan",
	"File operation failed": "Operasi fail gagal",
	"Processing file": "Memproses fail",
	"Processed file": "Fail diproses",
	"Running command": "Menjalankan arahan",
	"Ran command": "Arahan dijalankan",
	"Preview ready": "Pratonton sedia",
	"Preparing preview": "Menyediakan pratonton",
	"Prepared preview": "Pratonton disediakan",
};

setTranslations(translations);

export * from "@mariozechner/mini-lit/dist/i18n.js";
