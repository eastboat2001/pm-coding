import {
	type AgentV2PlatformContract,
	type AgentV2RunSnapshot,
	buildAgentV2PlanningBootstrap,
	STATIC_APP_V2_PLATFORM_CONTRACT,
} from "@mariozechner/pi-web-workspace";
import { STATIC_PREVIEW_CONTRACT } from "../runtime/platform-contract.js";
import type { ApplicationGenerationRuntimeSelection, ApplicationGenerationRuntimeVersion } from "./types.js";

type TimestampFactory = () => string;

export type ApplicationGenerationRuntimeEntry = ApplicationGenerationRuntimeSelection & {
	platformContract: typeof STATIC_PREVIEW_CONTRACT;
	buildPlanningBootstrap: (input: {
		run: AgentV2RunSnapshot;
		objective?: string;
		platform?: AgentV2PlatformContract;
		now?: TimestampFactory;
	}) => ReturnType<typeof buildAgentV2PlanningBootstrap>;
};

const APPLICATION_GENERATION_RUNTIME_V2: ApplicationGenerationRuntimeSelection = {
	version: "v2",
	v1Disabled: true,
	reason: "Application Generation Agent v2 is the replacement default; v1 is not a compatibility target.",
};

const APPLICATION_GENERATION_RUNTIME_V2_ENTRY: ApplicationGenerationRuntimeEntry = {
	...APPLICATION_GENERATION_RUNTIME_V2,
	platformContract: STATIC_PREVIEW_CONTRACT,
	buildPlanningBootstrap(input) {
		return buildAgentV2PlanningBootstrap({
			...input,
			platform: input.platform ?? STATIC_APP_V2_PLATFORM_CONTRACT,
		});
	},
};

export function selectApplicationGenerationRuntime(input: {
	requestedVersion?: ApplicationGenerationRuntimeVersion | "v1" | (string & {});
	allowDebugV1?: boolean;
}): ApplicationGenerationRuntimeEntry {
	if (input.requestedVersion === "v1" && !input.allowDebugV1) {
		throw new Error("Application Generation Agent v1 is retired and cannot be selected");
	}

	return { ...APPLICATION_GENERATION_RUNTIME_V2_ENTRY };
}
