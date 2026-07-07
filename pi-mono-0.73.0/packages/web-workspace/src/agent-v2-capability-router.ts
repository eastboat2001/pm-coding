import type {
	AgentV2CapabilityDecision,
	AgentV2CapabilityDeliveryMode,
	AgentV2PlatformContract,
} from "./agent-v2-types.js";

const DEFAULT_UNSUPPORTED_CAPABILITIES = [
	"database_runtime",
	"server_auth",
	"backend_server",
	"file_upload_runtime",
	"scheduled_jobs",
	"external_integration_runtime",
] as const;

const CLARIFICATION_PATTERNS = [
	/\b(make|build|create)\s+(an?\s+)?app\b/i,
	/\bmake something\b/i,
	/\bhelp me\b/i,
] as const;

const STATIC_APP_PATTERNS = [
	/\bportfolio\b/i,
	/\bwebsite\b/i,
	/\blanding page\b/i,
	/\bdashboard\b/i,
	/\bmarketing site\b/i,
	/\bcontact form\b/i,
	/\bmock data\b/i,
] as const;

const FRONTEND_BUILD_PATTERNS = [/\breact\b/i, /\bvue\b/i, /\bfrontend\b/i, /\bcomponent library\b/i] as const;

const DATABASE_PATTERNS = [/\bpostgres(?:ql)?\b/i, /\bdatabase\b/i, /\bsql\b/i, /\bprisma\b/i, /\borm\b/i] as const;
const AUTH_PATTERNS = [/\bauth\b/i, /\blogin\b/i, /\bsign[ -]?in\b/i, /\buser roles?\b/i, /\bpermissions?\b/i] as const;
const BACKEND_PATTERNS = [/\bapi routes?\b/i, /\bbackend\b/i, /\bserver\b/i, /\bendpoint\b/i] as const;
const FILE_UPLOAD_PATTERNS = [/\bupload files?\b/i, /\bfile uploads?\b/i, /\battachments?\b/i] as const;
const SCHEDULED_JOB_PATTERNS = [/\bcron jobs?\b/i, /\bscheduled jobs?\b/i, /\bschedulers?\b/i, /\bbackground jobs?\b/i] as const;
const EXTERNAL_INTEGRATION_PATTERNS = [
	/\bwebhooks?\b/i,
	/\bthird-party integrations?\b/i,
	/\bexternal integrations?\b/i,
	/\bintegrations?\b/i,
] as const;

type Evidence = AgentV2CapabilityDecision["evidence"][number];

export const STATIC_APP_V2_PLATFORM_CONTRACT: AgentV2PlatformContract = Object.freeze({
	runtime: "static_browser_app",
	framework: "vite",
	deliveryMode: "static_app",
	entrypoints: ["index.html", "src/main.ts", "src/main.tsx"],
	deliverables: ["static frontend app", "mock-data interactions", "preview-ready assets"],
	constraints: [
		"No backend server runtime is available.",
		"No live database or external auth runtime is available.",
		"Interactive flows that need server state must be delivered as explicit static simulations.",
	],
	supportedDeliveryModes: [
		"static_app",
		"build_static_frontend",
		"static_simulation",
		"needs_clarification",
		"unsupported",
	] satisfies AgentV2CapabilityDeliveryMode[],
	unsupportedCapabilities: [...DEFAULT_UNSUPPORTED_CAPABILITIES],
	userVisibleContract:
		"This workspace ships a static app contract: frontend-only delivery, mock data allowed, and server-dependent features must be framed as a static simulation.",
	metadata: {
		contractId: "static_app_v2",
	},
});

