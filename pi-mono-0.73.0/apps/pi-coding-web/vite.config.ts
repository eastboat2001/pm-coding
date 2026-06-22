import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
import { configuredStoragePlugin } from "../../packages/web-workspace/src/vite-plugin.js";
import { defineConfig } from "vite";

const webWorkspaceSource = fileURLToPath(new URL("../../packages/web-workspace/src/index.ts", import.meta.url));
const skillToolContractSource = fileURLToPath(
	new URL("../../packages/web-workspace/src/skill-tool-contract.ts", import.meta.url),
);

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@mariozechner/pi-web-workspace/skill-tool-contract", replacement: skillToolContractSource },
			{ find: "@mariozechner/pi-web-workspace", replacement: webWorkspaceSource },
		],
	},
	plugins: [configuredStoragePlugin(), tailwindcss()],
});
