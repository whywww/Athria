import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const buildRoot = resolve(projectRoot, "..", "Athria");

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  cacheDir: join(buildRoot, "vite-cache"),
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2021", sourcemap: true, outDir: join(buildRoot, "frontend"), emptyOutDir: true },
});
