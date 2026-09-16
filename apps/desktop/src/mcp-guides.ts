export interface McpGuide {
  id: "chatgpt" | "claude" | "qoder" | "trae" | "cursor" | "workbuddy";
  name: string;
  path: string;
  mode: "form" | "config";
  instructions: string;
}

export const mcpGuides: McpGuide[] = [
  { id: "chatgpt", name: "ChatGPT", path: "Settings → MCP servers → Add server", mode: "form", instructions: "In the ChatGPT desktop app, choose STDIO, enter the values below, then save the server and choose Restart." },
  { id: "claude", name: "Claude Desktop", path: "Settings → Developer or Extensions → Edit Config", mode: "config", instructions: "Add the configuration below, save the file, then restart Claude Desktop." },
  { id: "qoder", name: "Qoder / Qoder CN", path: "Extensions → Connectors → Add Connector → Add custom MCP", mode: "form", instructions: "Choose Form and enter the values below. In older versions, choose JSON and use the configuration shown here." },
  { id: "trae", name: "Trae", path: "Settings → MCP → Add Server", mode: "form", instructions: "Choose STDIO, enter the values below, then save the server." },
  { id: "cursor", name: "Cursor", path: "Cursor Settings → MCP & Integrations → Add Custom MCP", mode: "config", instructions: "Add the configuration below and save it." },
  { id: "workbuddy", name: "WorkBuddy", path: "Connectors → Custom Connector → Configure MCP", mode: "config", instructions: "Add the configuration below and save it, then click Trust on the new server in Connectors. If it does not appear, fully quit and reopen WorkBuddy." },
];

export function mcpConfig(executablePath: string): string {
  return JSON.stringify({ mcpServers: { Athria: { command: executablePath, args: ["mcp"] } } }, null, 2);
}
