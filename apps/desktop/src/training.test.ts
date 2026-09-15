import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Timeline } from "./App";
import type { AthleteProfile, CalendarSession, TrainingHistorySession } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Hailey", gender: null, heightCm: null, birthDate: null, timezone: "UTC", goals: [], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, unitSystem: "metric" };
const session: TrainingHistorySession = { id: "workout-1", name: "Morning Stretch", startAt: "2026-09-05T12:00:00Z", timezone: "UTC", domains: ["mind_body"], sport: "Yoga", durationMinutes: 15, source: "manual", timePrecision: "date_only", sources: [{ source: "manual", externalId: "manual-1" }], plannedSessionId: "plan-1", planMatch: { plannedSessionId: "plan-1", method: "manual" }, isPlanMatchExcluded: false };
const unmatched: TrainingHistorySession = { ...session, id: "workout-2", name: "Easy Run", startAt: "2026-09-04T08:00:00Z", domains: ["endurance"], sport: "Running", source: "intervals", timePrecision: "exact", sources: [{ source: "intervals", externalId: "run-1" }], plannedSessionId: null, planMatch: null };
const mixed: TrainingHistorySession = { ...session, id: "workout-3", name: "Mixed source workout", source: "intervals", sources: [{ source: "manual", externalId: "manual-3" }, { source: "intervals", externalId: "synced-3" }] };
const planned = [{ id: "plan-1", scheduledDate: "2026-09-05", name: "Daily Mobility - v2", status: "completed", components: [{ domain: { value: "mind_body" } }], completedTrainingSessionId: "workout-1" }] as CalendarSession[];

function renderTimeline() {
  const client = new QueryClient();
  client.setQueryData(["sessions"], [session, unmatched, mixed]);
  client.setQueryData(["calendar", "timeline"], planned);
  client.setQueryData(["current-plan"], null);
  client.setQueryData(["profile"], profile);
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Timeline)));
}

describe("Training history", () => {
  it("renders compact plan markers and exposes matching and deletion through every row menu", () => {
    const html = renderTimeline();
    expect(html).toContain("Training history");
    expect(html).toContain("Search workouts...");
    expect(html).toContain("Date &amp; time");
    expect(html).toContain("Plan Matched");
    expect(html).not.toContain("Matched to Plan");
    expect(html).toContain("Morning Stretch");
    expect(html).toContain("Mind-body");
    expect(html).not.toContain("Time not recorded");
    expect(html).not.toContain("No confident match");
    expect(html).not.toContain("No planned session");
    expect(html).toContain('class="training-plan-mark matched"');
    expect(html).toContain('aria-label="Easy Run is not matched to a planned session"');
    expect(html).toContain(">-</option>");
    expect(html).toContain('aria-label="Change type for Morning Stretch"');
    expect(html).toContain('aria-label="Change type for Morning Stretch">Mind-body</button>');
    expect(html).toContain("Manual");
    expect(html.match(/<div class="training-source-cell"><span>Manual<\/span><\/div>/g)).toHaveLength(1);
    expect(html.match(/<div class="training-source-cell"><span>Intervals\.icu<\/span><\/div>/g)).toHaveLength(2);
    expect(html).toContain("Daily Mobility - v2");
    expect(html).toContain("Edit manual details");
    expect(html).toContain("Remove manual source");
    expect(html.match(/Delete record/g)).toHaveLength(3);
    expect(html.match(/class="training-row-menu"/g)).toHaveLength(3);
    expect(html).not.toContain("training-row-menu-disabled");
    expect(html).not.toContain("training-row-editor");
    expect(html).toContain("Showing 1–3 of 3 sessions");
  });
});
