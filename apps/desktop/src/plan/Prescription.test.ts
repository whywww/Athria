import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../i18n";
import type { SessionPrescription, PlanExercise, TemplateComponentDomain } from "../view-models";
import { Prescription } from "./Prescription";

type SessionFixture = { domain: TemplateComponentDomain; id: string; name: string; prescription: SessionPrescription };

const fact = <T,>(value: T) => ({ value, source: "test", confidence: 1, evidence: "", taxonomyVersion: "1" });
const render = (component: SessionFixture, variant: "detailed" | "compact" = "detailed") =>
  renderToStaticMarkup(createElement(Prescription, { prescription: component.prescription, name: component.name, sessionDomain: component.domain, variant }));

const exercise: PlanExercise = {
  id: "rdl", displayName: "Romanian Deadlift", canonicalKey: "romanian_deadlift",
  sets: 3, repsMin: 8, repsMax: 10, targetRpe: 7, restSeconds: 120,
  referenceLoad: 60, referenceLoadUnit: "kg", tempo: "3-1-1", alternatives: ["Good Morning"],
  notes: "Stop with two reps in reserve.",
  classification: {
    primaryMovement: fact("hinge"), primaryMuscles: fact(["hamstrings"]), secondaryMuscles: fact(["glutes"]),
    equipment: fact(["barbell"]), impact: fact("low"), laterality: fact("bilateral"),
  },
};

const strength: SessionFixture = { domain: "strength",
  id: "strength", name: "Strength main block",
  prescription: { blocks: [
    exercise,
    { ...exercise, id: "row", displayName: "Seated Row", targetRpe: null, referenceLoad: null, referenceLoadUnit: null, tempo: null, alternatives: [], notes: "", classification: { ...exercise.classification, primaryMovement: fact(null) } },
  ] },
};

const endurance: SessionFixture = { domain: "endurance",
  id: "endurance", name: "Aerobic Intervals",
  prescription: { blocks: [
    { type: "step", name: "Easy warm-up", role: "warm_up", durationSeconds: 600, distanceMeters: 1500, heartRateZone: "1-3", talkTest: "Full sentences" },
    { type: "repeat", name: "Controlled hard repeats", repetitions: 6, notes: "Stay smooth.",
      work: { type: "step", name: "Controlled hard running", role: "work", durationSeconds: 180, heartRateZone: "2", rpe: "7–8", pace: "5:00/km", powerWatts: "280 W", cadence: "175 spm", notes: "Do not sprint." },
      recovery: { type: "step", name: "Easy jog recovery", role: "recovery", durationSeconds: 120, heartRateZone: "1-3" } },
    { type: "step", name: "Easy cooldown", role: "cool_down", durationSeconds: 600 },
  ] },
};

const sport: SessionFixture = { domain: "sport_skill",
  id: "sport", name: "Ball control session",
  prescription: { sessionType: "practice", blocks: [
    { name: "Rondo 4v2", role: "technical", durationMinutes: 12, intensity: "Moderate", instructions: "Two-touch limit." },
    { name: "Small-sided games", role: "small_sided_game", durationMinutes: 20 },
  ] },
};

const recovery: SessionFixture = { domain: "mobility",
  id: "recovery", name: "Down-regulation",
  prescription: { blocks: [{ name: "Box breathing", durationMinutes: 6, instructions: "Nasal breathing only." }] },
};

