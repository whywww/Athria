import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressionByDomain } from "./ProgressionByDomain";

describe("ProgressionByDomain", () => {
  it("renders and independently marks the current phase for every domain", () => {
    const html = renderToStaticMarkup(<ProgressionByDomain currentWeek={3} progressions={[
      { domain: "strength", phases: [{ id: "strength-foundation", phaseType: "foundation", name: "Foundation", startWeek: 1, endWeek: 2, focus: "Build a baseline", progression: [] }, { id: "strength-build", phaseType: "progression", name: "Build", startWeek: 3, endWeek: 4, focus: "Progress repetitions", progression: ["Add load after reaching the rep ceiling"] }] },
      { domain: "endurance", phases: [{ id: "endurance-base", phaseType: "foundation", name: "Base", startWeek: 1, endWeek: 3, focus: "Build aerobic volume", progression: ["Extend easy duration"] }, { id: "endurance-peak", phaseType: "peak", name: "Sharpen", startWeek: 4, endWeek: 4, focus: "Retain intensity", progression: [] }] },
    ]} />);

    expect(html).toContain("Progression by Domain");
    expect(html).toContain("Strength");
    expect(html).toContain("Endurance");
    expect(html.match(/aria-current="true"/g)).toHaveLength(2);
    expect(html).toContain("Add load after reaching the rep ceiling");
    expect(html).not.toContain("Progression Guideline");
  });
});
