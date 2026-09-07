import { describe, expect, it } from "vitest";
import { mcpConfig, mcpGuides } from "./mcp-guides";

describe("MCP setup guides", () => {
  it("covers the supported desktop agents and excludes ChatGPT", () => {
    expect(mcpGuides.map((guide) => guide.name)).toEqual(["Codex", "Claude Desktop", "Qoder / Qoder CN", "Trae", "Cursor"]);
    expect(mcpGuides.some((guide) => guide.name === "ChatGPT")).toBe(false);
  });

  it("preserves custom Windows paths and escapes them in JSON", () => {
    const path = "D:\\AI Tools\\训练\\Athria.exe";
    const config = mcpConfig(path);
    expect(JSON.parse(config).mcpServers.Athria).toEqual({ command: path, args: ["mcp"] });
  });
});
