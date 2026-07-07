import type { ApplicationGenerationRuntimeSelection, ApplicationGenerationRuntimeVersion } from "./types.js";

const APPLICATION_GENERATION_RUNTIME_V2: ApplicationGenerationRuntimeSelection = {
	version: "v2",
	v1Disabled: true,
	reason:
		"Application Generation Agent v2 is the replacement default; v1 is not a compatibility target.",
};

export function selectApplicationGenerationRuntime(
	input: {
		requestedVersion?: ApplicationGenerationRuntimeVersion | "v1" | (string & {});
		allowDebugV1?: boolean;
	},
): ApplicationGenerationRuntimeSelection {
	if (input.requestedVersion === "v1" && !input.allowDebugV1) {
		throw new Error("Application Generation Agent v1 is retired and cannot be selected");
	}

	return { ...APPLICATION_GENERATION_RUNTIME_V2 };
}
