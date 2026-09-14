import { describe, expect, it } from "vitest";
import { connectionSources, connectionStatusPresentation, dashboardPages, editableTemplate, equipmentGroupState, filterAndSortTrainingHistory, formatDistance, formatDuration, formatTimezoneLabel, formatTrainingSource, paginateTrainingHistory, parseSyncRange, profilePayload, referencedTemplates, syncRangeOptions, templateEditorErrors, templateNodeName, toggleEquipmentGroup, PREFERENCE_MAX_LENGTH, type AthleteProfile, type Mesocycle, type SessionTemplate, type StoredSessionTemplate, type TrainingHistorySession } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Athlete", gender: null, heightCm: null, birthDate: null, timezone: "Asia/Hong_Kong", goals: ["general_fitness"], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: ["dumbbell"], injuries: [], constraintNotes: [], explicitRecoveryDays: null };

const template: SessionTemplate = { id: "lower", name: "Lower", intent: "Lower-body pattern", domain: "strength", nodes: [{ name: "Squat pattern", role: "primary", movementPatternIds: ["squat"], targetMuscleIds: ["quadriceps"], matchPolicy: "all", variables: ["exercise_selection"] }] };
const history = [
  { id: "new", name: "Evening Yoga Flow", startAt: "2026-09-10T12:00:00Z", domains: ["mind_body"], sport: "Yoga", source: "xunji", sources: [{ source: "xunji", externalId: "2" }], planMatch: { plannedSessionId: "yoga-plan", method: "manual" as const } },
  { id: "old", name: "Easy Run", startAt: "2026-09-06T23:00:00Z", domains: ["endurance"], sport: "Running", source: "intervals", sources: [{ source: "intervals", externalId: "1" }], planMatch: null },
].map((item) => ({ timezone: null, durationMinutes: 30, timePrecision: "exact" as const, plannedSessionId: item.planMatch?.plannedSessionId ?? null, isPlanMatchExcluded: false, ...item })) satisfies TrainingHistorySession[];

describe("dashboard v7 view models", () => {
  it("separates added sources from sources available to add", () => {
    expect(connectionSources(false, false, false)).toEqual({ added: [], available: ["intervals", "xunji", "hevy"] });
    expect(connectionSources(true, false, false)).toEqual({ added: ["intervals"], available: ["xunji", "hevy"] });
    expect(connectionSources(false, true, true)).toEqual({ added: ["xunji", "hevy"], available: ["intervals"] });
    expect(connectionSources(true, true, true)).toEqual({ added: ["intervals", "xunji", "hevy"], available: [] });
    expect(dashboardPages.some((page) => page.id === "Connections" && page.label === "Connections")).toBe(true);
    expect(connectionStatusPresentation("success")).toEqual({ tone: "connected", label: "Connected" });
    expect(connectionStatusPresentation("partial")).toEqual({ tone: "partial", label: "Partially synced" });
    expect(connectionStatusPresentation("failed")).toEqual({ tone: "failed", label: "Sync failed" });
  });

  it("toggles equipment groups without changing other selections", () => {
    expect(equipmentGroupState(["dumbbell", "treadmill"], ["dumbbell", "barbell"])).toBe("some");
    expect(toggleEquipmentGroup(["dumbbell", "treadmill"], ["dumbbell", "barbell"])).toEqual(["dumbbell", "treadmill", "barbell"]);
    expect(toggleEquipmentGroup(["dumbbell", "barbell", "treadmill"], ["dumbbell", "barbell"])).toEqual(["treadmill"]);
  });
  it("keeps navigation and formatting stable", () => {
    expect(dashboardPages.map((page) => page.id)).toContain("Plan");
    expect(formatDuration(135)).toBe("2 hr 15 min");
    expect(formatDistance(5250)).toBe("5.3 km");
  });
  it("formats known training sources and preserves unknown sources", () => {
    expect(formatTrainingSource("xunji")).toBe("训记");
    expect(formatTrainingSource("intervals")).toBe("Intervals.icu");
    expect(formatTrainingSource("custom-device")).toBe("custom-device");
  });
  it("filters training history across workout metadata and planned names", () => {
    const plans = { "yoga-plan": "Daily Mobility" };
    expect(filterAndSortTrainingHistory(history, "YOGA", "newest", plans).map((item) => item.id)).toEqual(["new"]);
    expect(filterAndSortTrainingHistory(history, "mind-body", "newest", plans).map((item) => item.id)).toEqual(["new"]);
    expect(filterAndSortTrainingHistory(history, "Intervals.icu", "newest", plans).map((item) => item.id)).toEqual(["old"]);
    expect(filterAndSortTrainingHistory(history, "daily mobility", "newest", plans).map((item) => item.id)).toEqual(["new"]);
    expect(filterAndSortTrainingHistory(history, "missing", "newest", plans)).toEqual([]);
  });
  it("sorts and paginates training history with clamped boundaries", () => {
    expect(filterAndSortTrainingHistory(history, "", "oldest").map((item) => item.id)).toEqual(["old", "new"]);
    const items = Array.from({ length: 41 }, (_, index) => index + 1);
    expect(paginateTrainingHistory(items, 2)).toMatchObject({ items: Array.from({ length: 20 }, (_, index) => index + 21), page: 2, totalPages: 3, start: 21, end: 40 });
    expect(paginateTrainingHistory(items, 99)).toMatchObject({ items: [41], page: 3, start: 41, end: 41 });
    expect(paginateTrainingHistory([], 2)).toMatchObject({ items: [], page: 1, totalPages: 1, start: 0, end: 0 });
  });
  it("exposes the supported device sync ranges", () => {
    expect(syncRangeOptions.map((option) => option.value)).toEqual(["incremental", 1, 10, 30, 90]);
    expect(parseSyncRange("incremental")).toBe("incremental");
    expect(parseSyncRange("30")).toBe(30);
  });
  it("validates and deeply clones generic templates", () => {
    expect(templateEditorErrors(template)).toEqual([]);
    const copy = editableTemplate(template);
    expect(copy).toEqual(template);
    expect(copy).not.toBe(template);
    expect(copy.nodes).not.toBe(template.nodes);
    expect(templateNodeName({ role: "warm_up", variables: ["duration"] })).toBe("Warm Up");
  });
  it("resolves provenance references from weekly sessions", () => {
    const stored = { ...template, origin: "user", revision: 2 } satisfies StoredSessionTemplate;
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
});
