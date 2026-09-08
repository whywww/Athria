import { describe, expect, it } from "vitest";
import {
  dashboardPages, formatDistance, formatDuration, isPlanDraftApproved, pendingPlanDrafts, primaryPlanDraft, profilePayload, proposalChanges,
  referencedTemplates, resolveSelectedTemplate, timezoneOptions, type AthleteProfile, type Mesocycle, type PlanVersion, type SessionTemplate, type StoredDraft,
} from "./view-models";

const profile: AthleteProfile = {
  ownerId: "unexpected-owner", displayName: "Athlete", timezone: "Europe/London", goals: ["general_fitness"], priority: "balanced",
  weeklyStrengthSessions: 2, weeklyEnduranceSessions: 2, maxSessionMinutes: 60, trainingDays: [], equipment: ["bodyweight"],
  strengthConstraints: [{ id: "exclude-burpee", type: "exclude_exercise", canonicalKey: "burpee" }], constraintNotes: ["quiet workouts"], explicitRecoveryHours: null,
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
    expect(profilePayload(profile)).toMatchObject({ ownerId: "local-user", displayName: "Athlete", constraintNotes: ["quiet workouts"], strengthConstraints: [{ canonicalKey: "burpee" }] });
    expect(timezoneOptions(profile.timezone)).toContain("Europe/London");
  });

  it("normalizes edited training days while preserving Agent-managed values", () => {
    const edited = { ...profile, trainingDays: [6, 0, 6], constraintNotes: [], strengthConstraints: [], explicitRecoveryHours: 48 };
    expect(profilePayload(profile, edited)).toMatchObject({ trainingDays: [0, 6], constraintNotes: ["quiet workouts"], strengthConstraints: [{ canonicalKey: "burpee" }], explicitRecoveryHours: null });
  });

  it("does not expose owner changes in Agent suggestions", () => {
    expect(proposalChanges(profile, { ownerId: "other", weeklyStrengthSessions: 4 })).toEqual([{ label: "Strength sessions per week", before: "2", after: "4" }]);
  });

  it("removes already approved drafts from the approval queue", () => {
    const draft = { draft: { planSchemaVersion: "3.0", id: "draft-1", title: "Plan", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const version = { id: "version-1", versionNumber: 1, plan: draft.draft, validation: draft.validation, approvedAt: "2026-09-03T10:00:00Z", changeReason: "Approved" } satisfies PlanVersion;
    expect(pendingPlanDrafts([draft], [version])).toEqual([]);
    expect(pendingPlanDrafts([draft], [])).toEqual([draft]);
    expect(isPlanDraftApproved(draft.draft.id, [version])).toBe(true);
    expect(primaryPlanDraft([draft], [version])).toBe(draft);
  });

  it("prefers the newest pending draft over an approved draft", () => {
    const approved = { draft: { planSchemaVersion: "3.0", id: "approved", title: "Approved", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const pending = { draft: { planSchemaVersion: "3.0", id: "pending", title: "Pending", summary: "", mesocycle: null }, validation: { valid: true, results: [], dataGaps: [] } } satisfies StoredDraft;
    const version = { id: "version", versionNumber: 1, plan: approved.draft, validation: approved.validation, approvedAt: "2026-09-03T10:00:00Z", changeReason: "Approved" } satisfies PlanVersion;
    expect(primaryPlanDraft([approved, pending], [version])).toBe(pending);
  });

  const template = (id: string, name = id): SessionTemplate => ({ id, name, intent: `${name} intent`, durationMinutes: 45, recoveryDemand: "normal", notes: "", components: [] });
  const mesocycle = (weeklyStructure: Array<{ dayOfWeek: number; templateIds: string[] }>): Mesocycle => ({ durationWeeks: 4, weeklyStructure, phases: [], adjustmentRules: [] });

  it("resolves referenced templates in weekly first-appearance order and de-duplicates across days", () => {
    const library = [template("a", "A"), template("b", "B"), template("c", "C")];
    const { templates, missingIds } = referencedTemplates(mesocycle([{ dayOfWeek: 2, templateIds: ["c"] }, { dayOfWeek: 0, templateIds: ["a", "b"] }, { dayOfWeek: 1, templateIds: ["a"] }]), library);
    expect(templates.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(missingIds).toEqual([]);
  });

  it("keeps valid templates and reports ids missing from the library", () => {
    const { templates, missingIds } = referencedTemplates(mesocycle([{ dayOfWeek: 0, templateIds: ["a", "ghost"] }]), [template("a", "A")]);
    expect(templates.map((item) => item.id)).toEqual(["a"]);
    expect(missingIds).toEqual(["ghost"]);
  });

  it("falls back to the first referenced template when the selection is no longer referenced", () => {
    const referenced = referencedTemplates(mesocycle([{ dayOfWeek: 0, templateIds: ["a", "b"] }]), [template("a", "A"), template("b", "B")]).templates;
    expect(resolveSelectedTemplate(referenced, "b")?.id).toBe("b");
    expect(resolveSelectedTemplate(referenced, "gone")?.id).toBe("a");
    expect(resolveSelectedTemplate([], "a")).toBeUndefined();
  });
});
