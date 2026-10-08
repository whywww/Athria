import { describe, expect, it, vi } from "vitest";
import { dismissWeeklyReview, loadScheduledReview, reviewWeek } from "./weekly-review";
import type { AdjustmentReminder } from "./view-models";

function storage() {
  const entries = new Map<string, string>();
  return { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}
const weekly: AdjustmentReminder = {
  assessment: { trigger: "weekly_review", reviewStatus: "watch", recommendedScope: "none", reasons: [{ reasonCode: "KEY_SESSION_MISSED", severity: "soft", evidenceRefs: ["s1"], affectedScope: "week" }], hardOverrides: [], dataGaps: [], currentPlanRevision: 1, profileHash: "profile", inputSnapshotHash: "snapshot", suggestedReadWindow: 1 },
  idempotencyContext: "weekly", showReminder: true,
};
const keep: AdjustmentReminder = { ...weekly, assessment: { ...weekly.assessment, trigger: "profile_change", reviewStatus: "keep", reasons: [] }, showReminder: false };

describe("first opening weekly review", () => {
  it("uses Monday boundaries across year changes and late openings", () => {
    expect(reviewWeek("2026-10-05")).toBe("2026-10-05");
    expect(reviewWeek("2026-10-11")).toBe("2026-10-05");
    expect(reviewWeek("2027-01-01")).toBe("2026-12-28");
  });

  it("reviews once per database/week, retains the result, and persists dismissal across reopening", async () => {
    const saved = storage();
    const request = vi.fn(async (reviewedWeek: string | null) => reviewedWeek ? keep : weekly);
    expect(await loadScheduledReview(saved, "db", "2026-10-07", request)).toEqual(weekly);
    expect(await loadScheduledReview(saved, "db", "2026-10-09", request)).toEqual(weekly);
    expect(request.mock.calls).toEqual([[null], ["2026-10-05"]]);
    dismissWeeklyReview(saved, "db", weekly);
    expect((await loadScheduledReview(saved, "db", "2026-10-10", request)).showReminder).toBe(false);
    await loadScheduledReview(saved, "db", "2026-10-12", request);
    await loadScheduledReview(saved, "other-db", "2026-10-12", request);
    expect(request.mock.calls.slice(-2)).toEqual([[null], [null]]);
  });

  it("does not mark failed reviews as done and deduplicates concurrent openings", async () => {
    const saved = storage();
    await expect(loadScheduledReview(saved, "retry", "2026-10-07", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    const request = vi.fn(async () => weekly);
    await Promise.all([loadScheduledReview(saved, "retry", "2026-10-07", request), loadScheduledReview(saved, "retry", "2026-10-07", request)]);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(null);
  });

  it("keeps fresh conflicts visible and does not reuse a weekly result after the plan changes", async () => {
    const saved = storage();
    await loadScheduledReview(saved, "changes", "2026-10-07", async () => weekly);
    const conflict = { ...keep, showReminder: true, assessment: { ...keep.assessment, reviewStatus: "review_required" as const } };
    expect(await loadScheduledReview(saved, "changes", "2026-10-08", async () => conflict)).toEqual(conflict);
    const newPlan = { ...keep, assessment: { ...keep.assessment, currentPlanRevision: 2 } };
    expect(await loadScheduledReview(saved, "changes", "2026-10-09", async () => newPlan)).toEqual(newPlan);
  });
});
