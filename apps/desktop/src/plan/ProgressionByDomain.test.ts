import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Mesocycle } from "../view-models";
import { ProgressionByDomain } from "./ProgressionByDomain";

const progressions: Mesocycle["domainProgressions"] = [
  { domain: "strength", phases: [
    { id: "strength-build", phaseType: "progression", name: "Build", startWeek: 3, endWeek: 4, focus: "Progress repetitions", progression: ["Add load after reaching the rep ceiling", "This extra rule stays hidden"] },
    { id: "strength-foundation", phaseType: "foundation", name: "Foundation", startWeek: 1, endWeek: 2, focus: "Build a baseline", progression: [] },
  ] },
  { domain: "endurance", phases: [
    { id: "endurance-base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 3, focus: "Build aerobic volume", progression: ["Extend easy duration"] },
    { id: "endurance-peak", phaseType: "peak", name: "Sharpen", startWeek: 4, endWeek: 4, focus: "Retain intensity", progression: [] },
  ] },
];

describe("ProgressionByDomain", () => {
  it("renders one module with sorted domain tracks and independent current phases", () => {
    const html = renderToStaticMarkup(createElement(ProgressionByDomain, { currentWeek: 3, progressions }));

    expect(html).toContain('<section class="pdb-section"><h3 class="pdb-heading">Progression by Domain</h3>');
    expect(html).toContain("Strength");
    expect(html).toContain("Endurance");
    expect(html.match(/class="pdb-domain"/g)).toHaveLength(2);
    expect(html.match(/aria-current="true"/g)).toHaveLength(2);
    expect(html).toContain("Add load after reaching the rep ceiling");
    expect(html).not.toContain("This extra rule stays hidden");
    expect(html).not.toContain("Build a baseline");
    expect(html).not.toContain("Progress repetitions");
    expect(html.indexOf("Foundation")).toBeLessThan(html.indexOf("Build"));
    expect(html.match(/pdb-phase-arrow/g)).toHaveLength(2);
  });

  it("supports a single phase and non-strength domains without inventing body copy", () => {
    const singleDomain: Mesocycle["domainProgressions"] = [
      { domain: "sport_skill", phases: [{ id: "skill", phaseType: "foundation", name: "Acquisition", startWeek: 1, endWeek: 1, focus: "This focus stays hidden", progression: [] }] },
    ];
    const html = renderToStaticMarkup(createElement(ProgressionByDomain, { currentWeek: 1, progressions: singleDomain }));

    expect(html).toContain("Sport skill");
    expect(html).toContain("Acquisition");
    expect(html).toContain("W1");
    expect(html).not.toContain("This focus stays hidden");
    expect(html).not.toContain("pdb-phase-progression");
    expect(html).not.toContain("pdb-phase-arrow");
  });
});
