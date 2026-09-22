import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSkillTools, validateToolNames, validateWriteToolOwnership } from "../../scripts/validate-skills.mjs";

describe("skill tool validation", () => {
  const tool = (name: string) => ({
    name,
    handlerKey: name,
    outputSchema: {
      type: "object",
      properties: { result: { type: "object" } },
      required: ["result"],
    },
  });
  const contractTools = validateToolNames([tool("get_training_state"), tool("save_current_plan")]);

  it("rejects manifest tools that are absent from the MCP contract", () => {
    expect(() => validateSkillTools("test-skill", { allowedTools: ["missing_tool"] }, "", contractTools))
      .toThrow("manifest references unknown MCP tools: missing_tool");
  });

  it("rejects Skill tool references that are not allowed by the manifest", () => {
    expect(() => validateSkillTools("test-skill", { allowedTools: ["get_training_state"] }, "Call `save_current_plan`.", contractTools))
      .toThrow("SKILL.md references tools missing from manifest allowedTools: save_current_plan");
  });

  it("rejects duplicate MCP tool names", () => {
    expect(() => validateToolNames([tool("get_training_state"), tool("get_training_state")]))
      .toThrow("MCP contract contains duplicate tools: get_training_state");
  });

  it("rejects tools without a typed result schema", () => {
    expect(() => validateToolNames([{ ...tool("get_training_state"), outputSchema: { type: "object", properties: { result: {} }, required: ["result"] } }]))
      .toThrow("MCP tool get_training_state has an untyped result schema");
  });

  it("rejects two Skills owning the same write tool", () => {
    const contract = { tools: [{ ...tool("save_current_plan"), annotations: { readOnlyHint: false } }] };
    expect(() => validateWriteToolOwnership([
      ["planner", { allowedTools: ["save_current_plan"] }],
      ["other", { allowedTools: ["save_current_plan"] }],
    ], contract)).toThrow("write tool save_current_plan is already owned by planner");
  });

  it("rejects a write tool without a Skill owner", () => {
    const contract = { tools: [{ ...tool("save_current_plan"), annotations: { readOnlyHint: false } }] };
    expect(() => validateWriteToolOwnership([["coach", { allowedTools: [] }]], contract))
      .toThrow("write tools must have exactly one Skill owner: save_current_plan");
  });

  it("lets every Skill call the shared export handshake without owning it", () => {
    const contract = { tools: [
      { ...tool("report_skill_version"), annotations: { readOnlyHint: false } },
      { ...tool("save_current_plan"), annotations: { readOnlyHint: false } },
    ] };
    const owners = validateWriteToolOwnership([
      ["coach", { allowedTools: ["report_skill_version"] }],
      ["planner", { allowedTools: ["report_skill_version", "save_current_plan"] }],
      ["workout", { allowedTools: [] }],
    ], contract);
    expect(owners.get("report_skill_version")).toBeUndefined();
    expect(owners.get("save_current_plan")).toBe("planner");
  });
});

describe("Athria Skill routing and least privilege", () => {
  const root = join(import.meta.dirname, "../..");
  const manifest = (name: string) => JSON.parse(readFileSync(join(root, "packages/skills", name, "manifest.json"), "utf8"));
  const coach = manifest("athria-coach");
  const planner = manifest("athria-training-planner");
  const profile = manifest("athria-athlete-profile");
  const workout = manifest("athria-workout");
  const xunji = manifest("athria-xunji-records");

  it("keeps coaching read-only", () => {
    const contract = JSON.parse(readFileSync(join(root, "crates/athria-mcp/contract.json"), "utf8"));
    const writeTools = new Set(contract.tools.filter((tool: any) => tool.annotations?.readOnlyHint === false).map((tool: any) => tool.name));
    expect(coach.allowedTools.filter((name: string) => writeTools.has(name))).toEqual([]);
  });

  it("routes onboarding and plan-impact review through the profile Skill without plan writes", () => {
    expect(profile.allowedTools).toEqual(expect.arrayContaining(["update_athlete_profile", "update_wellness", "get_plan_adjustment_review"]));
    expect(profile.allowedTools).not.toContain("save_current_plan");
  });

  it("keeps cycle writes in Planner and immediate execution writes in Workout", () => {
    expect(planner.allowedTools).toEqual(expect.arrayContaining(["save_current_plan", "validate_current_plan"]));
    expect(planner.allowedTools).not.toEqual(expect.arrayContaining(["update_athlete_profile", "update_planned_session", "record_training_session"]));
    expect(workout.allowedTools).toEqual(expect.arrayContaining(["get_next_training_day", "update_planned_session", "record_training_session"]));
    expect(workout.allowedTools).not.toContain("save_current_plan");
  });

  it("keeps Xunji records isolated and read-only", () => {
    expect(xunji.allowedTools).toEqual(["get_xunji_sync_status", "list_xunji_training_sessions"]);
  });
});