describe("Prescription", () => {
  it.each(["en", "zh-CN"] as const)("formats endurance zones in both views in %s", (language) => {
    vi.stubGlobal("localStorage", { getItem: () => language });
    try {
      for (const variant of ["detailed", "compact"] as const) {
        const html = renderToStaticMarkup(createElement(LanguageProvider, null,
          createElement(Prescription, { prescription: endurance.prescription, name: endurance.name, sessionDomain: endurance.domain, variant })));
        expect(html.match(/Zone 1-3/g)).toHaveLength(2);
        expect(html.match(/Zone 2/g)).toHaveLength(1);
        expect(html).not.toContain("Zone Zone");
        expect(html).not.toContain("Zone undefined");
      }
    } finally {
      vi.stubGlobal("localStorage", { getItem: () => "en" });
      renderToStaticMarkup(createElement(LanguageProvider));
      vi.unstubAllGlobals();
    }
  });

  it.each([strength, endurance, sport, recovery])("renders $id blocks using the session domain", (component: SessionFixture) => {
    const html = renderToStaticMarkup(createElement(Prescription, { prescription: component.prescription, name: component.name, sessionDomain: component.domain, meta: "1 hr" }));
    expect(html).toContain(`class="rx-panel rx-panel-${component.domain}"`);
    expect(html).toContain(`data-domain-icon="${component.domain}"`);
    expect(html).toContain('class="rx-panel-meta">1 hr');
  });

  it.each([null, undefined])("does not infer a domain from endurance content when the session domain is %s", (sessionDomain: null | undefined) => {
    const html = renderToStaticMarkup(createElement(Prescription, { prescription: endurance.prescription, name: endurance.name, sessionDomain, meta: "1 hr" }));
    expect(html).not.toContain('class="rx-domain"');
    expect(html).not.toContain("data-domain-icon");
    expect(html).toContain('class="rx-panel-meta">1 hr');
  });

  it("renders the strength table with a rightmost notes column", () => {
    const html = render(strength);
    for (const value of ["Strength main block", "2 exercises", "Sets × Reps", "Effort", "Romanian Deadlift", "Hinge", "3 × 8–10", "60 kg", "RPE 7", "2 min", "Tempo 3-1-1", "Alternatives: Good Morning", "Controlled", "rx-notes-cell"]) expect(html).toContain(value);
    expect(html).not.toContain("rx-eyebrow");
    expect(html).toContain('role="columnheader">Notes</span>');
    expect(html).not.toContain("RIR");
  });

  it("renders endurance modules and nested work/recovery rows without losing targets", () => {
    const html = render(endurance);
    for (const value of ["Aerobic Intervals", "3 modules", "Module", "Effort", "Warm Up", "Easy warm-up", "1.5 km", "Zone 1-3", "Controlled hard repeats", "×6", "6 repetitions", "Controlled hard running", "rx-repeat-step-name", "RPE 7–8", "Pace 5:00/km", "Power 280 W", "Cadence 175 spm", "Easy jog recovery", "Do not sprint.", "Easy cooldown"]) expect(html).toContain(value);
    expect(html).not.toContain('role="columnheader">Zone</span>');
    expect(html).not.toContain("6 repeats");
  });

  it("renders a repeat module without inventing a recovery row", () => {
    const noRecovery: SessionFixture = { ...endurance, prescription: { blocks: [{ type: "repeat", name: "Tempo repeats", repetitions: 4, work: { type: "step", name: "Tempo running", role: "work", durationSeconds: 240 } }] } };
    const html = render(noRecovery);
    expect(html).toContain("1 module");
    expect(html).toContain("Tempo running");
    expect(html).not.toContain("Easy jog recovery");
  });

  it("renders sport skill blocks as a table with the session type in the header chip", () => {
    const html = render(sport);
    for (const value of ["rx-blocks-table", "rx-panel-chip", "Practice", "2 drills", ">Drill<", ">Duration<", ">Intensity<", ">Notes<", "Technical", "Rondo 4v2", "12 min", "Moderate", "Two-touch limit.", "Small Sided Game"]) expect(html).toContain(value);
    expect(html).not.toContain("rx-blocks-table-plain");
  });

  it("renders recovery blocks as a table without an intensity column or chip", () => {
    const html = render(recovery);
    for (const value of ["rx-blocks-table", "rx-blocks-table-plain", "1 movement", ">Movement<", ">Duration<", ">Notes<", "Box breathing", "6 min", "Nasal breathing only."]) expect(html).toContain(value);
    expect(html).not.toContain("Intensity");
    expect(html).not.toContain("rx-panel-chip");
  });

  it("keeps compact block rendering free of the table chrome", () => {
    const html = render(sport, "compact");
    expect(html).toContain("rx-blocks");
    expect(html).toContain("Practice");
    expect(html).toContain("Technical · Rondo 4v2");
    expect(html).not.toContain("rx-blocks-table");
  });

  it("keeps compact strength rendering free of detailed panel chrome", () => {
    const html = render(strength, "compact");
    expect(html).toContain("Strength main block");
    expect(html).toContain("Romanian Deadlift");
    expect(html).not.toContain("rx-panel");
    expect(html).not.toContain("Sets × Reps");
  });
});
