import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { DeliveryMode, PlatformCapability, PlatformContract } from "./platform-contract.js";

export interface RequestedCapabilityEvidence {
	capability: PlatformCapability;
	matchedText: string;
	messageIndex: number;
	reason: string;
}

export interface CapabilityPlan {
	deliveryMode: DeliveryMode;
	requestedCapabilities: PlatformCapability[];
	supportedCapabilities: PlatformCapability[];
	unsupportedCapabilities: PlatformCapability[];
	requiresSimulation: boolean;
	requiresClarification: boolean;
	evidence: RequestedCapabilityEvidence[];
	userVisibleContract: string;
	diagnosticReason: string;
}

export interface CapabilityPlanInput {
	messages: AgentMessage[];
	platform: PlatformContract;
	source?: "browser" | "worker" | "test";
}

type CapabilityPattern = {
	capability: PlatformCapability;
	reason: string;
	patterns: RegExp[];
};

const CAPABILITY_PATTERNS: CapabilityPattern[] = [
	{
		capability: "backend_server",
		reason: "The request asks for a backend or server runtime.",
		patterns: [
			/\bapi server\b/i,
			/\bbackend(?:s)?\b/i,
			/\bserver(?:\s+runtime|\s+service|\s+services)?\b/i,
			/\brest api(?:s)?\b/i,
			/\bapi(?:s)?\b/i,
		],
	},
	{
		capability: "database_runtime",
		reason: "The request asks for database-backed persistence.",
		patterns: [
			/\bpostgres(?:ql)?\b/i,
			/\bsqlite\b/i,
			/\bmysql\b/i,
			/\bdatabase(?:s)?\b/i,
			/\bdb\b/i,
			/\bpersistence\b/i,
			/\bpersistent\b/i,
		],
	},
	{
		capability: "server_auth",
		reason: "The request asks for server-side authentication or login sessions.",
		patterns: [/\bauth(?:entication)?\b/i, /\blogin\b/i, /\bsign[- ]?in\b/i, /\bsession(?:s)?\b/i],
	},
	{
		capability: "file_upload_runtime",
		reason: "The request asks for runtime file uploads.",
		patterns: [/\bfile upload(?:s)?\b/i, /\bupload(?:s|ing)?\b/i],
	},
	{
		capability: "scheduled_jobs",
		reason: "The request asks for scheduled or background jobs.",
		patterns: [/\bscheduled job(?:s)?\b/i, /\bcron\b/i, /\bbackground job(?:s)?\b/i],
	},
	{
		capability: "external_integration_runtime",
		reason: "The request asks for external integration runtime behavior.",
		patterns: [
			/\bexternal integration(?: runtime)?\b/i,
			/\bwebhook(?:s)?\b/i,
			/\bthird[- ]party integration(?:s)?\b/i,
		],
	},
	{
		capability: "build_static_frontend",
		reason: "The request asks for a build-based frontend.",
		patterns: [/\bvite\b/i, /\breact\b/i, /\bvue\b/i, /\bsvelte\b/i, /\bstatic dist\b/i, /\bfrontend build\b/i],
	},
	{
		capability: "static_assets",
		reason: "The request asks for directly previewable static UI assets.",
		patterns: [/\bstatic\b/i, /\bhtml\b/i, /\bcss\b/i, /\blanding page\b/i, /\bdashboard\b/i, /\bui\b/i],
	},
];

const DEFAULT_STATIC_CAPABILITY: PlatformCapability = "static_assets";

export function planCapabilities(input: CapabilityPlanInput): CapabilityPlan {
	const evidence = collectEvidence(input.messages);
	const requestedCapabilities = requestedCapabilitiesFromEvidence(evidence);
	if (requestedCapabilities.length === 0) requestedCapabilities.push(DEFAULT_STATIC_CAPABILITY);

	const supportedSet = new Set(input.platform.supportedCapabilities);
	const supportedCapabilities = requestedCapabilities.filter((capability) => supportedSet.has(capability));
	const unsupportedCapabilities = requestedCapabilities.filter((capability) => !supportedSet.has(capability));
	const deliveryMode = resolveDeliveryMode(requestedCapabilities, unsupportedCapabilities, input.platform);
	const requiresSimulation = deliveryMode === "static_simulation";
	const requiresClarification = deliveryMode === "needs_clarification" || deliveryMode === "unsupported";

	return {
		deliveryMode,
		requestedCapabilities,
		supportedCapabilities,
		unsupportedCapabilities,
		requiresSimulation,
		requiresClarification,
		evidence,
		userVisibleContract: buildUserVisibleContract(input.platform, deliveryMode, unsupportedCapabilities),
		diagnosticReason: buildDiagnosticReason(
			input.platform,
			deliveryMode,
			requestedCapabilities,
			unsupportedCapabilities,
		),
	};
}