export function routeAgentV2Capabilities(input: {
	objective: string;
	platform?: AgentV2PlatformContract;
}): AgentV2CapabilityDecision {
	const objective = input.objective.trim();
	const platform = input.platform ?? STATIC_APP_V2_PLATFORM_CONTRACT;

	if (!objective) {
		return buildDecision({
			deliveryMode: "needs_clarification",
			objective,
			platform,
			evidence: [{ capability: "clarification", matchedText: "", reason: "Objective is empty." }],
			summary: "Need a more specific product objective before routing.",
			rationale: "The request does not identify enough product scope, domain, or interaction detail to select a safe delivery mode.",
			requiresClarification: true,
			requiresSimulation: false,
			unsupportedCapabilities: [],
			constraints: ["Clarify the target product, audience, and core workflow before implementation."],
			alternatives: [
				{ capability: "static_app", reason: "Could be appropriate once the UI surface is described." },
				{ capability: "static_simulation", reason: "Needed only if the clarified scope depends on server-side behavior." },
			],
		});
	}

	const evidence: Evidence[] = [];
	const unsupportedCapabilities = new Set<string>();

	collectEvidence(objective, STATIC_APP_PATTERNS, "static_app", "Signals a frontend-first static app request.", evidence);
	collectEvidence(objective, FRONTEND_BUILD_PATTERNS, "build_static_frontend", "Specifies frontend implementation details.", evidence);
	collectUnsupportedEvidence(
		objective,
		DATABASE_PATTERNS,
		"database_runtime",
		"Requires runtime persistence that the static platform contract does not provide.",
		evidence,
		unsupportedCapabilities,
	);
	collectUnsupportedEvidence(
		objective,
		AUTH_PATTERNS,
		"server_auth",
		"Requires authentication or role enforcement that needs a server-side authority.",
		evidence,
		unsupportedCapabilities,
	);
	collectUnsupportedEvidence(
		objective,
		BACKEND_PATTERNS,
		"backend_server",
		"Requires backend request handling beyond a static frontend bundle.",
		evidence,
		unsupportedCapabilities,
	);
	collectUnsupportedEvidence(
		objective,
		FILE_UPLOAD_PATTERNS,
		"file_upload_runtime",
		"Requires a file upload runtime and persistence flow that the static platform contract does not provide.",
		evidence,
		unsupportedCapabilities,
	);
	collectUnsupportedEvidence(
		objective,
		SCHEDULED_JOB_PATTERNS,
		"scheduled_jobs",
		"Requires scheduled or background job execution beyond a static frontend bundle.",
		evidence,
		unsupportedCapabilities,
	);
	collectUnsupportedEvidence(
		objective,
		EXTERNAL_INTEGRATION_PATTERNS,
		"external_integration_runtime",
		"Requires webhook handling or third-party integration runtime behavior outside the static platform contract.",
		evidence,
		unsupportedCapabilities,
	);

	if (matchesAny(objective, CLARIFICATION_PATTERNS) && evidence.length === 0) {
		return buildDecision({
			deliveryMode: "needs_clarification",
			objective,
			platform,
			evidence: [{ capability: "clarification", matchedText: objective, reason: "Objective is too underspecified to route safely." }],
			summary: "Need a more specific product objective before routing.",
			rationale: "The request does not identify enough product scope, domain, or interaction detail to select a safe delivery mode.",
			requiresClarification: true,
			requiresSimulation: false,
			unsupportedCapabilities: [],
			constraints: ["Clarify the target product, audience, and core workflow before implementation."],
			alternatives: [
				{ capability: "static_app", reason: "Could be appropriate once the UI surface is described." },
				{ capability: "static_simulation", reason: "Needed only if the clarified scope depends on server-side behavior." },
			],
		});
	}

	if (unsupportedCapabilities.size > 0) {
		const unsupportedList = [...unsupportedCapabilities];
		return buildDecision({
			deliveryMode: "static_simulation",
			objective,
			platform,
			evidence,
			summary: "Server-dependent requirements must be delivered as an explicit static simulation.",
			rationale:
				"The request includes backend-only capabilities that cannot run under the static app platform contract, so the delivery mode must stay explicit about simulation boundaries.",
			requiresClarification: false,
			requiresSimulation: true,
			unsupportedCapabilities: unsupportedList,
			constraints: [
				...platform.constraints,
				"Call out simulated backend behavior in user-facing copy and implementation notes.",
			],
			alternatives: [
				{ capability: "static_app", reason: "Only valid if backend dependencies are removed or replaced with mock data." },
				{ capability: "unsupported", reason: "Use this when a true server runtime is mandatory and simulation is not acceptable." },
			],
		});
	}

	const deliveryMode: AgentV2CapabilityDeliveryMode = evidence.some((entry) => entry.capability === "build_static_frontend")
		? "build_static_frontend"
		: "static_app";

	return buildDecision({
		deliveryMode,
		objective,
		platform,
		evidence,
		summary: "Objective fits the static frontend platform contract.",
		rationale: "The request can be satisfied with frontend-only delivery and does not require unsupported server runtime capabilities.",
		requiresClarification: false,
		requiresSimulation: false,
		unsupportedCapabilities: [],
		constraints: [...platform.constraints],
		alternatives: [
			{ capability: "static_simulation", reason: "Use this only when server-side workflows must be represented with mock behavior." },
		],
	});
}

function buildDecision(input: {
	deliveryMode: AgentV2CapabilityDeliveryMode;
	objective: string;
	platform: AgentV2PlatformContract;
	evidence: Evidence[];
	summary: string;
	rationale: string;
	requiresSimulation: boolean;
	requiresClarification: boolean;
	unsupportedCapabilities: string[];
	constraints: string[];
	alternatives: AgentV2CapabilityDecision["alternatives"];
}): AgentV2CapabilityDecision {
	const contractText =
		input.deliveryMode === "static_simulation"
			? "Deliver as a static simulation with explicit mock backend behavior."
			: input.platform.userVisibleContract ??
				"This workspace delivers a static frontend app and cannot provide live backend runtime behavior.";

	return {
		kind: "capability_decision",
		selectedCapability: input.deliveryMode,
		deliveryMode: input.deliveryMode,
		summary: input.summary,
		rationale: input.rationale,
		requiresSimulation: input.requiresSimulation,
		requiresClarification: input.requiresClarification,
		unsupportedCapabilities: input.unsupportedCapabilities,
		userVisibleContract: contractText,
		evidence: input.evidence,
		constraints: input.constraints,
		alternatives: input.alternatives,
		metadata: {
			objective: input.objective,
			platformRuntime: input.platform.runtime,
			platformFramework: input.platform.framework,
		},
	};
}

function matchesAny(objective: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(objective));
}

function collectEvidence(
	objective: string,
	patterns: readonly RegExp[],
	capability: string,
	reason: string,
	evidence: Evidence[],
): void {
	for (const pattern of patterns) {
		const match = objective.match(pattern);
		if (match) {
			evidence.push({ capability, matchedText: match[0], reason });
		}
	}
}

function collectUnsupportedEvidence(
	objective: string,
	patterns: readonly RegExp[],
	capability: string,
	reason: string,
	evidence: Evidence[],
	unsupportedCapabilities: Set<string>,
): void {
	let matched = false;
	for (const pattern of patterns) {
		const match = objective.match(pattern);
		if (match) {
			evidence.push({ capability, matchedText: match[0], reason });
			matched = true;
		}
	}
	if (matched) {
		unsupportedCapabilities.add(capability);
	}
}
