import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustmentNotification, createAdjustmentNotifications } from "./adjustment-notifications";
import { LanguageProvider } from "./i18n";
import { dismissToast, notify, ToastProvider } from "./toasts";
import { adjustmentReasonMessage, type AdjustmentReminder } from "./view-models";

const reminder: AdjustmentReminder = {
  assessment: { trigger: "weekly_review", reviewStatus: "watch", recommendedScope: "week", reasons: [{ reasonCode: "KEY_SESSION_MISSED", severity: "strong", evidenceRefs: [], affectedScope: "week" }], hardOverrides: [], dataGaps: [], currentPlanRevision: 1, inputSnapshotHash: "snapshot", profileHash: "profile", suggestedReadWindow: 1 },
  idempotencyContext: "review", showReminder: true,
};
const managers: ReturnType<typeof createAdjustmentNotifications>[] = [];
const manager = () => { const value = createAdjustmentNotifications(); managers.push(value); return value; };
const render = (page = "Overview") => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ToastProvider, null, page)));
afterEach(() => {
  managers.splice(0).forEach((value) => value.clear());
  vi.useRealTimers(); vi.unstubAllGlobals();
  render();
});

describe("persistent adjustment notifications", () => {
  it("selects the strongest reason and maps review tiers to toast kinds", () => {
    const assessment = { ...reminder.assessment, reasons: [{ reasonCode: "ADHERENCE_MINOR_DEVIATION", severity: "soft" as const, evidenceRefs: [], affectedScope: "none" as const }, ...reminder.assessment.reasons] };
    expect(adjustmentNotification(assessment)).toEqual({ message: "Last week's review: You missed a key session last week.", kind: "info" });
    expect(adjustmentNotification({ ...assessment, reviewStatus: "review_recommended" })?.kind).toBe("warning");
    expect(adjustmentNotification({ ...assessment, reviewStatus: "review_required" })?.kind).toBe("error");
    expect(adjustmentNotification({ ...assessment, reasons: [] })).toBeNull();
    expect(adjustmentNotification({ ...assessment, reviewStatus: "keep" })).toBeNull();
    expect(adjustmentNotification({ ...assessment, reasons: [{ ...assessment.reasons[0]!, reasonCode: "SOME_NEW_SIGNAL" }] })?.message).toContain("Some New Signal");
    expect(adjustmentReasonMessage(reminder.assessment.reasons[0]!)).toBe("You missed a key session this week.");
  });

  it("uses changed-conditions copy even for soft weekly profile conflicts", () => {
    const value = adjustmentNotification({ ...reminder.assessment, reasons: [{ ...reminder.assessment.reasons[0]!, reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT", severity: "soft" }] });
    expect(value?.message).toBe("Plan conditions changed: Your preferred weekly training rhythm differs from this plan. Ask your AI assistant to adjust the plan.");
  });

  it("adds the localized suggestion only to training rhythm conflicts", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    render();
    const assessment = { ...reminder.assessment, trigger: "profile_change" as const, reasons: [{ ...reminder.assessment.reasons[0]!, reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT" }] };
    expect(adjustmentNotification(assessment)?.message).toBe("计划条件发生变化： 你偏好的每周训练节奏与计划不一致。 建议让 AI 助手调整计划。");
    expect(adjustmentNotification({ ...assessment, reasons: [{ ...assessment.reasons[0]!, reasonCode: "PROFILE_EQUIPMENT_CONFLICT" }] })?.message).not.toContain("建议让 AI 助手调整计划");
    expect(adjustmentNotification(reminder.assessment)?.message).not.toContain("建议让 AI 助手调整计划");
  });

  it("preserves reason domains and stays silent for missing evidence alone", () => {
    expect(adjustmentNotification({ ...reminder.assessment, reasons: [{ ...reminder.assessment.reasons[0]!, affectedDomain: "endurance" }] })?.message).toBe("Last week's review: You missed a key Endurance session last week.");
    expect(adjustmentNotification({ ...reminder.assessment, reasons: [], dataGaps: [{ code: "WELLNESS_EVIDENCE_MISSING", evidenceRefs: [] }] })).toBeNull();
    expect(adjustmentReasonMessage({ ...reminder.assessment.reasons[0]!, reasonCode: "PROFILE_EQUIPMENT_CONFLICT", affectedDomain: "strength" })).toBe("Some planned exercises need equipment you no longer have.");
  });

  it("survives time, page changes and ordinary toast traffic without duplicates", () => {
    vi.useFakeTimers();
    const value = manager();
    value.sync("navigation", reminder, vi.fn());
    value.sync("navigation", { ...reminder }, vi.fn());
    for (let index = 0; index < 5; index++) notify(`ordinary ${index}`);
    expect(render("Plan").match(/toast-persistent/g)).toHaveLength(1);
    expect(render()).not.toContain("ordinary 0");
    vi.advanceTimersByTime(10_000);
    expect(render("Settings")).toContain("Last week&#x27;s review:");
    expect(render()).not.toContain("ordinary");
  });

  it("updates localized text and removes invalid reminders and old databases", () => {
    const value = manager();
    value.sync("language", reminder, vi.fn());
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    render();
    value.sync("language", reminder, vi.fn());
    expect(render()).toContain("上周复盘：");
    expect(render()).not.toContain("评估本周是否需要调整");
    expect(render()).toContain("关闭通知");
    vi.stubGlobal("localStorage", { getItem: () => "en" });
    render();
    value.sync("language", reminder, vi.fn());
    expect(render()).toContain("Last week&#x27;s review:");
    expect(render()).not.toContain("上周复盘");
    value.sync("language", undefined, vi.fn());
    expect(render()).toContain("toast-persistent");
    value.sync("language", { ...reminder, showReminder: false }, vi.fn());
    expect(render()).not.toContain("toast-persistent");
    value.sync("language", reminder, vi.fn());
    value.sync("other-database", undefined, vi.fn());
    expect(render()).not.toContain("toast-persistent");
  });

  it("replaces reminders without recording a manual dismissal", () => {
    const value = manager(); const close = vi.fn();
    value.sync("replace", reminder, close);
    value.sync("replace", { ...reminder, idempotencyContext: "new", assessment: { ...reminder.assessment, reviewStatus: "review_required" } }, close);
    expect(render().match(/toast-persistent/g)).toHaveLength(1);
    expect(render()).toContain("toast-error");
    expect(close).not.toHaveBeenCalled();
    value.clear();
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps manual dismissal through refreshes and remounts, isolated by database", () => {
    const value = manager(); const close = vi.fn();
    const conflict = { ...reminder, assessment: { ...reminder.assessment, trigger: "profile_change" as const } };
    value.sync("dismissal", conflict, close);
    const id = notify("updated", "info", { persistent: true, key: `adjustment:${JSON.stringify(["dismissal", reminder.idempotencyContext])}`, onDismiss: () => close() })!;
    // Restore the manager's close handler after finding the existing toast by its stable key.
    value.sync("dismissal", conflict, close);
    dismissToast(id, true);
    expect(close).toHaveBeenCalledOnce();
    value.sync("dismissal", conflict, close);
    manager().sync("dismissal", conflict, close);
    expect(render()).not.toContain("toast-persistent");
    value.sync("different", conflict, close);
    expect(render()).toContain("toast-persistent");
  });
});
