import { describe, expect, it } from "vitest";
import { PLAN_SCHEMA_VERSION, sessionTemplateSchema, mesocycleSchema, currentPlanSchema } from "./index";

const block = (role: string, key: string) => ({ id: role, name: role, role, required: true, variables: [{ key, required: true }] });
const templates = [
  { domain: "strength", structure: { kind: "strength", slots: [{ ...block("primary", "exercise_selection"), movementPatternIds: ["squat"], targetMuscleIds: ["quadriceps"], matchPolicy: "all" }] } },
  { domain: "endurance", structure: { kind: "endurance", blocks: [block("steady", "duration")] } },
  { domain: "sport_skill", structure: { kind: "sport_skill", blocks: [block("technical", "drill")] } },
  { domain: "recovery", structure: { kind: "recovery", blocks: [block("mobility", "movement")] } },
  { domain: "mind_body", structure: { kind: "mind_body", blocks: [block("centering", "technique")] } },
].map((item, index) => ({ id: `template-${index}`, name: `Template ${index}`, intent: "Stable archetype", commonUseCases: [], notes: "", ...item }));

describe("schema v7 template boundary", () => {
  it("accepts each single-domain generic template", () => {
    for (const template of templates) expect(sessionTemplateSchema.parse(template).domain).toBe(template.domain);
  });
  it("rejects concrete prescriptions, unknown taxonomy ids and invalid ranges", () => {
    expect(sessionTemplateSchema.safeParse({ ...templates[0], durationMinutes: 45 }).success).toBe(false);
    const strength = structuredClone(templates[0]) as any;
    strength.structure.slots[0].movementPatternIds = ["invented_pattern"];
    expect(sessionTemplateSchema.safeParse(strength).success).toBe(false);
    strength.structure.slots[0].movementPatternIds = ["squat"];
    strength.structure.slots[0].variables[0].identityConstraint = { min: 12, max: 5, unit: "reps" };
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
