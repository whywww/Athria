import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CalendarSession, CurrentPlan, PlanComponent, PlanExercise } from "../view-models";
import { WeeklyCalendar } from "./WeeklyCalendar";

const plan: CurrentPlan = {
  planSchemaVersion: "7.0",
  ownerId: "local-user",
  title: "Calendar test plan",
  summary: "",
  effectiveStartDate: "2026-09-07",
  mesocycle: {
    durationWeeks: 1,
    schedule: { kind: "fixed_week", days: [1] },
    domainProgressions: [],
    weeks: [],
    adjustmentRules: [],
  },
  revision: 1,
  sourceAgent: null,
  model: null,
  skillVersion: null,
  inputSnapshotHash: null,
  updatedAt: "2026-09-07T00:00:00Z",
};

function session(id: string, scheduledDate: string, overrides: Partial<CalendarSession> = {}): CalendarSession {
  return {
    id,
    occurrenceId: `occ-${id}`,
    revision: 1,
    scheduledDate,
    order: 0,
    weekNumber: 1,
    phaseRefs: [],
    templateRef: null,
    name: `Session ${id}`,
    intent: "Test calendar presentation",
    durationMinutes: 45,
    recoveryDemand: "normal",
    keySession: false,
    progressionNote: null,
    schedulingRationale: null,
    status: "planned",
    components: [],
    legacySnapshot: false,
    overrideReason: null,
    ...overrides,
  };
}

function component(domain: NonNullable<PlanComponent["domain"]["value"]>, prescription: PlanComponent["prescription"] = { kind: "duration_only", notes: "" }): PlanComponent {
  return {
    id: `component-${domain}`,
    name: domain,
    domain: { value: domain, source: "agent", confidence: 1, evidence: "test", taxonomyVersion: "1" },
    prescription,
  };
}

function render(sessions: CalendarSession[]): string {
  return renderToStaticMarkup(createElement(WeeklyCalendar, {
    plan,
    sessions,
    templates: [],
    today: "2026-09-09",
    onSelectSession: () => undefined,
  }));
}

function sessionMarkup(html: string, id: string): string {
  return html.match(new RegExp(`<button[^>]*data-session-id="${id}"[\\s\\S]*?</button>`))?.[0] ?? "";
}

describe("WeeklyCalendar", () => {
  it("matches the compact reference hierarchy for the range, week, and day headings", () => {
    const html = render([]);

    expect(html).toContain("Sep 7 – 13 (1 week)");
    expect(html).toContain("W1 · Sep 7 – 13");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('class="wc-day-weekday">Mon');
    expect(html).toContain('class="wc-day-date">Sep 7');
    expect(html).toContain('data-icon="rest"');
  });

  it("uses domain icons, domain tone classes, and compact reliable week totals", () => {
    const html = render([
      session("endurance", "2026-09-07", { durationMinutes: 40, components: [component("endurance")] }),
      session("strength", "2026-09-08", { components: [component("strength", { kind: "strength", exercises: [{ sets: 4 } as PlanExercise, { sets: 4 } as PlanExercise] })] }),
    ]);

    expect(sessionMarkup(html, "endurance")).toContain("tone-endurance");
    expect(sessionMarkup(html, "endurance")).toContain('data-domain-icon="endurance"');
    expect(sessionMarkup(html, "strength")).toContain("tone-strength");
    expect(sessionMarkup(html, "strength")).toContain('data-domain-icon="strength"');
    expect(html).toContain('class="wc-week-summary">40 min · 8 sets');
  });

  it("uses status lights for completed and unrecorded sessions while planned stays unmarked", () => {
    const html = render([
      session("completed", "2026-09-07", { status: "completed", displayState: "completed" }),
      session("unrecorded", "2026-09-08", { displayState: "unrecorded" }),
      session("planned", "2026-09-09", { displayState: "scheduled" }),
      session("skipped", "2026-09-10", { status: "skipped", displayState: "skipped" }),
    ]);

    expect(html).toContain('class="wc-status-legend"');
    expect(html).toContain("Completed");
    expect(html).toContain("Unrecorded");
    expect(sessionMarkup(html, "completed")).toContain("wc-status-light status-completed");
    expect(sessionMarkup(html, "completed")).not.toContain("wc-badge");
    expect(sessionMarkup(html, "unrecorded")).toContain("wc-status-light status-unrecorded");
    expect(sessionMarkup(html, "unrecorded")).not.toContain("wc-badge");
    expect(sessionMarkup(html, "planned")).not.toContain("wc-status-light");
    expect(sessionMarkup(html, "planned")).not.toContain("wc-badge");
    expect(sessionMarkup(html, "planned")).toContain('aria-pressed="false"');
    expect(sessionMarkup(html, "skipped")).toContain('class="wc-badge badge-skipped">Skipped');
  });

  it("groups domains separately from an intact long duration and status", () => {
    const html = render([session("long", "2026-09-08", {
      name: "Long Easy Aerobic Session With An Unbroken Descriptive Name",
      durationMinutes: 65,
      displayState: "unrecorded",
      components: [component("endurance"), component("strength")],
    })]);
    const chip = sessionMarkup(html, "long");

    expect(chip).toContain('class="wc-chip-domains"');
    expect(chip).toContain('data-domain-icon="endurance"');
    expect(chip).toContain('data-domain-icon="strength"');
    expect(chip).toContain('class="wc-duration">1 hr 5 min');
    expect(chip).toContain("wc-status-light status-unrecorded");
    expect(chip.indexOf("wc-chip-domains")).toBeLessThan(chip.indexOf("wc-status-light status-unrecorded"));
    expect(chip.indexOf("wc-status-light status-unrecorded")).toBeLessThan(chip.indexOf("wc-chip-meta"));
  });

  it("keeps the existing overflow affordance when a day has more than three sessions", () => {
    const html = render([1, 2, 3, 4].map((number) => session(`overflow-${number}`, "2026-09-09")));

    expect(html).toContain("+2 more");
    expect(html).toContain('data-session-id="overflow-1"');
    expect(html).toContain('data-session-id="overflow-2"');
    expect(html).not.toContain('data-session-id="overflow-3"');
  });
});
