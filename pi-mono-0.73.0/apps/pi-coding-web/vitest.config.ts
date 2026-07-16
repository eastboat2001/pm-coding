import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@mariozechner/pi-web-ui",
				replacement: fileURLToPath(new URL("../../packages/web-ui/src/index.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-agent-core",
				replacement: fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-ai",
				replacement: fileURLToPath(new URL("../../packages/ai/src/index.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-tui",
				replacement: fileURLToPath(new URL("../../packages/tui/src/index.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-web-workspace",
				replacement: fileURLToPath(new URL("../../packages/web-workspace/src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
