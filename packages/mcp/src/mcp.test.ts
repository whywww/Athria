import { afterEach, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { AthriaApplication } from "@athria/application";
import { AthriaRepository } from "@athria/data";
import { createMcpServer } from "./index";

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
