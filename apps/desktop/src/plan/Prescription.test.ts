import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlanComponent, PlanExercise } from "../view-models";
import { Prescription } from "./Prescription";

const fact = <T,>(value: T) => ({ value, source: "test", confidence: 1, evidence: "", taxonomyVersion: "1" });
const render = (component: PlanComponent, variant: "detailed" | "compact" = "detailed") =>
  renderToStaticMarkup(createElement(Prescription, { component, variant }));

const exercise: PlanExercise = {
  id: "rdl", displayName: "Romanian Deadlift", canonicalKey: "romanian_deadlift",
  sets: 3, repsMin: 8, repsMax: 10, targetRpe: 7, targetRir: 2, restSeconds: 120,
  referenceLoad: 60, referenceLoadUnit: "kg", tempo: "3-1-1", alternatives: ["Good Morning"],
  notes: "Stop with two reps in reserve.",
  classification: {
    primaryMovement: fact("hinge"), primaryMuscles: fact(["hamstrings"]), secondaryMuscles: fact(["glutes"]),
    equipment: fact(["barbell"]), impact: fact("low"), laterality: fact("bilateral"),
  },
};

const strength: PlanComponent = {
  id: "strength", name: "Strength main block", domain: fact("strength"),
  prescription: { kind: "strength", exercises: [
    exercise,
    { ...exercise, id: "row", displayName: "Seated Row", targetRpe: null, targetRir: null, referenceLoad: null, referenceLoadUnit: null, tempo: null, alternatives: [], notes: "", classification: { ...exercise.classification, primaryMovement: fact(null) } },
  ] },
};

const endurance: PlanComponent = {
  id: "endurance", name: "Aerobic Intervals", domain: fact("endurance"),
  prescription: { kind: "endurance", segments: [
    { type: "step", name: "Easy warm-up", role: "warm_up", durationSeconds: 600, distanceMeters: 1500, heartRateZone: "Zone 1–2", talkTest: "Full sentences" },
    { type: "repeat", name: "Controlled hard repeats", repetitions: 6, notes: "Stay smooth.",
      work: { type: "step", name: "Controlled hard running", role: "work", durationSeconds: 180, rpe: "7–8", pace: "5:00/km", powerWatts: "280 W", cadence: "175 spm", notes: "Do not sprint." },
      recovery: { type: "step", name: "Easy jog recovery", role: "recovery", durationSeconds: 120, heartRateZone: "Zone 1–2" } },
    { type: "step", name: "Easy cooldown", role: "cool_down", durationSeconds: 600 },
  ] },
};

describe("Prescription", () => {
  it("renders the Apple-style strength table with layered exercise details", () => {
    const html = render(strength);
    for (const value of ["Prescription", "Strength main block", "2 exercises", 'data-domain-icon="strength"', "Sets × Reps", "Effort", "Romanian Deadlift", "rx-movement-pill", "Hinge", "3 × 8–10", "60 kg", "RPE 7", "RIR 2", "2 min", "Tempo 3-1-1", "Alternatives: Good Morning", "Controlled", "rx-strength-details"]) expect(html).toContain(value);
    expect(html).not.toContain('role="columnheader">Notes');
  });

  it("keeps the unified Effort header when no exercise prescribes RIR", () => {
    const rpeOnly: PlanComponent = { ...strength, prescription: { kind: "strength", exercises: [{ ...exercise, targetRir: null }] } };
    const html = render(rpeOnly);
    expect(html).toContain("1 exercise");
    expect(html).toContain('role="columnheader">Effort</span>');
    expect(html).not.toContain('role="columnheader">RPE</span>');
  });

  it("renders endurance modules and nested work/recovery rows without losing targets", () => {
    const html = render(endurance);
    for (const value of ["Aerobic Intervals", "3 modules", "Module", "Effort", "Warm Up", "Easy warm-up", "1.5 km", "Zone 1–2", "Controlled hard repeats", "×6", "6 repetitions", "Controlled hard running", "rx-repeat-step-name", "RPE 7–8", "Pace 5:00/km", "Power 280 W", "Cadence 175 spm", "Easy jog recovery", "Do not sprint.", "Easy cooldown"]) expect(html).toContain(value);
    expect(html).not.toContain('role="columnheader">Zone</span>');
    expect(html).not.toContain("6 repeats");
  });

  it("renders a repeat module without inventing a recovery row", () => {
    const noRecovery: PlanComponent = { ...endurance, prescription: { kind: "endurance", segments: [{ type: "repeat", name: "Tempo repeats", repetitions: 4, work: { type: "step", name: "Tempo running", role: "work", durationSeconds: 240 } }] } };
    const html = render(noRecovery);
    expect(html).toContain("1 module");
    expect(html).toContain("Tempo running");
    expect(html).not.toContain("Easy jog recovery");
  });

  it("keeps compact strength rendering free of detailed panel chrome", () => {
    const html = render(strength, "compact");
    expect(html).toContain("Strength main block");
    expect(html).toContain("Romanian Deadlift");
    expect(html).not.toContain("rx-panel");
    expect(html).not.toContain("Sets × Reps");
  });
});
