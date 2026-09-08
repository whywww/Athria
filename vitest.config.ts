import { defineConfig } from "vitest/config";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const buildRoot = resolve(projectRoot, "..", "Athria");

export default defineConfig({
  cacheDir: join(buildRoot, "vitest-cache"),
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts"],
    attachmentsDir: join(buildRoot, "test-attachments"),
    coverage: { reporter: ["text", "json-summary"], reportsDirectory: join(buildRoot, "coverage") },
  },
});
