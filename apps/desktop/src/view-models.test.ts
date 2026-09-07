import { describe, expect, it } from "vitest";
import {
  dashboardPages, formatDistance, formatDuration, isPlanDraftApproved, pendingPlanDrafts, primaryPlanDraft, profilePayload, proposalChanges,
  timezoneOptions, type AthleteProfile, type PlanVersion, type StoredDraft,
} from "./view-models";

const profile: AthleteProfile = {
  ownerId: "unexpected-owner", displayName: "Athlete", timezone: "Europe/London", goals: ["general_fitness"], priority: "balanced",
  weeklyStrengthSessions: 2, weeklyEnduranceSessions: 2, maxSessionMinutes: 60, trainingDays: [], equipment: ["bodyweight"],
  excludedExercises: ["burpee"], constraints: ["quiet workouts"], explicitRecoveryHours: null,
};

describe("dashboard view models", () => {
  it("exposes only the user-facing navigation", () => {
    expect(dashboardPages.map((page) => page.id)).toEqual(["Overview", "Training", "Profile", "Plan", "Devices", "Settings", "Help"]);
    expect(dashboardPages.find((page) => page.id === "Training")?.label).toBe("Training");
    expect(dashboardPages.find((page) => page.id === "Devices")?.group).toBe("support");
  });

  it("formats summary values in readable units", () => {
    expect(formatDuration(135)).toBe("2 hr 15 min");
    expect(formatDistance(5250)).toBe("5.3 km");
  });

  it("keeps hidden profile values while fixing the local owner", () => {
    expect(profilePayload(profile)).toMatchObject({ ownerId: "local-user", displayName: "Athlete", constraints: ["quiet workouts"], excludedExercises: ["burpee"] });
    expect(timezoneOptions(profile.timezone)).toContain("Europe/London");
  });

  it("normalizes edited training days while preserving Agent-managed values", () => {
    const edited = { ...profile, trainingDays: [6, 0, 6], constraints: [], excludedExercises: [], explicitRecoveryHours: 48 };
    expect(profilePayload(profile, edited)).toMatchObject({ trainingDays: [0, 6], constraints: ["quiet workouts"], excludedExercises: ["burpee"], explicitRecoveryHours: null });
  });

  it("does not expose owner changes in Agent suggestions", () => {
    expect(proposalChanges(profile, { ownerId: "other", weeklyStrengthSessions: 4 })).toEqual([{ label: "Strength sessions per week", before: "2", after: "4" }]);
  });

  it("removes already approved drafts from the approval queue", () => {
    const draft = { draft: { id: "draft-1", title: "Plan", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const version = { id: "version-1", versionNumber: 1, plan: draft.draft, validation: draft.validation, approvedAt: "2026-09-03T10:00:00Z", changeReason: "Approved" } satisfies PlanVersion;
    expect(pendingPlanDrafts([draft], [version])).toEqual([]);
    expect(pendingPlanDrafts([draft], [])).toEqual([draft]);
    expect(isPlanDraftApproved(draft.draft.id, [version])).toBe(true);
    expect(primaryPlanDraft([draft], [version])).toBe(draft);
  });

  it("prefers the newest pending draft over an approved draft", () => {
    const approved = { draft: { id: "approved", title: "Approved", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const pending = { draft: { id: "pending", title: "Pending", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const version = { id: "version", versionNumber: 1, plan: approved.draft, validation: approved.validation, approvedAt: "2026-09-03T10:00:00Z", changeReason: "Approved" } satisfies PlanVersion;
    expect(primaryPlanDraft([approved, pending], [version])).toBe(pending);
  });
});
