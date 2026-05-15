import tailwindcss from "@tailwindcss/vite";
import { configuredStoragePlugin } from "@mariozechner/pi-web-workspace";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [configuredStoragePlugin(), tailwindcss()],
});
