import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AddAgentModal, AgentIntegrations, AgentTiles, ManualAgentSetup, MoreAgentsModal, agentTileColumns, splitAgentTiles } from "./App";
import type { AgentIntegrationStatus, McpStatus } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const render = (node: ReactElement, rows: AgentIntegrationStatus[]) => {
  const client = new QueryClient();
  client.setQueryData(["agent-integrations"], rows);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
};

const mcpStatus: McpStatus = { configured: true, executablePath: "C:/Program Files/Athria/athria.exe", arguments: ["mcp"], skillsPath: "C:/Program Files/Athria/skills" };

const renderManual = (status: McpStatus) => {
  const client = new QueryClient();
  client.setQueryData(["mcp-status"], status);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ManualAgentSetup)));
};

const withClient = (node: ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));

const integrations: AgentIntegrationStatus[] = [
  { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.codex/config.toml", skillsPath: "C:/Users/test/.agents/skills", restartRequired: true },
  { agent: "claude_code", name: "Claude Code", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.claude.json", skillsPath: "C:/Users/test/.claude/skills", restartRequired: false },
  { agent: "claude_desktop", name: "Claude Desktop", available: false, mcp: "outdated", skills: "unsupported", configPath: "C:/Users/test/AppData/Roaming/Claude/claude_desktop_config.json", restartRequired: false, diagnostic: "Claude Desktop supports Athria through MCP only." },
];

const codex: AgentIntegrationStatus = { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.codex/config.toml", skillsPath: "C:/Users/test/.agents/skills", restartRequired: true };
const claudeCode: AgentIntegrationStatus = { agent: "claude_code", name: "Claude Code", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.claude.json", skillsPath: "C:/Users/test/.claude/skills", restartRequired: false };
const claudeDesktop: AgentIntegrationStatus = { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "installed", skills: "unsupported", configPath: "C:/Users/test/AppData/Roaming/Claude/claude_desktop_config.json", restartRequired: false };
const trio = [codex, claudeCode, claudeDesktop];

const qoderCn: AgentIntegrationStatus = { agent: "qoder_cn", name: "Qoder CN", available: true, mcp: "missing", skills: "unsupported", configPath: "C:/Users/test/.qoder-cn/mcp.json", restartRequired: false, diagnostic: "Qoder CN supports Athria through MCP only." };
const traeCn: AgentIntegrationStatus = { agent: "trae_cn", name: "Trae CN", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.trae-cn/mcp.json", skillsPath: "C:/Users/test/.trae-cn/skills", restartRequired: false };
const cursor: AgentIntegrationStatus = { agent: "cursor", name: "Cursor", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.cursor/mcp.json", skillsPath: "C:/Users/test/.cursor/skills", restartRequired: false };
const workBuddy: AgentIntegrationStatus = { agent: "workbuddy", name: "WorkBuddy", available: false, mcp: "missing", skills: "unsupported", configPath: "C:/Users/test/.workbuddy/mcp.json", restartRequired: false, diagnostic: "WorkBuddy was not detected. You can configure it after installing the agent." };

const roster: AgentIntegrationStatus[] = [
  codex,
  claudeCode,
  claudeDesktop,
  { ...qoderCn, mcp: "installed" },
  { ...traeCn, mcp: "installed" },
  { ...cursor, mcp: "installed" },
  { ...workBuddy, mcp: "installed" },
];

describe("AgentIntegrations", () => {
  it("renders one tile per connected agent and hides unconnected ones", () => {
    const html = render(createElement(AgentIntegrations), integrations);
    expect(html.match(/class="agent-tile"/g)).toHaveLength(2);
    expect(html).toContain("Codex");
    expect(html).toContain("Claude Desktop");
    expect(html).not.toContain("Claude Code");
    expect(html).toContain("Connected");
    expect(html).toContain("Update available");
    expect(html).not.toContain("More Agents");
    expect(html).not.toContain("agent-tile-more");
    expect(html).toContain("Add Agent</button>");
    expect(html).not.toContain("Need manual install");
    expect(html).not.toContain("MCP only");
  });

  it("draws the official vendor mark in every agent badge", () => {
    const html = render(createElement(AgentIntegrations), integrations);
    expect(html).toContain('class="agent-icon agent-codex"');
    expect(html).toContain('class="agent-icon agent-claude-desktop"');
    expect(html.match(/class="agent-logo"/g)).toHaveLength(2);
    expect(html).not.toContain(">Co<");
    expect(html).not.toContain(">CD<");
  });

  it("draws a mark for every agent it can connect to, including raster marks", () => {
    const html = render(createElement(AgentIntegrations), roster);
    expect(html.match(/class="agent-tile"/g)).toHaveLength(7);
    expect(html.match(/class="agent-logo"/g)).toHaveLength(7);
    expect(html).toContain('class="agent-icon agent-qoder-cn"');
    expect(html).toContain('class="agent-icon agent-trae-cn"');
    expect(html).toContain('class="agent-icon agent-cursor"');
    expect(html).toContain('class="agent-icon agent-workbuddy"');
    expect(html).toContain('<img class="agent-logo" src=');
  });

  it("keeps paths and the remove action inside the three-dot menu", () => {
    const html = render(createElement(AgentIntegrations), integrations);
    expect(html.match(/class="agent-menu"/g)).toHaveLength(2);
    expect(html).toContain("MCP config");
    expect(html).toContain("C:/Users/test/.codex/config.toml");
    expect(html).toContain("C:/Users/test/.agents/skills");
    expect(html).toContain("Remove Agent");
    expect(html).toContain("Update");
  });

  it("shows the standard empty module when nothing is connected", () => {
    const html = render(createElement(AgentIntegrations), [
      { agent: "codex", name: "Codex", available: true, mcp: "missing", skills: "missing", configPath: "C:/a/config.toml", skillsPath: "C:/a/skills", restartRequired: false },
      { agent: "claude_code", name: "Claude Code", available: true, mcp: "missing", skills: "missing", configPath: "C:/b/claude.json", skillsPath: "C:/b/skills", restartRequired: false },
      { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "missing", skills: "unsupported", configPath: "C:/c/claude_desktop_config.json", restartRequired: false },
    ]);
    expect(html).toContain('class="empty-state"');
    expect(html).toContain("No agents connected yet");
    expect(html).toContain("Use Add Agent to connect an AI agent on this computer.");
    expect(html.match(/Add Agent<\/button>/g)).toHaveLength(1);
    expect(html.match(/class="agent-tile"/g)).toBeNull();
    expect(html).not.toContain("More Agents");
    expect(html).not.toContain("Connected");
  });

  it("marks partial installs as needing attention with a repair action", () => {
    const html = render(createElement(AgentIntegrations), [
      { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "missing", configPath: "C:/x/config.toml", skillsPath: "C:/x/skills", restartRequired: true },
      { agent: "claude_code", name: "Claude Code", available: false, mcp: "unavailable", skills: "unavailable", configPath: "C:/y/config.json", restartRequired: false },
    ]);
    expect(html.match(/class="agent-tile"/g)).toHaveLength(1);
    expect(html).toContain("Needs attention");
    expect(html).toContain("Repair");
    expect(html).not.toContain("agent-tile-more");
    expect(html).not.toContain("Claude Code");
  });

  it("lists only connectable agents in the Add Agent dialog with their config path", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), integrations);
    expect(html).toContain('id="agent-modal-title"');
    expect(html).toContain("Claude Code");
    expect(html).toContain(">MCP</small>");
    expect(html).toContain("C:/Users/test/.claude.json");
    expect(html).toContain("Skills");
    expect(html).toContain("C:/Users/test/.claude/skills");
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("Codex");
    expect(html).not.toContain("Claude Desktop");
    expect(html).not.toContain("Need manual install");
  });

  it("marks the Skills row as needing a manual install for agents without a skills directory", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [
      { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "missing", skills: "unsupported", configPath: "C:/c/claude_desktop_config.json", restartRequired: false },
    ]);
    expect(html).toContain("Claude Desktop");
    expect(html).toContain(">MCP</small>");
    expect(html).toContain("C:/c/claude_desktop_config.json");
    expect(html).toContain("agent-modal-unsupported");
    expect(html).toContain("Need manual install");
  });

  it("offers a manual setup entry point at the bottom of the dialog", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), integrations);
    expect(html).toContain("Don&#x27;t see your agents?");
    expect(html).toContain("Manually add them");
    expect(html).toContain('class="text-button"');
    expect(html).not.toContain("Configure MCP and Skills");
  });

  it("lists agents that are not installed with a disabled connect action", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [qoderCn, workBuddy]);
    expect(html).toContain("Qoder CN");
    expect(html).toContain("WorkBuddy");
    expect(html).toContain("C:/Users/test/.workbuddy/mcp.json");
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(2);
    expect(html).toContain('title="WorkBuddy was not detected. You can configure it after installing the agent."');
  });

  it("keeps the connect action available for a detected agent", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [qoderCn]);
    expect(html).toContain("Qoder CN");
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("disabled=");
  });

  it("shows a Skills path only for the agents that support Skills", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [qoderCn, traeCn, cursor]);
    expect(html).toContain("C:/Users/test/.trae-cn/skills");
    expect(html).toContain("C:/Users/test/.cursor/skills");
    expect(html.match(/class="agent-modal-unsupported"/g)).toHaveLength(1);
    expect(html.match(/Need manual install/g)).toHaveLength(1);
  });

  it("keeps the manual setup entry point when every detected agent is connected", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [codex]);
    expect(html).toContain("All agents are connected.");
    expect(html).toContain("Manually add them");
  });
});

