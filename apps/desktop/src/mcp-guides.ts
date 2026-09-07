export interface McpGuide {
  id: "codex" | "claude" | "qoder" | "trae" | "cursor";
  name: string;
  path: string;
  mode: "form" | "config";
  instructions: string;
}

export const mcpGuides: McpGuide[] = [
  { id: "codex", name: "Codex", path: "Settings → Plugins → Add MCP server", mode: "form", instructions: "Enter the values below, then save the server." },
  { id: "claude", name: "Claude Desktop", path: "Settings → Developer or Extensions → Edit Config", mode: "config", instructions: "Add the configuration below, save the file, then restart Claude Desktop." },
  { id: "qoder", name: "Qoder / Qoder CN", path: "Extensions → Connectors → Add Connector → Add custom MCP", mode: "form", instructions: "Choose Form and enter the values below. In older versions, choose JSON and use the configuration shown here." },
  { id: "trae", name: "Trae", path: "Settings → MCP → Add Server", mode: "form", instructions: "Choose STDIO, enter the values below, then save the server." },
  { id: "cursor", name: "Cursor", path: "Cursor Settings → MCP & Integrations → Add Custom MCP", mode: "config", instructions: "Add the configuration below and save it." },
];

export function mcpConfig(executablePath: string): string {
  return JSON.stringify({ mcpServers: { Athria: { command: executablePath, args: ["mcp"] } } }, null, 2);
}
