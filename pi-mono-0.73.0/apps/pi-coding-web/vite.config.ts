import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { configuredStoragePlugin } from "../../packages/web-workspace/src/vite-plugin.js";
import { defineConfig } from "vite";
import { validateAgentV2ModelReadiness } from "./src/server/agent-v2-model-readiness.js";
import { configuredViteAllowedHosts } from "./src/server/vite-allowed-hosts.js";

const webWorkspaceSource = fileURLToPath(new URL("../../packages/web-workspace/src/index.ts", import.meta.url));
const webUiSource = fileURLToPath(new URL("../../packages/web-ui/src/index.ts", import.meta.url));
const agentV2ResponseLanguageSource = fileURLToPath(
	new URL("../../packages/web-workspace/src/agent-v2-response-language.ts", import.meta.url),
);
const agentV2RuntimeSource = fileURLToPath(
	new URL("../../packages/web-workspace/src/agent-v2-runtime.ts", import.meta.url),
);
const runtimeInfraSource = fileURLToPath(
	new URL("../../packages/web-workspace/src/runtime-infra.ts", import.meta.url),
);
const skillToolContractSource = fileURLToPath(
	new URL("../../packages/web-workspace/src/skill-tool-contract.ts", import.meta.url),
);
const allowedHosts = configuredViteAllowedHosts();

export default defineConfig({
	server: { allowedHosts },
	preview: { allowedHosts },
	resolve: {
		alias: [
			{ find: /^@mariozechner\/pi-web-ui$/u, replacement: webUiSource },
			{
				find: "@mariozechner/pi-web-workspace/agent-v2-response-language",
				replacement: agentV2ResponseLanguageSource,
			},
			{ find: "@mariozechner/pi-web-workspace/agent-v2-runtime", replacement: agentV2RuntimeSource },
			{ find: "@mariozechner/pi-web-workspace/runtime-infra", replacement: runtimeInfraSource },
			{ find: "@mariozechner/pi-web-workspace/skill-tool-contract", replacement: skillToolContractSource },
			{ find: /^@mariozechner\/pi-web-workspace$/u, replacement: webWorkspaceSource },
		],
	},
	plugins: [configuredStoragePlugin(undefined, { validateAgentV2Start: validateAgentV2ModelReadiness }), tailwindcss()],
});
