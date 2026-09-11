import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AthriaApplication, AthriaError } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { ZodError } from "zod";
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
});

describe("tool error reporting", () => {
  it("keeps AthriaError codes and maps validation and unknown errors", () => {
    expect(describeToolError(new AthriaError("REVISION_CONFLICT", "The current plan changed. Refresh and try again."))).toEqual({ message: "The current plan changed. Refresh and try again.", code: "REVISION_CONFLICT" });
    expect(describeToolError(new ZodError([])).code).toBe("INVALID_INPUT");
    expect(describeToolError(new Error("boom"))).toEqual({ message: "boom", code: "INTERNAL_ERROR" });
    expect(describeToolError("plain failure")).toEqual({ message: "plain failure", code: "INTERNAL_ERROR" });
  });
});
