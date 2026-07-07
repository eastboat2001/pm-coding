export type ApplicationGenerationRuntimeVersion = "v2";

export interface ApplicationGenerationRuntimeSelection {
	version: ApplicationGenerationRuntimeVersion;
	v1Disabled: true;
	reason: string;
}

export interface SelectApplicationGenerationRuntimeInput {
	requestedVersion?: string;
	allowDebugV1?: boolean;
}
