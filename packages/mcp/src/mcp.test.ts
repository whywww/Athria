import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AthriaApplication, AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { ZodError } from "zod";
import * as z from "zod";
import { createMcpServer, describeToolError } from "./index";

let repository: AthriaRepository | undefined;
afterEach(() => repository?.close());

describe("MCP registry", () => {
  it("connects over an MCP transport", async () => {
    repository = new AthriaRepository(":memory:");
    const server = createMcpServer(new AthriaApplication(repository));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    expect(clientTransport).toBeDefined();
    await server.close();
  });

  it("matches the Rust shared tool contract fixture", async () => {
    repository = new AthriaRepository(":memory:");
    const tools = new AthriaApplication(repository).toolRegistry().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema),
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, idempotentHint: tool.idempotent, openWorldHint: false },
    }));
    const fixture = await Bun.file(new URL("../contract.json", import.meta.url)).json() as { tools: unknown[] };
    expect(tools).toEqual(fixture.tools);
  });
});

describe("tool error reporting", () => {
  it("keeps AthriaError codes and maps validation and unknown errors", () => {
    expect(describeToolError(new AthriaError("REVISION_CONFLICT", "The current plan changed. Refresh and try again."))).toEqual({ message: "The current plan changed. Refresh and try again.", code: "REVISION_CONFLICT" });
    expect(describeToolError(new ZodError([])).code).toBe("INVALID_INPUT");
    expect(describeToolError(new Error("boom"))).toEqual({ message: "boom", code: "INTERNAL_ERROR" });
    expect(describeToolError("plain failure")).toEqual({ message: "plain failure", code: "INTERNAL_ERROR" });
  });
});
