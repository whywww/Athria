import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntervalsSyncIssues, XunjiSyncIssues } from "./App";

describe("Intervals sync feedback", () => {
  it("shows failed dates, undated activities and endpoint errors", () => {
    const html = renderToStaticMarkup(createElement(IntervalsSyncIssues, { report: {
      failedDates: [{ date: "2026-08-15", failures: [{ activityId: "ride-1", reason: "No valid start time" }] }],
      undatedFailures: [{ activityId: "ride-2", reason: "No valid start time" }],
      errors: { wellness: "HTTP 500" },
    } }));
    expect(html).toContain("2026-08-15");
    expect(html).toContain("ride-1");
    expect(html).toContain("Unknown date");
    expect(html).toContain("ride-2");
    expect(html).toContain("wellness");
    expect(html).toContain("HTTP 500");
  });

  it("renders nothing when a sync has no issues", () => {
    expect(renderToStaticMarkup(createElement(IntervalsSyncIssues, { report: {} }))).toBe("");
  });
});

describe("SynFit sync feedback", () => {
  it("shows the saved failure reason when all requested dates fail", () => {
    const html = renderToStaticMarkup(createElement(XunjiSyncIssues, { sync: {
      lastAttemptAt: "2026-09-30T00:00:00Z", lastSuccessAt: null,
      rangeStart: "2026-09-29", rangeEnd: "2026-09-30", status: "failed",
      data: { failedDays: 2, errors: [{ code: "request_failed", message: "HTTP 429" }, { code: "request_failed", message: "HTTP 429" }] },
    } }));
    expect(html).toContain("Failed days");
    expect(html).toContain("2");
    expect(html).toContain("HTTP 429");
    expect(html.match(/HTTP 429/g)).toHaveLength(1);
  });

  it("hides failure details after a successful sync", () => {
    expect(renderToStaticMarkup(createElement(XunjiSyncIssues, { sync: {
      lastAttemptAt: "2026-09-30T00:00:00Z", lastSuccessAt: "2026-09-30T00:00:00Z",
      rangeStart: "2026-09-29", rangeEnd: "2026-09-30", status: "success",
      data: { failedDays: 0, errors: [] },
    } }))).toBe("");
  });
});