export function formatCapabilityPlanForPrompt(plan: CapabilityPlan): string {
	const unsupported = plan.unsupportedCapabilities.length > 0 ? plan.unsupportedCapabilities.join(", ") : "none";
	const requested = plan.requestedCapabilities.length > 0 ? plan.requestedCapabilities.join(", ") : "none";
	return [
		"<capability_plan>",
		`delivery_mode: ${plan.deliveryMode}`,
		`requested_capabilities: ${requested}`,
		`unsupported_capabilities: ${unsupported}`,
		`requires_static_simulation: ${plan.requiresSimulation ? "true" : "false"}`,
		`user_visible_contract: ${plan.userVisibleContract}`,
		"</capability_plan>",
	].join("\n");
}

export function capabilityPlanDiagnosticData(plan: CapabilityPlan): Record<string, unknown> {
	return {
		deliveryMode: plan.deliveryMode,
		requestedCapabilities: plan.requestedCapabilities,
		supportedCapabilities: plan.supportedCapabilities,
		unsupportedCapabilities: plan.unsupportedCapabilities,
		requiresSimulation: plan.requiresSimulation,
		requiresClarification: plan.requiresClarification,
		evidence: plan.evidence,
		diagnosticReason: plan.diagnosticReason,
	};
}

function collectEvidence(messages: AgentMessage[]): RequestedCapabilityEvidence[] {
	const evidence: RequestedCapabilityEvidence[] = [];
	const seen = new Set<PlatformCapability>();
	for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
		const text = messageText(messages[messageIndex]);
		if (!text) continue;
		for (const candidate of CAPABILITY_PATTERNS) {
			if (seen.has(candidate.capability)) continue;
			const matchedText = firstMatch(text, candidate.patterns);
			if (!matchedText) continue;
			seen.add(candidate.capability);
			evidence.push({
				capability: candidate.capability,
				matchedText,
				messageIndex,
				reason: candidate.reason,
			});
		}
	}
	return evidence;
}

function requestedCapabilitiesFromEvidence(evidence: RequestedCapabilityEvidence[]): PlatformCapability[] {
	return evidence.map((item) => item.capability);
}

function resolveDeliveryMode(
	requestedCapabilities: PlatformCapability[],
	unsupportedCapabilities: PlatformCapability[],
	platform: PlatformContract,
): DeliveryMode {
	if (unsupportedCapabilities.length > 0) {
		return platform.deliveryModes.includes("static_simulation") ? "static_simulation" : "unsupported";
	}
	if (requestedCapabilities.includes("build_static_frontend")) return "build_static_frontend";
	return "static_app";
}

function buildUserVisibleContract(
	platform: PlatformContract,
	deliveryMode: DeliveryMode,
	unsupportedCapabilities: PlatformCapability[],
): string {
	if (deliveryMode === "static_simulation") {
		return `Current platform adapter ${platform.adapterId} cannot provide ${unsupportedCapabilities.join(
			", ",
		)}. Deliver a static simulation that preserves the requested product behavior with mock APIs, sample data, and local browser state, and state this limitation plainly to the user.`;
	}
	if (deliveryMode === "build_static_frontend") {
		return `Current platform adapter ${platform.adapterId} can run configured static frontend build tasks and publish browser-ready static output.`;
	}
	return `Current platform adapter ${platform.adapterId} can deliver directly previewable static assets.`;
}

function buildDiagnosticReason(
	platform: PlatformContract,
	deliveryMode: DeliveryMode,
	requestedCapabilities: PlatformCapability[],
	unsupportedCapabilities: PlatformCapability[],
): string {
	const requested = requestedCapabilities.length > 0 ? requestedCapabilities.join(", ") : "none";
	const unsupported = unsupportedCapabilities.length > 0 ? unsupportedCapabilities.join(", ") : "none";
	return `${platform.adapterId} selected ${deliveryMode}; requested=${requested}; unsupported=${unsupported}`;
}

function firstMatch(text: string, patterns: RegExp[]): string | undefined {
	for (const pattern of patterns) {
		const match = text.match(pattern);
		if (match?.[0]) return match[0];
	}
	return undefined;
}

function messageText(message: AgentMessage | undefined): string {
	if (!message) return "";
	const record = message as unknown as Record<string, unknown>;
	const values: string[] = [];
	appendText(values, record.llmContent);
	appendText(values, record.content);
	return values.join("\n");
}

function appendText(values: string[], value: unknown): void {
	if (typeof value === "string") {
		values.push(value);
		return;
	}
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (!isRecord(item)) continue;
		appendText(values, item.text);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
