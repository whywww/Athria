import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_SCHEMA_VERSION, jsonSchemas } from "../packages/schemas/src/index.ts";

const outputDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", `v${PLAN_SCHEMA_VERSION.split(".")[0]}`);
mkdirSync(outputDirectory, { recursive: true });

const names: Record<keyof typeof jsonSchemas, string> = {
  athleteProfile: "athlete-profile.json",
  personalInformation: "personal-information.json",
  trainingSession: "training-session.json",
  wellness: "wellness.json",
  sessionTemplate: "session-template.json",
  currentPlan: "current-plan.json",
  planValidation: "plan-validation.json",
};

for (const [name, schema] of Object.entries(jsonSchemas) as Array<[keyof typeof jsonSchemas, unknown]>) {
  writeFileSync(join(outputDirectory, names[name]), `${JSON.stringify(schema, null, 2)}\n`);
}
