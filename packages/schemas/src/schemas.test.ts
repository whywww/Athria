import { describe, expect, it } from "vitest";
import { PLAN_SCHEMA_VERSION, athleteProfileSchema, defaultProfile, equipmentCategories, equipmentTypeIds, equipmentTypeSchema, sessionTemplateSchema, mesocycleSchema, currentPlanSchema, planTargetSchema } from "./index";

const node = (role: string, key: string) => ({ role, variables: [key] });
const templates = [
  { domain: "strength", nodes: [{ ...node("primary", "exercise_selection"), movementPatternIds: ["squat"], targetMuscleIds: ["quadriceps"], matchPolicy: "all" }] },
  { domain: "endurance", nodes: [node("steady", "duration")] },
  { domain: "sport_skill", nodes: [node("technical", "drill")] },
  { domain: "recovery", nodes: [node("mobility", "movement")] },
  { domain: "mind_body", nodes: [node("centering", "technique")] },
].map((item, index) => ({ id: `template-${index}`, name: `Template ${index}`, intent: "Stable archetype", ...item }));

describe("equipment catalog", () => {
  it("exposes the exact 30-item catalog and selects it by default", () => {
    const catalogIds = equipmentCategories.flatMap((category) => category.groups.flatMap((group) => group.items.map((item) => item.id)));
    expect(catalogIds).toEqual(equipmentTypeIds);
    expect(catalogIds).toHaveLength(30);
    expect(defaultProfile().equipment).toEqual(equipmentTypeIds);
    for (const id of catalogIds) expect(equipmentTypeSchema.safeParse(id).success).toBe(true);
    for (const id of ["bodyweight", "rings", "trap_bar", "ez_bar", "other", "band", "suspension"]) expect(equipmentTypeSchema.safeParse(id).success).toBe(false);
  });
});

describe("schema v7 template boundary", () => {
  it("accepts each single-domain generic template", () => {
    for (const template of templates) expect(sessionTemplateSchema.parse(template).domain).toBe(template.domain);
  });
  it("accepts optional nodes and names while rejecting obsolete or duplicate fields", () => {
    expect(sessionTemplateSchema.safeParse({ ...templates[1], nodes: [{ role: "steady", optional: true, variables: [], optionalVariables: ["duration"] }] }).success).toBe(true);
    expect(sessionTemplateSchema.safeParse({ ...templates[1], nodes: [{ role: "steady", variables: ["duration"], optionalVariables: ["duration"] }] }).success).toBe(false);
    expect(sessionTemplateSchema.safeParse({ ...templates[1], commonUseCases: [] }).success).toBe(false);
    expect(sessionTemplateSchema.safeParse({ ...templates[1], notes: "legacy" }).success).toBe(false);
    expect(sessionTemplateSchema.safeParse({ ...templates[1], structure: { kind: "endurance", blocks: [] } }).success).toBe(false);
  });
  it("rejects concrete prescriptions and unknown taxonomy ids", () => {
    expect(sessionTemplateSchema.safeParse({ ...templates[0], durationMinutes: 45 }).success).toBe(false);
    const strength = structuredClone(templates[0]) as any;
    strength.nodes[0].movementPatternIds = ["invented_pattern"];
    expect(sessionTemplateSchema.safeParse(strength).success).toBe(false);
    strength.nodes[0].movementPatternIds = ["squat"];
    strength.nodes[0].identityConstraint = { min: 2, max: 4, unit: "rpe" };
    expect(sessionTemplateSchema.safeParse(strength).success).toBe(false);
  });
  it("requires complete weeks and rhythm-only schedules", () => {
    const base = { durationWeeks: 2, schedule: { kind: "fixed_week", days: [0, 3] }, domainProgressions: [], weeks: [], adjustmentRules: [] };
    expect(mesocycleSchema.safeParse(base).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...base, weeks: [{ weekNumber: 1, focus: null, sessions: [] }, { weekNumber: 2, focus: null, sessions: [] }] }).success).toBe(true);
    expect(mesocycleSchema.shape.schedule.safeParse({ kind: "interval", intervalDays: 2, templateIds: ["x"] }).success).toBe(false);
  });
  it("requires Schema 7 current plans", () => {
    const mesocycle = { durationWeeks: 1, schedule: { kind: "interval", intervalDays: 2 }, domainProgressions: [], weeks: [{ weekNumber: 1, focus: null, sessions: [] }], adjustmentRules: [] };
    const plan = { planSchemaVersion: PLAN_SCHEMA_VERSION, ownerId: "local-user", title: "Plan", summary: "", effectiveStartDate: "2026-09-01", mesocycle, revision: 1, sourceAgent: null, model: null, skillVersion: null, inputSnapshotHash: null, updatedAt: "2026-09-01T00:00:00Z" };
    expect(currentPlanSchema.parse(plan).planSchemaVersion).toBe("7.0");
  });
  it("requires one complete progression timeline for every resolved session domain", () => {
    const fact = (value: "recovery" | "mind_body") => ({ value, source: "user_confirmed", confidence: 1, evidence: "fixture", taxonomyVersion: "strength-2.0" });
    const component = (domain: "recovery" | "mind_body") => ({ id: domain, name: domain, domain: fact(domain), prescription: { kind: domain, blocks: [{ name: domain, durationMinutes: 10 }] } });
    const session = { id: "combined", scheduledDate: "2026-09-01", order: 0, templateRef: null, name: "Combined", intent: "Train two domains", durationMinutes: 60, recoveryDemand: "normal", keySession: false, components: [component("recovery"), component("mind_body")], progressionNote: null, schedulingRationale: null, legacySnapshot: false };
    const phase = (id: string, startWeek: number, endWeek: number) => ({ id, phaseType: "foundation", name: id, startWeek, endWeek, focus: id, progression: [] });
    const base = { durationWeeks: 2, schedule: { kind: "fixed_week", days: [1] }, weeks: [{ weekNumber: 1, focus: null, sessions: [session] }, { weekNumber: 2, focus: null, sessions: [{ ...session, id: "combined-2", scheduledDate: "2026-09-08" }] }], adjustmentRules: [] };
    const valid = { ...base, domainProgressions: [{ domain: "recovery", phases: [phase("recovery-base", 1, 2)] }, { domain: "mind_body", phases: [phase("mind-body-base", 1, 1), phase("mind-body-build", 2, 2)] }] };
    expect(mesocycleSchema.safeParse(valid).success).toBe(true);
    expect(mesocycleSchema.safeParse({ ...valid, domainProgressions: valid.domainProgressions.slice(0, 1) }).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...valid, domainProgressions: [valid.domainProgressions[0], valid.domainProgressions[0], valid.domainProgressions[1]] }).success).toBe(false);
    expect(mesocycleSchema.safeParse({ ...valid, domainProgressions: [{ domain: "recovery", phases: [phase("one", 1, 1)] }, valid.domainProgressions[1]] }).success).toBe(false);
  });
});

