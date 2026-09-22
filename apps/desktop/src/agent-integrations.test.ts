import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { AddAgentModal, AgentIntegrations, AgentTiles, ManualAgentSetup, MoreAgentsModal, SkillArchiveGuideModal, SkillUpdateConflictModal, agentTileColumns, shortenHomePath, sortAgentRoster, splitAgentTiles } from "./App";
import type { AgentIntegrationStatus, McpStatus } from "./api";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const render = (node: ReactElement, rows: AgentIntegrationStatus[]) => {
  const client = new QueryClient();
  client.setQueryData(["agent-integrations"], rows);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
};

const mcpStatus: McpStatus = { configured: true, executablePath: "C:/Program Files/Athria/athria.exe", arguments: ["mcp"], skillsPath: "C:/Program Files/Athria/skills", homeDir: "C:/Users/test" };

const renderWithHome = (node: ReactElement, rows: AgentIntegrationStatus[]) => {
  const client = new QueryClient();
  client.setQueryData(["agent-integrations"], rows);
  client.setQueryData(["mcp-status"], mcpStatus);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
};

const withClient = (node: ReactElement) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, node));

const integrations: AgentIntegrationStatus[] = [
  { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.codex/config.toml", skillsPath: "C:/Users/test/.agents/skills", skillsMode: "filesystem", skillReports: [], restartRequired: true },
  { agent: "claude_code", name: "Claude Code", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.claude.json", skillsPath: "C:/Users/test/.claude/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false },
  { agent: "claude_desktop", name: "Claude Desktop", available: false, mcp: "outdated", skills: "unverified", configPath: "C:/Users/test/AppData/Roaming/Claude/claude_desktop_config.json", skillsMode: "gui_managed", skillReports: [], restartRequired: false, diagnostic: "Claude Desktop supports Athria through MCP only." },
];

const codex: AgentIntegrationStatus = { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.codex/config.toml", skillsPath: "C:/Users/test/.agents/skills", skillsMode: "filesystem", skillReports: [], restartRequired: true };
const claudeCode: AgentIntegrationStatus = { agent: "claude_code", name: "Claude Code", available: true, mcp: "installed", skills: "installed", configPath: "C:/Users/test/.claude.json", skillsPath: "C:/Users/test/.claude/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false };
const claudeDesktop: AgentIntegrationStatus = { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "installed", skills: "unverified", configPath: "C:/Users/test/AppData/Roaming/Claude/claude_desktop_config.json", skillsMode: "gui_managed", skillReports: [], restartRequired: false };
const trio = [codex, claudeCode, claudeDesktop];

const qoderCn: AgentIntegrationStatus = { agent: "qoder_cn", name: "Qoder CN", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.qoder-cn/mcp.json", skillsPath: "C:/Users/test/.qoder-cn/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false };
const traeCn: AgentIntegrationStatus = { agent: "trae_cn", name: "Trae CN", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.trae-cn/mcp.json", skillsPath: "C:/Users/test/.trae-cn/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false };
const cursor: AgentIntegrationStatus = { agent: "cursor", name: "Cursor", available: true, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.cursor/mcp.json", skillsPath: "C:/Users/test/.cursor/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false };
const workBuddy: AgentIntegrationStatus = { agent: "workbuddy", name: "WorkBuddy", available: false, mcp: "missing", skills: "missing", configPath: "C:/Users/test/.workbuddy/mcp.json", skillsPath: "C:/Users/test/.workbuddy/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false, diagnostic: "WorkBuddy was not detected. You can configure it after installing the agent." };

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
    expect(html).toContain("Skills setup required");
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
    expect(html).toContain("<small>MCP</small>");
    expect(html).toContain("C:/Users/test/.codex/config.toml");
    expect(html).toContain("C:/Users/test/.agents/skills");
    expect(html).toContain("Remove Agent");
    expect(html).toContain("Update");
  });

  it("shortens the tile menu paths but keeps the full path on hover", () => {
    const html = renderWithHome(createElement(AgentIntegrations), [codex]);
    expect(html).toContain('title="C:/Users/test/.codex/config.toml"><span><small>MCP</small><code>~/.codex/config.toml</code>');
    expect(html).toContain('title="C:/Users/test/.agents/skills"><span><small>Skills</small><code>~/.agents/skills</code>');
  });

  it("shows the standard empty module when nothing is connected", () => {
    const html = render(createElement(AgentIntegrations), [
      { agent: "codex", name: "Codex", available: true, mcp: "missing", skills: "missing", configPath: "C:/a/config.toml", skillsPath: "C:/a/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false },
      { agent: "claude_code", name: "Claude Code", available: true, mcp: "missing", skills: "missing", configPath: "C:/b/claude.json", skillsPath: "C:/b/skills", skillsMode: "filesystem", skillReports: [], restartRequired: false },
      { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "missing", skills: "unverified", configPath: "C:/c/claude_desktop_config.json", skillsMode: "gui_managed", skillReports: [], restartRequired: false },
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
      { agent: "codex", name: "Codex", available: true, mcp: "installed", skills: "missing", configPath: "C:/x/config.toml", skillsPath: "C:/x/skills", skillsMode: "filesystem", skillReports: [], restartRequired: true },
      { agent: "claude_code", name: "Claude Code", available: false, mcp: "unavailable", skills: "unavailable", configPath: "C:/y/config.json", skillsMode: "filesystem", skillReports: [], restartRequired: false },
    ]);
    expect(html.match(/class="agent-tile"/g)).toHaveLength(1);
    expect(html).toContain("Needs attention");
    expect(html).toContain("Repair");
    expect(html).not.toContain("agent-tile-more");
    expect(html).not.toContain("Claude Code");
  });

  it("lists every agent in the Add Agent dialog with its config path", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), integrations);
    expect(html).toContain('id="agent-modal-title"');
    expect(html).toContain("Claude Code");
    expect(html).toContain(">MCP</small>");
    expect(html).toContain("C:/Users/test/.claude.json");
    expect(html).toContain("Skills");
    expect(html).toContain("C:/Users/test/.claude/skills");
    expect(html).toContain("C:/Users/test/.codex/config.toml");
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(1);
    expect(html.match(/class="agent-modal-connected"/g)).toHaveLength(1);
    expect(html.match(/class="agent-modal-pending"/g)).toHaveLength(1);
    expect(html).toContain("Skills setup required");
  });

  it("shows agent paths relative to the home folder", () => {
    const html = renderWithHome(createElement(AddAgentModal, { onClose: () => {} }), [codex, qoderCn]);
    expect(html).toContain('title="C:/Users/test/.codex/config.toml">~/.codex/config.toml</code>');
    expect(html).toContain('title="C:/Users/test/.qoder-cn/skills">~/.qoder-cn/skills</code>');
  });

  it("keeps a connected agent in the list with a green check instead of a connect action", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [codex]);
    expect(html).toContain("Codex");
    expect(html).toContain("C:/Users/test/.codex/config.toml");
    expect(html.match(/class="agent-modal-connected"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Connected"');
    expect(html.match(/>Connect<\/button>/g)).toBeNull();
  });

  it("mixes green checks and connect actions in one list", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [codex, traeCn]);
    expect(html.match(/class="agent-modal-connected"/g)).toHaveLength(1);
    expect(html.match(/>Connect<\/button>/g)).toHaveLength(1);
  });

  it("points a GUI-managed agent at the archives Athria prepared instead of a Skills folder", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [
      { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "installed", skills: "unverified", configPath: "C:/c/claude_desktop_config.json", skillArchiveDir: "C:/a/agent-integration/claude_desktop", skillsMode: "gui_managed", skillReports: [], restartRequired: true },
    ]);
    expect(html).toContain("Claude Desktop");
    expect(html).toContain(">MCP</small>");
    expect(html).toContain("C:/c/claude_desktop_config.json");
    expect(html).toContain("C:/a/agent-integration/claude_desktop");
    expect(html).toContain('class="agent-modal-pending"');
    expect(html).toContain("Skills setup required");
    expect(html).not.toContain("Need manual install");
  });

  it("advertises prepared archives before a GUI-managed agent has been connected", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [
      { agent: "claude_desktop", name: "Claude Desktop", available: true, mcp: "missing", skills: "missing", configPath: "C:/c/claude_desktop_config.json", skillsMode: "gui_managed", skillReports: [], restartRequired: false },
    ]);
    expect(html).toContain("Athria prepares these when you Connect");
    expect(html).not.toContain("Need manual install");
    expect(html).not.toContain('class="agent-modal-connected"');
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

  it("shows a Skills path for every agent that supports Skills", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [qoderCn, traeCn, cursor, workBuddy]);
    expect(html).toContain("C:/Users/test/.qoder-cn/skills");
    expect(html).toContain("C:/Users/test/.trae-cn/skills");
    expect(html).toContain("C:/Users/test/.cursor/skills");
    expect(html).toContain("C:/Users/test/.workbuddy/skills");
    expect(html).not.toContain("Need manual install");
  });

  it("keeps the manual setup entry point in the dialog", () => {
    const html = render(createElement(AddAgentModal, { onClose: () => {} }), [codex]);
    expect(html.match(/class="agent-modal-connected"/g)).toHaveLength(1);
    expect(html).toContain("Manually add them");
  });
});

