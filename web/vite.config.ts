import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const e2e = process.env.VITE_E2E === "1";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  envDir: fileURLToPath(new URL("..", import.meta.url)),
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: e2e ? 4174 : 4173, strictPort: true },
  build: {
    outDir: fileURLToPath(new URL(e2e ? "../dist-e2e" : "../dist", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
  },
});
