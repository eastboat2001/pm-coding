import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { configuredStoragePlugin } from "./storage-server";

export default defineConfig({
	plugins: [configuredStoragePlugin(), tailwindcss()],
});
