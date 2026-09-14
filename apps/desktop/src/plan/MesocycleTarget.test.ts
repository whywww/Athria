import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CurrentPlan } from "../view-models";
import { MesocycleTarget } from "./MesocycleTarget";

const plan: CurrentPlan = {
  planSchemaVersion: "7.0",
  ownerId: "local-user",
  title: "10K Build",
  summary: "",
  effectiveStartDate: "2026-09-07",
  mesocycle: {
    durationWeeks: 1,
    schedule: { kind: "fixed_week", days: [1] },
    domainProgressions: [],
    weeks: [],
    adjustmentRules: [],
  },
  revision: 1,
  sourceAgent: null,
  model: null,
  skillVersion: null,
  inputSnapshotHash: null,
  updatedAt: "2026-09-07T00:00:00Z",
  target: {
    primaryGoal: { label: "Run a faster 10K" },
    supporting: [{ label: "Strength", detail: "Maintain twice weekly" }],
  },
};

describe("MesocycleTarget", () => {
  it("renders plan details collapsed by default", () => {
    const html = renderToStaticMarkup(createElement(MesocycleTarget, {
      plan,
      today: "2026-09-07",
      currentWeek: 1,
      currentPhaseNames: [],
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Plan details");
    expect(html).not.toContain('id="mt-details-panel"');
    expect(html).not.toContain("Maintain twice weekly");
  });
});
