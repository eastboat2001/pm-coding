export type PlatformCapability =
	| "static_assets"
	| "build_static_frontend"
	| "mock_api"
	| "local_state"
	| "backend_server"
	| "database_runtime"
	| "server_auth"
	| "file_upload_runtime"
	| "scheduled_jobs"
	| "external_integration_runtime";

export type DeliveryMode =
	| "static_app"
	| "build_static_frontend"
	| "static_simulation"
	| "full_stack"
	| "needs_clarification"
	| "unsupported";

export interface PlatformContract {
	adapterId: string;
	deliveryModes: readonly DeliveryMode[];
	supportedCapabilities: readonly PlatformCapability[];
	unsupportedCapabilities: readonly PlatformCapability[];
	projectTaskNames: readonly string[];
	promptContract: string;
}

export const STATIC_PREVIEW_CONTRACT: PlatformContract = {
	adapterId: "static-preview",
	deliveryModes: ["static_app", "build_static_frontend", "static_simulation"],
	supportedCapabilities: ["static_assets", "build_static_frontend", "mock_api", "local_state"],
	unsupportedCapabilities: [
		"backend_server",
		"database_runtime",
		"server_auth",
		"file_upload_runtime",
		"scheduled_jobs",
		"external_integration_runtime",
	],
	projectTaskNames: ["inspect", "validate", "build_static", "preview", "logs"],
	promptContract:
		"PI currently uses the static-preview adapter. It can create static assets, run configured static frontend builds, publish static preview output, and simulate APIs or persistence in browser state. It cannot run backend servers, databases, server auth, file upload runtimes, scheduled jobs, or external integration runtimes.",
};