describe("ManualAgentSetup", () => {
  it("asks for a name and the two filesystem paths", () => {
    const html = renderToStaticMarkup(createElement(ManualAgentSetup));
    expect(html).toContain("Tell me your agent name");
    expect(html).toContain("Agent name");
    expect(html).toContain("MCP config file");
    expect(html).toContain("Skills folder");
    expect(html).toContain('placeholder="~/path/to/mcp.json"');
    expect(html).toContain('placeholder="~/path/to/skills"');
    expect(html).not.toContain("agent-prompt-chevron");
    expect(html).toContain('disabled=""');
    expect(html).toContain("Test connection");
  });

  it("reports a duplicate name before connection", () => {
    const html = renderToStaticMarkup(createElement(ManualAgentSetup, { existing: [codex] }));
    expect(html).not.toContain("An agent with this name already exists.");
  });
});

describe("agent roster order", () => {
  it("sorts installed agents first and each group by name", () => {
    expect(sortAgentRoster([workBuddy, traeCn, codex, qoderCn]).map((agent) => agent.name)).toEqual(["Codex", "Qoder CN", "Trae CN", "WorkBuddy"]);
  });

  it("renders a custom agent with an initial avatar", () => {
    const custom: AgentIntegrationStatus = { ...codex, agent: "custom_1", name: "Nimbus" };
    const html = render(createElement(AgentIntegrations), [custom]);
    expect(html).toContain("agent-custom");
    expect(html).toContain('class="agent-custom-initial">N</span>');
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

describe("SkillUpdateConflictModal", () => {
  const conflict = { agent: "codex" as const, name: "Codex", skills: [{ name: "athria-coach", installedVersion: "1.0.0", bundledVersion: "1.1.0" }] };

  it("shows the changed Skills and both replacement choices", () => {
    const html = withClient(createElement(SkillUpdateConflictModal, { conflict, result: undefined, busy: false, error: undefined, onResolve: () => {}, onClose: () => {} }));
    expect(html).toContain("Codex Skills were modified");
    expect(html).toContain("athria-coach");
    expect(html).toContain("1.0.0 → 1.1.0");
    expect(html).toContain(">Replace</button>");
    expect(html).toContain("Backup &amp; Replace");
    expect(html).toContain("Not now");
  });

  it("shows the backup path after backup and replace", () => {
    const html = withClient(createElement(SkillUpdateConflictModal, { conflict, result: { agent: "codex", skills: ["athria-coach"], backupPath: "C:/Athria/backups/codex" }, busy: false, error: undefined, onResolve: () => {}, onClose: () => {} }));
    expect(html).toContain("Skills updated");
    expect(html).toContain("Backup saved");
    expect(html).toContain("C:/Athria/backups/codex");
  });
});

describe("agent tile layout math", () => {
  it("counts the columns a grid width fits", () => {
    expect(agentTileColumns(1140)).toBe(5);
    expect(agentTileColumns(1139)).toBe(4);
    expect(agentTileColumns(910)).toBe(4);
    expect(agentTileColumns(909)).toBe(3);
    expect(agentTileColumns(220)).toBe(1);
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

describe("shortenHomePath", () => {
  it("rewrites the home prefix as a tilde with forward slashes", () => {
    expect(shortenHomePath("C:\\Users\\test\\.qoder-cn\\mcp.json", "C:\\Users\\test")).toBe("~/.qoder-cn/mcp.json");
    expect(shortenHomePath("/Users/test/.cursor/skills", "/Users/test")).toBe("~/.cursor/skills");
    expect(shortenHomePath("/home/test/.trae-cn/mcp.json", "/home/test/")).toBe("~/.trae-cn/mcp.json");
  });

  it("matches the home folder regardless of drive letter case", () => {
    expect(shortenHomePath("c:/users/test/.codex/config.toml", "C:\\Users\\test")).toBe("~/.codex/config.toml");
  });

  it("leaves paths outside the home folder and unknown homes untouched", () => {
    expect(shortenHomePath("C:/Program Files/Athria/athria.exe", "C:/Users/test")).toBe("C:/Program Files/Athria/athria.exe");
    expect(shortenHomePath("C:\\Users\\test\\.codex\\config.toml", undefined)).toBe("C:\\Users\\test\\.codex\\config.toml");
  });
});

describe("GUI-managed agent Skills", () => {
  const verified: AgentIntegrationStatus = { ...claudeDesktop, skills: "installed", skillReports: [{ name: "athria-coach", expectedVersion: "0.1.0", reportedVersion: "0.1.0", current: true, lastSeenAt: "2026-01-01T00:00:00.000Z" }] };
  const archives = [{ name: "athria-coach", version: "0.1.0", path: "C:/a/athria-coach-0.1.0.zip" }, { name: "athria-workout", version: "0.1.0", path: "C:/a/athria-workout-0.1.0.zip" }];

  it("asks for Skills setup instead of reporting a fresh install as connected", () => {
    const html = renderWithHome(createElement(AgentIntegrations), [claudeDesktop]);
    expect(html).toContain('class="agent-tile-state skills_setup_required"');
    expect(html).toContain("Skills setup required");
    expect(html).not.toContain('agent-tile-state connected');
  });

  it("reports Connected once a reported Skill matches the bundled version", () => {
    const html = renderWithHome(createElement(AgentIntegrations), [verified]);
    expect(html).toContain('class="agent-tile-state connected"');
    expect(html).toContain(">Connected</span>");
  });

  it("asks for an update once a reported Skill is behind the bundle", () => {
    const html = renderWithHome(createElement(AgentIntegrations), [{ ...verified, skills: "outdated" }]);
    expect(html).toContain("Update available");
    expect(html).toContain("Update MCP / Skills");
  });

  it("offers Update MCP / Skills for GUI-managed agents and Update or Repair for the rest", () => {
    const gui = renderWithHome(createElement(AgentIntegrations), [verified]);
    expect(gui).toContain("Update MCP / Skills");
    const filesystem = renderWithHome(createElement(AgentIntegrations), [{ ...codex, mcp: "outdated" }]);
    expect(filesystem).toContain("Update</button>");
    expect(filesystem).not.toContain("Update MCP / Skills");
  });

  it("guides the upload with the prepared archives", () => {
    const html = withClient(createElement(SkillArchiveGuideModal, {
      guide: { name: "Claude Desktop", archiveDir: "C:/a/agent-integration/claude_desktop", archives, updating: false },
      onClose: () => {},
    }));
    expect(html).toContain("Finish connecting Claude Desktop");
    expect(html).toContain("Choose Customize, then Skills.");
    expect(html).toContain("the 2 ZIP files");
    expect(html).toContain("athria-coach");
    expect(html).toContain("C:/a/agent-integration/claude_desktop");
    expect(html).toContain("Open ZIP folder");
    expect(html).toContain("Athria shows Connected once Claude Desktop runs a Skill");
  });

  it("turns the guide into a refresh when Athria has a newer bundle", () => {
    const html = withClient(createElement(SkillArchiveGuideModal, {
      guide: { name: "Claude Desktop", archiveDir: "C:/a/agent-integration/claude_desktop", archives: [], updating: true },
      onClose: () => {},
    }));
    expect(html).toContain("Claude Desktop needs the refreshed Skills");
    expect(html).toContain("refreshed the MCP configuration");
    expect(html).toContain("the ZIP files");
  });
});
