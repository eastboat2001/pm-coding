import type {
	ApplicationGenerationRuntimeSelection,
	SelectApplicationGenerationRuntimeInput,
} from "./types.js";

const V2_APPLICATION_GENERATION_RUNTIME: ApplicationGenerationRuntimeSelection = {
	version: "v2",
	v1Disabled: true,
	reason:
		"Application Generation Agent v2 is the replacement default; v1 is not a compatibility target.",
};

export function selectApplicationGenerationRuntime(
	input: SelectApplicationGenerationRuntimeInput,
): ApplicationGenerationRuntimeSelection {
	if (input.requestedVersion === "v1" && !input.allowDebugV1) {
		throw new Error("Application Generation Agent v1 is retired and cannot be selected");
	}

	return V2_APPLICATION_GENERATION_RUNTIME;
}
