import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProfileBoard } from "./App";
import type { AthleteProfile } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Hailey", gender: null, heightCm: null, birthDate: null, timezone: "UTC", goals: [], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, mesocycleDurationWeeks: 8, unitSystem: "metric", raceDays: [] };

function renderProfileBoard(overrides: Partial<AthleteProfile> = {}) {
  return renderToStaticMarkup(createElement(ProfileBoard, { profile: { ...profile, ...overrides }, equipmentCategories: [] }));
}

describe("Profile board", () => {
  it("shows the mesocycle length stacked with the max session length", () => {
    const html = renderProfileBoard();
    const stack = html.match(/<div class="profile-column-stack">([\s\S]*?)<\/section>/)?.[1] ?? "";
    expect(stack).toContain("Max Session Length");
    expect(stack).toContain("Mesocycle Length");
    expect(stack).toContain("8 weeks");
  });
  it("renders the readonly summary as a three-column card", () => {
    const html = renderProfileBoard();
    expect(html).toContain("profile-top-summary profile-readonly-summary");
    expect(html).toContain("Preferences");
    expect(html).toContain("Training Rhythm");
  });
  it("uses the singular week label for a one-week mesocycle", () => {
    expect(renderProfileBoard({ mesocycleDurationWeeks: 1 })).toContain("1 week<");
  });
  it("highlights the nearest upcoming race in the readonly summary", () => {
    const html = renderProfileBoard({ raceDays: [{ date: "2020-01-01", sport: "10K" }, { date: "2999-03-21", sport: "Marathon" }, { date: "2999-05-01", sport: "Trail Run" }] });
    expect(html).toContain("Race Days");
    expect(html).toContain("Mar 21, 2999 · Marathon");
    expect(html).toContain("+1 more scheduled");
  });
  it("shows an empty race state when no race is upcoming", () => {
    expect(renderProfileBoard({ raceDays: [{ date: "2020-01-01", sport: "10K" }] })).toContain("No upcoming races");
  });
});
