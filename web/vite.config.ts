import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const e2e = process.env.VITE_E2E === "1";

/**
 * Preload the few font files the first screen needs, straight from the HTML head. Without this
 * they only start downloading after the JS has run (main.tsx waits for them before the first
 * paint), which put them on the critical path on slow mobile connections.
 */
function preloadFonts(patterns: RegExp[]): Plugin {
  return {
    name: "ostrakon-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => patterns.some((p) => p.test(f)));
        return files.map((f) => ({
          tag: "link",
          attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [
    react(),
    preloadFonts([
      /public-sans-latin-400-normal-[^/]+\.woff2$/,
      /public-sans-latin-600-normal-[^/]+\.woff2$/,
      /fraunces-latin-opsz-normal-[^/]+\.woff2$/,
      /ibm-plex-mono-latin-400-normal-[^/]+\.woff2$/,
    ]),
  ],
  server: { port: 5173, strictPort: true },
  preview: { port: e2e ? 4174 : 4173, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL(e2e ? "../dist-e2e" : "../dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
