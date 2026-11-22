import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** `/`-separated id so the rules behave the same on Windows and Linux. */
const norm = (id: string) => id.replace(/\\/g, "/");

/**
 * Vendor splitting only. Feature areas (Settings, Providers) are real dynamic imports in
 * `src/views/*.tsx`, so Rollup already splits them.
 */
function manualChunks(id: string): string | undefined {
  const file = norm(id);
  if (file.includes("/node_modules/")) {
    if (/node_modules\/(react|react-dom|scheduler)\//.test(file)) return "vendor-react";
    if (file.includes("/node_modules/culori/")) return "vendor-color";
    if (file.includes("/node_modules/jsonc-parser/")) return "vendor-jsonc";
    // lucide-react stays unassigned: tree-shaking keeps only the icons in play and
    // Rollup can share the few the main view and the Settings chunks both use.
    return undefined;
  }
  return undefined;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5780, proxy: { "/api": "http://127.0.0.1:13780" } },
  build: {
    outDir: "dist/web",
    // WebView2 is evergreen and the Linux shell requires WebKitGTK 2.40+ (Safari 16-ish),
    // so ship modern syntax instead of transpiling for old browsers.
    target: "es2022",
    // One CSS file per entry/chunk: a hidden screen never downloads another area's styles.
    cssCodeSplit: true,
    // No source maps in production artifacts; smaller downloads and no source leakage.
    sourcemap: false,
    // The manifest lets `scripts/perf-budget.mjs` attribute every JS/CSS file to an entry.
    manifest: true,
    reportCompressedSize: true,
    chunkSizeWarningLimit: 700,
    // One entry: the app window.
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
      },
      output: { manualChunks },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"] },
});