describe("ManualAgentSetup", () => {
  it("hands the user one setup prompt instead of asking them to configure MCP and Skills", () => {
    const html = renderManual(mcpStatus);
    expect(html).toContain("Copy this prompt into your agent");
    expect(html).toContain("1. Register this MCP server");
    expect(html).toContain("&quot;mcpServers&quot;");
    expect(html).toContain("C:/Program Files/Athria/athria.exe");
    expect(html).toContain("C:/Program Files/Athria/skills");
    expect(html).toContain("not updated by Athria");
    expect(html).toContain("<code>Show my recent training sessions</code>");
    expect(html.match(/class="agent-prompt"/g)).toHaveLength(2);
    expect(html.match(/class="app-icon agent-prompt-chevron"/g)).toHaveLength(2);
    expect(html.match(/>Copy<\/button>/g)).toHaveLength(2);
  });

  it("folds the setup prompt into a single collapsed line until the user expands it", () => {
    const html = renderManual(mcpStatus);
    expect(html).toMatch(/class="agent-prompt"><button[^>]*class="agent-prompt-text"[^>]*aria-expanded="false"/);
    expect(html).not.toContain('class="agent-prompt expanded"');
  });

  it("keeps the one-line test prompt expandable-free but copyable", () => {
    const html = renderManual(mcpStatus);
    expect(html).toMatch(/class="agent-prompt"><button[^>]*class="agent-prompt-text" disabled=""/);
  });

  it("falls back to a reinstall hint when the bundled Skills are missing", () => {
    const html = renderManual({ ...mcpStatus, skillsPath: null });
    expect(html).toContain("Reinstall Athria and try again.");
    expect(html).not.toContain("Copy every folder");
    expect(html.match(/class="agent-prompt"/g)).toHaveLength(2);
    expect(html.match(/>Copy<\/button>/g)).toHaveLength(2);
  });
});

