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
  it("uses domain IDs for phase icons and colors regardless of translated labels", () => {
    const html = renderToStaticMarkup(createElement(MesocycleTarget, {
      plan,
      today: "2026-09-07",
      currentWeek: 1,
      currentPhases: [
        { domain: "endurance", name: "耐力训练 · 游泳与跑走重启" },
        { domain: "strength", name: "力量训练 · 全身力量维持" },
      ],
    }));
    expect(html).toContain('class="mt-progress-phase" data-domain="endurance"');
    expect(html).toContain('class="mt-progress-phase" data-domain="strength"');
    expect(html).toContain('cx="13.5" cy="5.5"');
    expect(html).toContain('d="M7 9v6M4.5 10.5v3M17 9v6M19.5 10.5v3M7 12h10"');
    expect(html).not.toContain('cx="12" cy="12" r="3"');
  });

  it("renders the plan details collapsed by default", () => {
    const html = renderToStaticMarkup(createElement(MesocycleTarget, {
      plan,
      today: "2026-09-07",
      currentWeek: 1,
      currentPhases: [],
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Plan Details");
    expect(html).not.toContain('id="mt-details-panel"');
    expect(html).not.toContain("Maintain twice weekly");
    expect(html).not.toContain('id="mt-supporting-panel"');
    expect(html).toContain("10K Build");
    expect(html).toContain("Sep 7 – Sep 13");
    expect(html).not.toContain("mt-mark");
  });

  it("keeps legacy plans readable without rendering an empty details shell", () => {
    const { target: _target, ...planWithoutTarget } = plan;
    const legacy: CurrentPlan = { ...planWithoutTarget, summary: "Build a durable aerobic base" };
    const html = renderToStaticMarkup(createElement(MesocycleTarget, {
      plan: legacy,
      today: "2026-09-07",
      currentWeek: 1,
      currentPhases: [{ domain: "endurance", name: "Endurance · Base" }],
    }));

    expect(html).toContain("Build a durable aerobic base");
    expect(html).toContain("Endurance · Base");
    expect(html).not.toContain("Plan Details");
  });
});
