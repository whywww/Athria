import { createElement } from "react";
import { QueryClient } from "@tanstack/query-core";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n";
import { Timeline } from "./App";
import type { AthleteProfile, CalendarSession, TrainingHistorySession } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Hailey", gender: null, heightCm: null, birthDate: null, timezone: "UTC", goals: [], preference: "", usualSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, mesocycleDurationWeeks: 8, unitSystem: "metric", raceDays: [] };
const session: TrainingHistorySession = { id: "workout-1", name: "Morning Stretch", startAt: "2026-09-05T12:00:00Z", timezone: "UTC", domains: ["mind_body"], type: "Yoga", subtype: null, durationMinutes: 15, timePrecision: "date_only", sources: [{ source: "manual", externalId: "manual-1" }], plannedSessionId: "plan-1", planMatch: { plannedSessionId: "plan-1", method: "manual" }, isPlanMatchExcluded: true };
const unmatched: TrainingHistorySession = { ...session, id: "workout-2", name: "Easy Run", startAt: "2026-09-04T08:00:00Z", domains: ["endurance"], type: "Running", subtype: null, timePrecision: "exact", sources: [{ source: "intervals", externalId: "run-1" }], plannedSessionId: null, planMatch: null };
const mixed: TrainingHistorySession = { ...session, id: "workout-3", name: "Mixed source workout", sources: [{ source: "intervals", externalId: "synced-3" }, { source: "manual", externalId: "manual-3" }] };
const planned = [{ id: "plan-1", scheduledDate: "2026-09-05", name: "Daily Mobility - v2", status: "completed", domain: "mind_body", prescription: null, completedTrainingSessionId: "workout-1" }] as unknown as CalendarSession[];

function renderTimeline(rpe: number | null = null) {
  const client = new QueryClient();
  client.setQueryData(["sessions"], [{ ...session, rpe }, unmatched, mixed]);
  client.setQueryData(["calendar", "timeline"], planned);
  client.setQueryData(["current-plan"], null);
  client.setQueryData(["profile"], profile);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(LanguageProvider, null, createElement(Timeline))));
}

describe("Training history", () => {
  it.each([1, 7, 10])("shows session RPE %s in the Effort column", (rpe) => {
    const html = renderTimeline(rpe);
    expect(html).toContain(`>${rpe}</button>`);
    expect(html).not.toContain(`RPE ${rpe}`);
    expect(html).toContain('<span>Duration</span><span class="training-effort-heading">Effort<small>(1-10)</small></span><span>Source</span>');
    expect(html).toMatch(/class="training-duration-cell"[\s\S]*?<\/div><div class="training-effort-cell">/);
    expect(html).toContain('type="range" min="1" max="10" step="1"');
  });
  it("shows a dash for null or omitted RPE values", () => {
    expect(renderTimeline().match(/>-<\/button>/g)).toHaveLength(3);
  });
  it("translates Effort and keeps the range on a second line", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    try {
      expect(renderTimeline(7)).toContain('<span class="training-effort-heading">强度<small>(1-10)</small></span>');
    } finally { vi.unstubAllGlobals(); renderTimeline(); }
  });
  it("renders inline plan-match icons beside workout names and exposes matching and deletion through every row menu", () => {
    const html = renderTimeline();
    expect(html).toContain("Training History");
    expect(html).toContain("Search workouts...");
    expect(html).toContain("Date &amp; time");
    expect(html).not.toContain("Plan Matched");
    expect(html).not.toContain("Matched to Plan");
    expect(html).toContain("Morning Stretch");
    expect(html).toContain("Mind-body");
    expect(html).not.toContain("Time not recorded");
    expect(html).not.toContain("No confident match");
    expect(html).not.toContain("No planned session");
    expect(html.match(/class="training-plan-match"/g)).toHaveLength(2);
    expect(html.match(/title="Matched to a training plan"/g)).toHaveLength(2);
    expect(html).not.toContain("is not matched to a planned session");
    expect(html).toContain(">-</option>");
    expect(html).not.toContain('value="" disabled');
    expect(html).not.toContain("Allow automatic matching");
    expect(html).not.toContain('aria-label="Change type for Morning Stretch"');
    expect(html).toContain('class="training-type-badge mind_body">Mind-body</span>');
    expect(html).not.toContain("training-type-options");
    expect(html).toContain("Manual");
    expect(html.match(/<div class="training-source-cell"><span>Manual<\/span><\/div>/g)).toHaveLength(1);
    expect(html.match(/<div class="training-source-cell"><span>Intervals\.icu<\/span><\/div>/g)).toHaveLength(2);
    expect(html).not.toContain("Manual · Intervals.icu");
    expect(html).toContain("Daily Mobility - v2");
    expect(html).toContain("Edit manual details");
    expect(html).not.toContain("Remove manual source");
    expect(html.match(/Delete record/g)).toHaveLength(3);
    expect(html.match(/class="training-row-menu"/g)).toHaveLength(3);
    expect(html).not.toContain("training-row-menu-disabled");
    expect(html).not.toContain("training-row-editor");
    expect(html).toContain("Showing 1–3 of 3 sessions");
  });
  it("renders the unified empty state when no workouts exist", () => {
    const client = new QueryClient();
    client.setQueryData(["sessions"], []);
    client.setQueryData(["calendar", "timeline"], []);
    client.setQueryData(["current-plan"], null);
    client.setQueryData(["profile"], profile);
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(LanguageProvider, null, createElement(Timeline))));
    expect(html).toContain('<div class="empty-state"><strong>No workouts imported yet.</strong></div>');
    expect(html).not.toContain("No workouts match your search.");
  });
});
