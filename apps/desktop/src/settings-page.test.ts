import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "./App";
import type { AgentIntegrationStatus, McpStatus } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mcpStatus: McpStatus = { configured: true, executablePath: "C:/Program Files/Athria/athria.exe", arguments: ["mcp"], skillsPath: "C:/Program Files/Athria/skills", homeDir: "C:/Users/test" };

function renderSettings(rows: AgentIntegrationStatus[]) {
  const client = new QueryClient();
  client.setQueryData(["agent-integrations"], rows);
  client.setQueryData(["mcp-status"], mcpStatus);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Settings)));
}

const filesystemAgent: AgentIntegrationStatus = { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "installed", skillsMode: "filesystem", configPath: "C:/Users/test/.codex/config.toml", skillsPath: "C:/Users/test/.agents/skills", skillReports: [], restartRequired: true };

const guiAgent: AgentIntegrationStatus = { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "installed", skills: "unverified", skillsMode: "gui_managed", configPath: "C:/Users/test/AppData/Roaming/Claude/claude_desktop_config.json", skillArchiveDir: "C:/Users/test/AppData/Local/Athria/agent-integration/claude_desktop", skillReports: [{ name: "athria-coach", expectedVersion: "0.1.0", current: false }], restartRequired: true };

describe("settings page", () => {
  it("renders every card with the agents Athria knows", () => {
    const markup = renderSettings([filesystemAgent, guiAgent]);
    expect(markup).toContain("Personal Information");
    expect(markup).toContain("Connect to Your AI Agents");
    expect(markup).toContain("Claude Desktop");
    expect(markup).toContain("Codex");
  });

  it("renders with no connected agents", () => {
    expect(renderSettings([])).toContain("Connect to Your AI Agents");
  });
});
