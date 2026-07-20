import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@mariozechner/pi-ai/complete-simple",
				replacement: fileURLToPath(new URL("../../packages/ai/src/complete-simple.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-ai/env-api-keys",
				replacement: fileURLToPath(new URL("../../packages/ai/src/env-api-keys.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-ai/models",
				replacement: fileURLToPath(new URL("../../packages/ai/src/models.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-ai/types",
				replacement: fileURLToPath(new URL("../../packages/ai/src/types.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-web-workspace/agent-v2-response-language",
				replacement: fileURLToPath(
					new URL("../../packages/web-workspace/src/agent-v2-response-language.ts", import.meta.url),
				),
			},
			{
				find: "@mariozechner/pi-web-workspace/agent-v2-runtime",
				replacement: fileURLToPath(
					new URL("../../packages/web-workspace/src/agent-v2-runtime.ts", import.meta.url),
				),
			},
			{
				find: "@mariozechner/pi-web-workspace/runtime-infra",
				replacement: fileURLToPath(new URL("../../packages/web-workspace/src/runtime-infra.ts", import.meta.url)),
			},
			{
				find: "@mariozechner/pi-web-workspace/skill-tool-contract",
				replacement: fileURLToPath(
					new URL("../../packages/web-workspace/src/skill-tool-contract.ts", import.meta.url),
				),
			},
			{
				find: /^@mariozechner\/pi-web-ui$/u,
				replacement: fileURLToPath(new URL("../../packages/web-ui/src/index.ts", import.meta.url)),
			},
			{
				find: /^@mariozechner\/pi-agent-core$/u,
				replacement: fileURLToPath(new URL("../../packages/agent/src/index.ts", import.meta.url)),
			},
			{
				find: /^@mariozechner\/pi-ai$/u,
				replacement: fileURLToPath(new URL("../../packages/ai/src/index.ts", import.meta.url)),
			},
			{
				find: /^@mariozechner\/pi-tui$/u,
				replacement: fileURLToPath(new URL("../../packages/tui/src/index.ts", import.meta.url)),
			},
			{
				find: /^@mariozechner\/pi-web-workspace$/u,
				replacement: fileURLToPath(new URL("../../packages/web-workspace/src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		include: ["test/**/*.test.ts"],
	},
});
