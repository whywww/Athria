import { describe, expect, it } from "vitest";
import {
  catalogExercise, customExercise,
  dashboardPages, formatDistance, formatDuration, isPlanDraftApproved, pendingPlanDrafts, primaryPlanDraft, profilePayload, proposalChanges,
  editableTemplate, referencedTemplates, resolveSelectedTemplate, templateComponent, templateEditorErrors, timezoneOptions,
  type AthleteProfile, type ExerciseDefinition, type Mesocycle, type PlanVersion, type SessionTemplate, type StoredDraft,
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
  const mesocycle = (days: Array<{ dayOfWeek: number; templateIds: string[] }>): Mesocycle => ({ durationWeeks: 4, schedule: { kind: "fixed_week", days: days.map((day) => ({ ...day, id: `day-${day.dayOfWeek}` })) }, phases: [], adjustmentRules: [] });

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

  const catalogDefinition: ExerciseDefinition = { key: "goblet_squat", name: "Goblet Squat", movement: "squat", primaryMuscles: ["quadriceps", "glutes"], secondaryMuscles: ["core"], equipment: ["dumbbell"], unilateral: false, tags: ["strength"] };

  it("builds a catalog exercise with compact editor defaults and trusted classification", () => {
    const exercise = catalogExercise(catalogDefinition, "exercise-1");
    expect(exercise).toMatchObject({ id: "exercise-1", canonicalKey: "goblet_squat", displayName: "Goblet Squat", sets: 3, repsMin: 8, repsMax: 12, targetRpe: null, restSeconds: 90 });
    expect(exercise.classification).toMatchObject({ primaryMovement: { value: "squat", source: "catalog" }, primaryMuscles: { value: ["quadriceps", "glutes"] }, equipment: { value: ["dumbbell"] }, laterality: { value: "bilateral" } });
  });

  it("builds user-confirmed custom exercises and validates their minimum classification", () => {
    const incomplete = customExercise(undefined, "custom-1");
    const strength = templateComponent("strength", "strength-1");
    if (strength.prescription.kind !== "strength") throw new Error("Expected strength component");
    const value: SessionTemplate = { id: "template-1", name: "Custom strength", intent: "Build strength", durationMinutes: 45, recoveryDemand: "normal", notes: "", components: [{ ...strength, prescription: { ...strength.prescription, exercises: [incomplete] } }] };
    expect(templateEditorErrors(value)).toEqual(expect.arrayContaining([expect.stringContaining("needs a name"), expect.stringContaining("movement pattern"), expect.stringContaining("primary muscle"), expect.stringContaining("equipment")]));

    const complete = customExercise({ name: "Cable reach", movement: "horizontal_pull", primaryMuscles: ["back"], equipment: ["cable"] }, "custom-2");
    value.components[0] = { ...strength, prescription: { ...strength.prescription, exercises: [complete] } };
    expect(templateEditorErrors(value)).toEqual([]);
    expect(complete.classification.primaryMovement).toMatchObject({ value: "horizontal_pull", source: "user_confirmed" });
  });

  it("creates every component type with the matching prescription", () => {
    expect(templateComponent("strength", "strength").prescription.kind).toBe("strength");
    for (const domain of ["endurance", "sport_skill", "mind_body", "recovery"] as const) {
      const component = templateComponent(domain, domain);
      expect(component).toMatchObject({ id: domain, name: expect.any(String), domain: { value: domain, source: "user_confirmed" }, prescription: { kind: "duration_only", notes: "" } });
    }
  });

  it("validates component content and exercise prescription bounds", () => {
    const exercise = { ...catalogExercise(catalogDefinition, "exercise"), sets: 0, repsMin: 12, repsMax: 8, targetRpe: 11, restSeconds: 601, referenceLoad: -1 };
    const strength = templateComponent("strength", "strength");
    if (strength.prescription.kind !== "strength") throw new Error("Expected strength component");
    const endurance = templateComponent("endurance", "endurance");
    const value: SessionTemplate = { id: "template", name: "Mixed", intent: "Train", durationMinutes: 45, recoveryDemand: "high", notes: "", components: [{ ...strength, prescription: { ...strength.prescription, exercises: [exercise] } }, endurance] };
    const errors = templateEditorErrors(value);
    expect(errors).toEqual(expect.arrayContaining([expect.stringContaining("sets"), expect.stringContaining("reps"), expect.stringContaining("RPE"), expect.stringContaining("rest"), expect.stringContaining("reference load"), expect.stringContaining("session instructions")]));
  });

  it("clones only persisted template fields without losing nested metadata", () => {
    const exercise = catalogExercise(catalogDefinition, "exercise");
    exercise.notes = "Keep this cue";
    const strength = templateComponent("strength", "strength");
    if (strength.prescription.kind !== "strength") throw new Error("Expected strength component");
    const source: SessionTemplate = { id: "template", name: "Full body", intent: "Strength", durationMinutes: 60, recoveryDemand: "high", notes: "Template note", components: [{ ...strength, prescription: { ...strength.prescription, exercises: [exercise] } }] };
    const cloned = editableTemplate(source);
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.components[0]).not.toBe(source.components[0]);
  });
});
