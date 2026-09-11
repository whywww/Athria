import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { AthriaError, type AthriaApplication } from "@athria/application";
import { ZodError } from "zod";

/**
 * Reports a machine-readable code beside the human-readable message so that an
 * Agent can decide the next step (for example refresh the plan revision after
 * a REVISION_CONFLICT) without parsing free text.
 */
export function describeToolError(error: unknown): { message: string; code: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof AthriaError) return { message, code: error.code };
  if (error instanceof ZodError) return { message, code: "INVALID_INPUT" };
  return { message, code: "INTERNAL_ERROR" };
}

export function createMcpServer(application: AthriaApplication): McpServer {
  const server = new McpServer({ name: "Athria", version: "0.2.0" }, { capabilities: { tools: {} } });
  for (const tool of application.toolRegistry()) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.readOnly,
        destructiveHint: false,
        idempotentHint: tool.idempotent,
        openWorldHint: false,
      },
    }, async (input) => {
      try {
        const parsed = tool.inputSchema.parse(input);
        const output = await tool.handler(parsed);
        return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
      } catch (error) {
        const described = describeToolError(error);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: described.message, code: described.code }) }] };
      }
    });
  }
  return server;
}

export async function serveMcpStdio(application: AthriaApplication): Promise<void> {
  const server = createMcpServer(application);
  const transport = new StdioServerTransport();
  transport.onerror = (error) => console.error(error);
  await server.connect(transport);
}

export async function createMcpHttpHandler(application: AthriaApplication) {
  const server = createMcpServer(application);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedOrigins: ["tauri://localhost", "http://tauri.localhost"],
    enableDnsRebindingProtection: true,
  });
  await server.connect(transport);
  return (request: Request) => transport.handleRequest(request);
}