describe("AgentTiles", () => {
  it("shows every connected tile while they fit in a single row", () => {
    const html = withClient(createElement(AgentTiles, { agents: trio, columns: 5, onShowMore: () => {} }));
    expect(html.match(/class="agent-tile"/g)).toHaveLength(3);
    expect(html).not.toContain("More Agents");
  });

  it("folds the connected agents that overflow the row into a More agents tile", () => {
    const html = withClient(createElement(AgentTiles, { agents: trio, columns: 2, onShowMore: () => {} }));
    expect(html.match(/class="agent-tile"/g)).toHaveLength(1);
    expect(html).toContain('class="agent-tile agent-tile-more"');
    expect(html).toContain("More Agents");
    expect(html).toContain("2 connected");
    expect(html).toContain("Codex");
    expect(html).not.toContain("Claude Code");
  });
});

describe("MoreAgentsModal", () => {
  it("reuses the connected tiles with their options", () => {
    const html = withClient(createElement(MoreAgentsModal, { agents: [claudeCode, claudeDesktop], onClose: () => {} }));
    expect(html).toContain('id="agent-more-title"');
    expect(html).toContain("More Agents");
    expect(html.match(/class="agent-tile"/g)).toHaveLength(2);
    expect(html.match(/Remove Agent<\/button>/g)).toHaveLength(2);
    expect(html).toContain("Claude Code");
    expect(html).toContain("Claude Desktop");
  });
});

describe("agent tile layout math", () => {
  it("counts the columns a grid width fits", () => {
    expect(agentTileColumns(930)).toBe(5);
    expect(agentTileColumns(929)).toBe(4);
    expect(agentTileColumns(742)).toBe(4);
    expect(agentTileColumns(741)).toBe(3);
    expect(agentTileColumns(178)).toBe(1);
    expect(agentTileColumns(100)).toBe(1);
  });

  it("splits visible and hidden tiles without losing agents", () => {
    expect(splitAgentTiles(trio, null)).toEqual({ visible: trio, hidden: [] });
    expect(splitAgentTiles(trio, 3)).toEqual({ visible: trio, hidden: [] });
    expect(splitAgentTiles(trio, 2)).toEqual({ visible: [codex], hidden: [claudeCode, claudeDesktop] });
    expect(splitAgentTiles(trio, 1)).toEqual({ visible: [codex], hidden: [claudeCode, claudeDesktop] });
  });

  it("folds a full agent roster without losing agents", () => {
    expect(splitAgentTiles(roster, roster.length)).toEqual({ visible: roster, hidden: [] });
    expect(splitAgentTiles(roster, 3)).toEqual({ visible: roster.slice(0, 2), hidden: roster.slice(2) });
  });
});
