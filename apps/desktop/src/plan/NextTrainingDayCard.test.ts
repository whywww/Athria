import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NextTrainingDay, PlanExercise } from "../view-models";
import { NextTrainingDayCard } from "./CurrentPlanPage";

const squat: PlanExercise = {
  id: "exercise-1",
  displayName: "Back Squat",
  canonicalKey: null,
  sets: 4,
  repsMin: 5,
  repsMax: 5,
  targetRpe: 7,
  restSeconds: 120,
  referenceLoad: null,
  referenceLoadUnit: null,
  notes: "",
  classification: {
    primaryMovement: { value: "squat", source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
    primaryMuscles: { value: ["quadriceps"], source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
    secondaryMuscles: { value: [], source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
    equipment: { value: ["barbell"], source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
    impact: { value: null, source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
    laterality: { value: null, source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
  },
};

const strengthDay: NextTrainingDay = { reasonCode: null, nextTrainingDay: {
  occurrenceId: "occ-1", scheduledDate: "2026-09-24", dayOfWeek: 3, weekNumber: 2, domainPhases: [], revision: 1, timezone: "UTC",
  existingSessions: [{
    id: "session-1", occurrenceId: "occ-1", weekNumber: 2, name: "Lower Strength A", intent: "Maintain squat strength.",
    scheduledDate: "2026-09-24", order: 0, durationMinutes: 45, templateRef: null, phaseRefs: [], recoveryDemand: "normal",
    keySession: false, status: "planned", notes: "", legacySnapshot: false, overrideReason: null,
    components: [{
      id: "component-1", name: "Main lifts",
      domain: { value: "strength", source: "agent", confidence: 0.9, evidence: "", taxonomyVersion: "1" },
      prescription: { kind: "strength", exercises: [squat] },
    }],
  }],
} };

const emptyDay: NextTrainingDay = { reasonCode: null, nextTrainingDay: {
  ...strengthDay.nextTrainingDay!,
  existingSessions: [{ ...strengthDay.nextTrainingDay!.existingSessions[0]!, id: "session-2", name: "Recovery walk", components: [] }],
} };

function render(value: NextTrainingDay) {
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(NextTrainingDayCard, { value })));
}

describe("NextTrainingDayCard", () => {
  it("renders the full prescription inline instead of an open-details drawer", () => {
    const html = render(strengthDay);
    expect(html).toContain("Main lifts");
    expect(html).toContain("Strength");
    expect(html).toContain("Back Squat");
    expect(html).toContain("4 × 5");
    expect(html).toContain("Complete");
    expect(html).not.toContain("Open details");
  });

  it("keeps an explicit empty state when a session has no structured components", () => {
    const html = render(emptyDay);
    expect(html).toContain("No structured prescription is available for this session.");
    expect(html).not.toContain("Open details");
  });
});
