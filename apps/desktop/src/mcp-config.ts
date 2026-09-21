export function mcpConfig(executablePath: string): string {
  return JSON.stringify({ mcpServers: { Athria: { command: executablePath, args: ["mcp"] } } }, null, 2);
}

export function agentSetupPrompt({ executablePath, skillsPath }: { executablePath: string; skillsPath: string | null }): string {
  const steps = [
    ["Register this MCP server in your own MCP configuration:", mcpConfig(executablePath)].join("\n"),
    ...(skillsPath
      ? [["Copy every folder inside", skillsPath, "into your own Skills folder. Skills copied by hand are not updated by Athria."].join("\n")]
      : []),
    "Reload your MCP configuration, then confirm you can call Athria's tools.",
  ];
  return ["Add Athria to your own setup on this computer.", "", ...steps.map((step, index) => `${index + 1}. ${step}`)].join("\n");
}
