import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const buildRoot = resolve(process.env.ATHRIA_BUILD_ROOT ?? join(homedir(), "Documents", "HAILEY", "Athria"));

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  cacheDir: join(buildRoot, "vite-cache"),
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2021", sourcemap: true, outDir: join(buildRoot, "frontend"), emptyOutDir: true },
});
