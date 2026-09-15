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

    expect(html).toContain('<section class="pdb-section"><h3 class="pdb-heading">Progression by Domain</h3><p class="pdb-subheading">Training phases and focus for each domain</p>');
    expect(html).toContain('data-domain="strength"');
    expect(html).toContain("Strength");
    expect(html).toContain("Endurance");
    expect(html.match(/class="pdb-domain"/g)).toHaveLength(2);
    expect(html.match(/class="pdb-phase-marker"/g)).toHaveLength(4);
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

  it("windows long tracks to three phases and exposes scroll arrows", () => {
    const longTrack: Mesocycle["domainProgressions"] = [
      { domain: "strength", phases: [
        { id: "p1", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 1, focus: "f", progression: [] },
        { id: "p2", phaseType: "progression", name: "Build", startWeek: 2, endWeek: 2, focus: "f", progression: [] },
        { id: "p3", phaseType: "peak", name: "Sharpen", startWeek: 3, endWeek: 3, focus: "f", progression: [] },
        { id: "p4", phaseType: "deload", name: "Peak", startWeek: 4, endWeek: 4, focus: "f", progression: [] },
        { id: "p5", phaseType: "test", name: "Taper", startWeek: 5, endWeek: 5, focus: "f", progression: [] },
      ] },
    ];

    const middle = renderToStaticMarkup(createElement(ProgressionByDomain, { currentWeek: 3, progressions: longTrack }));
    expect(middle.match(/class="pdb-phase-marker"/g)).toHaveLength(3);
    expect(middle).toContain("Sharpen");
    expect(middle).toContain("Peak");
    expect(middle).toContain("Taper");
    expect(middle).not.toContain("Base");
    expect(middle).not.toContain("Build");
    expect(middle).toContain('aria-label="Show earlier phases"');
    expect(middle).not.toContain("Show later phases");
    expect(middle.match(/pdb-phase-arrow/g)).toHaveLength(2);

    const head = renderToStaticMarkup(createElement(ProgressionByDomain, { currentWeek: 1, progressions: longTrack }));
    expect(head.match(/class="pdb-phase-marker"/g)).toHaveLength(3);
    expect(head).toContain("Base");
    expect(head).toContain("Build");
    expect(head).toContain("Sharpen");
    expect(head).not.toContain("Peak");
    expect(head).not.toContain("Taper");
    expect(head).not.toContain("Show earlier phases");
    expect(head).toContain("pdb-nav-spacer");
    expect(head.match(/Show later phases/g)).toHaveLength(3);
  });
});
