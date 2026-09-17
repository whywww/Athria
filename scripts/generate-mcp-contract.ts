import * as z from "zod";
import { AthriaApplication } from "../packages/application/src/index";
import { AthriaRepository } from "../packages/data/src/index";

const output = process.argv[2];
if (!output) throw new Error("Usage: bun scripts/generate-mcp-contract.ts <output.json>");

const repository = new AthriaRepository(":memory:");
try {
  const tools = new AthriaApplication(repository).toolRegistry().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: z.toJSONSchema(tool.inputSchema),
    annotations: {
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.idempotent,
      openWorldHint: false,
    },
  }));
  await Bun.write(output, `${JSON.stringify({ server: { name: "Athria", version: "0.2.0" }, tools })}\n`);
} finally {
  repository.close();
}
