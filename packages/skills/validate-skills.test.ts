import { describe, expect, it } from "vitest";
import { validateSkillTools, validateToolNames } from "../../scripts/validate-skills.mjs";

describe("skill tool validation", () => {
  const contractTools = validateToolNames([{ name: "get_training_state" }, { name: "save_current_plan" }]);

  it("rejects manifest tools that are absent from the MCP contract", () => {
    expect(() => validateSkillTools("test-skill", { allowedTools: ["missing_tool"] }, "", contractTools))
      .toThrow("manifest references unknown MCP tools: missing_tool");
  });

  it("rejects Skill tool references that are not allowed by the manifest", () => {
    expect(() => validateSkillTools("test-skill", { allowedTools: ["get_training_state"] }, "Call `save_current_plan`.", contractTools))
      .toThrow("SKILL.md references tools missing from manifest allowedTools: save_current_plan");
  });

  it("rejects duplicate MCP tool names", () => {
    expect(() => validateToolNames([{ name: "get_training_state" }, { name: "get_training_state" }]))
      .toThrow("MCP contract contains duplicate tools: get_training_state");
  });
});
