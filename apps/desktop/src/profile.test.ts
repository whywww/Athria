import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileBoard } from "./App";
import type { AthleteProfile } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Hailey", gender: null, heightCm: null, birthDate: null, timezone: "UTC", goals: [], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, mesocycleDurationWeeks: 8, unitSystem: "metric" };

function renderProfileBoard(overrides: Partial<AthleteProfile> = {}) {
  return renderToStaticMarkup(createElement(ProfileBoard, { profile: { ...profile, ...overrides }, equipmentCategories: [] }));
}

describe("Profile board", () => {
  it("shows the mesocycle length stacked with the max session length", () => {
    const html = renderProfileBoard();
    const stack = html.match(/<div class="profile-column-stack">[\s\S]*?<\/div><\/div><\/section>/)?.[0] ?? "";
    expect(stack).toContain("Max Session Length");
    expect(stack).toContain("Mesocycle Length");
    expect(stack).toContain("8 weeks");
  });
  it("uses the singular week label for a one-week mesocycle", () => {
    expect(renderProfileBoard({ mesocycleDurationWeeks: 1 })).toContain("1 week<");
  });
});
