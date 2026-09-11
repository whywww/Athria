import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionTemplate } from "../view-models";
import { TemplateNodes } from "./TemplateNodes";

describe("TemplateNodes", () => {
  it("shows every strength node without redundant defaults or role labels", () => {
    const template: SessionTemplate = { id: "lower", name: "Lower", intent: "Train lower body.", domain: "strength", nodes: [
      { name: "Squat pattern", role: "primary", variables: ["exercise_selection", "sets"], optionalVariables: ["load"], movementPatternIds: ["squat"], targetMuscleIds: ["quadriceps"], matchPolicy: "all" },
      { role: "trunk", optional: true, variables: ["duration"], movementPatternIds: ["anti_rotation"] },
    ] };
    const html = renderToStaticMarkup(createElement(TemplateNodes, { template }));
    expect(html).toContain("Squat pattern");
    expect(html).not.toContain(">Primary<");
    expect(html).toContain(">Trunk<");
    expect(html).toContain("Exercise Selection");
    expect(html).toContain("Optional");
    expect(html).not.toContain("Required");
    expect(html).not.toContain("None");
    expect(html).toContain("Patterns");
    expect(html).toContain("Muscles");
    expect(html).toContain("Match all");
  });

  it("omits empty optional and strength-only metadata", () => {
    const template: SessionTemplate = { id: "easy", name: "Easy", intent: "Run easy.", domain: "endurance", nodes: [{ role: "warm_up", variables: ["duration"] }] };
    const html = renderToStaticMarkup(createElement(TemplateNodes, { template }));
    expect(html).toContain("Warm Up");
    expect(html).toContain("Duration");
    expect(html).not.toContain("Optional");
    expect(html).not.toContain("Patterns");
    expect(html).not.toContain("Muscles");
    expect(html).not.toContain("Match");
  });
});
