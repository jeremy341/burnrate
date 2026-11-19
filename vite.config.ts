import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5780, proxy: { "/api": "http://127.0.0.1:13780" } },
  build: { outDir: "dist/web", chunkSizeWarningLimit: 1500 },
});
