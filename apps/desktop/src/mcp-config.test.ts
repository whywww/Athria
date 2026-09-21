import { describe, expect, it } from "vitest";
import { agentSetupPrompt, mcpConfig } from "./mcp-config";

describe("MCP server configuration", () => {
  it("preserves custom Windows paths and escapes them in JSON", () => {
    const path = "D:\\AI Tools\\训练\\Athria.exe";
    const config = mcpConfig(path);
    expect(JSON.parse(config).mcpServers.Athria).toEqual({ command: path, args: ["mcp"] });
  });
});

describe("agent setup prompt", () => {
  it("asks the agent to register the MCP server and install the bundled Skills", () => {
    const executablePath = "D:\\AI Tools\\训练\\Athria.exe";
    const skillsPath = "D:\\AI Tools\\训练\\skills";
    const prompt = agentSetupPrompt({ executablePath, skillsPath });
    expect(prompt).toContain("1. Register this MCP server in your own MCP configuration:");
    expect(prompt).toContain(mcpConfig(executablePath));
    expect(prompt).toContain("2. Copy every folder inside");
    expect(prompt).toContain(skillsPath);
    expect(prompt).toContain("not updated by Athria");
    expect(prompt).toContain("3. Reload your MCP configuration");
  });

  it("omits the Skills step when Athria's bundled Skills are missing", () => {
    const prompt = agentSetupPrompt({ executablePath: "C:\\Athria\\athria.exe", skillsPath: null });
    expect(prompt).not.toContain("Copy every folder");
    expect(prompt).toContain("2. Reload your MCP configuration");
  });
});