describe("profile note boundaries", () => {
  it("validates Personal Information fields on Profile", () => {
    expect(athleteProfileSchema.parse({ preferredName: "Taylor", gender: "female", heightCm: 172.5, birthDate: "1995-04-03" })).toMatchObject({ preferredName: "Taylor", gender: "female", heightCm: 172.5, birthDate: "1995-04-03" });
    expect(athleteProfileSchema.safeParse({ preferredName: "" }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ gender: "self_described" }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ heightCm: 49 }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ birthDate: "2999-01-01" }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ displayName: "Legacy" }).success).toBe(false);
  });
  it("rejects the removed strengthConstraints field and the hour-based recovery field", () => {
    expect(athleteProfileSchema.safeParse({ strengthConstraints: [{ type: "exclude_exercise", canonicalKey: "burpee" }] }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ explicitRecoveryHours: 48 }).success).toBe(false);
    expect(athleteProfileSchema.parse({}).injuries).toEqual([]);
  });
  it("bounds explicitRecoveryDays to whole days from 1 to 7 and defaults to null", () => {
    expect(athleteProfileSchema.parse({}).explicitRecoveryDays).toBeNull();
    for (const days of [1, 7]) expect(athleteProfileSchema.parse({ explicitRecoveryDays: days }).explicitRecoveryDays).toBe(days);
    for (const days of [0, 8, 2.5]) expect(athleteProfileSchema.safeParse({ explicitRecoveryDays: days }).success).toBe(false);
  });
  it("bounds mesocycleDurationWeeks to whole weeks from 1 to 8 and defaults to 8", () => {
    expect(athleteProfileSchema.parse({}).mesocycleDurationWeeks).toBe(8);
    for (const weeks of [1, 8]) expect(athleteProfileSchema.parse({ mesocycleDurationWeeks: weeks }).mesocycleDurationWeeks).toBe(weeks);
    for (const weeks of [0, 9, 4.5]) expect(athleteProfileSchema.safeParse({ mesocycleDurationWeeks: weeks }).success).toBe(false);
  });
  it("defaults raceDays to an empty list and validates date and sport entries", () => {
    expect(athleteProfileSchema.parse({}).raceDays).toEqual([]);
    expect(athleteProfileSchema.safeParse({ raceDays: [{ date: "bad", sport: "Marathon" }] }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ raceDays: [{ date: "2027-01-01", sport: "" }] }).success).toBe(false);
    expect(athleteProfileSchema.safeParse({ raceDays: [{ date: "2027-01-01", sport: "y".repeat(81) }] }).success).toBe(false);
    expect(athleteProfileSchema.parse({ raceDays: [{ date: "2027-01-01", sport: "Marathon" }] }).raceDays).toEqual([{ date: "2027-01-01", sport: "Marathon" }]);
    const capped = Array.from({ length: 50 }, (_, index) => ({ date: "2027-01-01", sport: `Race ${index}` }));
    expect(athleteProfileSchema.safeParse({ raceDays: capped }).success).toBe(true);
    expect(athleteProfileSchema.safeParse({ raceDays: [...capped, { date: "2027-01-02", sport: "One more" }] }).success).toBe(false);
  });
  it("caps injuries and constraintNotes and rejects normalized duplicates", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `Note ${index}`);
    for (const field of ["injuries", "constraintNotes"] as const) {
      expect(athleteProfileSchema.safeParse({ [field]: ten }).success).toBe(true);
      expect(athleteProfileSchema.safeParse({ [field]: [...ten, "One more"] }).success).toBe(false);
      expect(athleteProfileSchema.safeParse({ [field]: ["y".repeat(200)] }).success).toBe(true);
      expect(athleteProfileSchema.safeParse({ [field]: ["y".repeat(201)] }).success).toBe(false);
      expect(athleteProfileSchema.safeParse({ [field]: ["Left shoulder surgery", " left  shoulder SURGERY "] }).success).toBe(false);
      expect(athleteProfileSchema.safeParse({ [field]: ["  "] }).success).toBe(false);
    }
  });
});

describe("plan target boundary", () => {
  it("rejects the removed plan constraints field", () => {
    expect(planTargetSchema.safeParse({}).success).toBe(true);
    expect(planTargetSchema.safeParse({ constraints: ["Max 5 training days per week"] }).success).toBe(false);
  });
});
