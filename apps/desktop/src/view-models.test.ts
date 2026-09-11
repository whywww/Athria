import { describe, expect, it } from "vitest";
import { dashboardPages, editableTemplate, formatDistance, formatDuration, formatTimezoneLabel, profilePayload, proposalChanges, referencedTemplates, templateEditorErrors, PREFERENCE_MAX_LENGTH, type AthleteProfile, type Mesocycle, type SessionTemplate, type StoredSessionTemplate } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", displayName: "Athlete", timezone: "Asia/Hong_Kong", goals: ["general_fitness"], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: ["bodyweight"], strengthConstraints: [], constraintNotes: [], explicitRecoveryHours: null };

const template: SessionTemplate = { id: "lower", name: "Lower", intent: "Lower-body pattern", domain: "strength", commonUseCases: [], notes: "", structure: { kind: "strength", slots: [{ id: "squat", name: "Squat pattern", role: "primary", required: true, movementPatternIds: ["squat"], targetMuscleIds: ["quadriceps"], matchPolicy: "all", variables: [{ key: "exercise_selection", required: true }] }] } };

describe("dashboard v7 view models", () => {
  it("keeps navigation and formatting stable", () => {
    expect(dashboardPages.map((page) => page.id)).toContain("Plan");
    expect(formatDuration(135)).toBe("2 hr 15 min");
    expect(formatDistance(5250)).toBe("5.3 km");
  });
  it("validates and deeply clones generic templates", () => {
    expect(templateEditorErrors(template)).toEqual([]);
    const copy = editableTemplate(template);
    expect(copy).toEqual(template);
    expect(copy).not.toBe(template);
    expect(copy.structure).not.toBe(template.structure);
  });
  it("resolves provenance references from weekly sessions", () => {
    const stored = { ...template, origin: "user", ownerId: "local-user", revision: 2, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z" } satisfies StoredSessionTemplate;
    const mesocycle: Mesocycle = { durationWeeks: 1, schedule: { kind: "fixed_week", days: [0] }, domainProgressions: [], weeks: [{ weekNumber: 1, focus: null, sessions: [{ id: "s", scheduledDate: "2026-09-07", order: 0, templateRef: { source: "user", id: "lower", revision: 2 }, name: "Session", intent: "Train", durationMinutes: 45, recoveryDemand: "normal", keySession: false, components: [], progressionNote: null, schedulingRationale: null, legacySnapshot: false }] }], adjustmentRules: [] };
    expect(referencedTemplates(mesocycle, [stored])).toMatchObject({ templates: [{ id: "lower" }], missingIds: [] });
  });
  it("formats the timezone label as city plus zero-padded GMT offset", () => {
    const runtimeOffset = new Intl.DateTimeFormat("en", { timeZone: "Asia/Hong_Kong", timeZoneName: "longOffset" }).formatToParts().find((part) => part.type === "timeZoneName")?.value ?? "GMT+08:00";
    const normalized = runtimeOffset.replace(/GMT([+-])(\d{1,2})(?::(\d{2}))?$/, (_all, sign: string, hour: string, minute?: string) => `GMT${sign}${hour.padStart(2, "0")}:${minute ?? "00"}`);
    expect(formatTimezoneLabel("Asia/Hong_Kong")).toBe(`Hong Kong (${normalized})`);
  });
  it("truncates an over-length preference when building the profile payload", () => {
    const long = "a".repeat(PREFERENCE_MAX_LENGTH + 30);
    expect(profilePayload(profile, { ...profile, preference: long }).preference).toHaveLength(PREFERENCE_MAX_LENGTH);
  });
  it("renders the Preferences label for a preference patch", () => {
    const changes = proposalChanges(profile, { preference: "Low-impact mornings" });
    expect(changes.map((change) => change.label)).toContain("Preferences");
    expect(changes[0]).toMatchObject({ label: "Preferences", before: "Not set" });
  });
});
