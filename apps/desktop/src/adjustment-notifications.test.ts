import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adjustmentNotification, adjustmentToastKey, createAdjustmentNotifications } from "./adjustment-notifications";
import { LanguageProvider } from "./i18n";
import { dismissToast, notify, ToastProvider } from "./toasts";
import { adjustmentReasonMessage, type AdjustmentAssessment, type AdjustmentReminder } from "./view-models";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
function storage() {
  const entries = new Map<string, string>();
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); } };
}
const reminder: AdjustmentReminder = {
  assessment: { trigger: "weekly_review", reviewStatus: "watch", recommendedScope: "week", reasons: [{ reasonCode: "KEY_SESSION_MISSED", severity: "strong", evidenceRefs: [], affectedScope: "week" }], hardOverrides: [], dataGaps: [], currentPlanRevision: 1, inputSnapshotHash: "snapshot", profileHash: "profile", suggestedReadWindow: 1 },
  idempotencyContext: "review", showReminder: true,
};
const conditionConflict = (assessment: Partial<AdjustmentAssessment> = {}): AdjustmentReminder => ({
  ...reminder, idempotencyContext: "conflict",
  assessment: { ...reminder.assessment, trigger: "profile_change", reviewStatus: "review_required", reasons: [{ reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT", severity: "hard", evidenceRefs: [], affectedScope: "plan" }], hardOverrides: ["PROFILE_CONSTRAINT_CONFLICT"], ...assessment },
});
const managers: ReturnType<typeof createAdjustmentNotifications>[] = [];
const manager = (saved: StorageLike | null = null) => { const value = createAdjustmentNotifications(saved); managers.push(value); return value; };
const userDismiss = (value: ReturnType<typeof createAdjustmentNotifications>, databaseUuid: string, dismissed: AdjustmentReminder, close: () => void) => {
  const id = notify("probe", "info", { persistent: true, key: adjustmentToastKey(databaseUuid, adjustmentNotification(dismissed.assessment)!.key) })!;
  value.sync(databaseUuid, dismissed, close);
  dismissToast(id, true);
};
const render = (page = "Overview") => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ToastProvider, null, page)));
afterEach(() => {
  managers.splice(0).forEach((value) => value.clear());
  vi.useRealTimers(); vi.unstubAllGlobals();
  render();
});

describe("persistent adjustment notifications", () => {
  it("selects the strongest reason and maps review tiers to toast kinds", () => {
    const assessment = { ...reminder.assessment, reasons: [{ reasonCode: "ADHERENCE_MINOR_DEVIATION", severity: "soft" as const, evidenceRefs: [], affectedScope: "none" as const }, ...reminder.assessment.reasons] };
    expect(adjustmentNotification(assessment)).toEqual({ message: "Last week's review: You missed a key session last week.", kind: "info", weekly: true, key: JSON.stringify(["Last week's review:", "KEY_SESSION_MISSED", "", "info"]) });
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

  it("gives structural rhythm conflicts distinct copy and identity", () => {
    const soft = { ...reminder.assessment, trigger: "profile_change" as const, reviewStatus: "watch" as const, reasons: [{ reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT", severity: "soft" as const, evidenceRefs: [], affectedScope: "none" as const }] };
    const hard = { ...soft, reviewStatus: "review_required" as const, reasons: [{ ...soft.reasons[0]!, severity: "hard" as const, affectedScope: "plan" as const }] };
    expect(adjustmentNotification(soft)).toMatchObject({ message: "Plan conditions changed: Your preferred weekly training rhythm differs from this plan. Ask your AI assistant to adjust the plan.", weekly: false });
    expect(adjustmentNotification(hard)).toMatchObject({ message: "Plan conditions changed: The plan's schedule conflicts with your weekly training rhythm. Ask your AI assistant to adjust the plan.", kind: "error" });
    expect(adjustmentNotification(soft)!.key).not.toBe(adjustmentNotification(hard)!.key);
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    render();
    expect(adjustmentNotification(soft)?.message).toContain("你偏好的每周训练节奏与计划不一致。");
    expect(adjustmentNotification(hard)?.message).toContain("计划的排期与你的每周训练节奏冲突。");
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
    const saved = storage();
    const value = manager(saved); const close = vi.fn();
    value.sync("replace", conditionConflict(), close);
    value.sync("replace", conditionConflict({ reasons: [{ reasonCode: "PROFILE_EQUIPMENT_CONFLICT", severity: "hard", evidenceRefs: [], affectedScope: "week" }] }), close);
    expect(render().match(/toast-persistent/g)).toHaveLength(1);
    expect(render()).toContain("toast-error");
    expect(close).not.toHaveBeenCalled();
    expect(saved.entries.size).toBe(0);
    value.clear();
    expect(close).not.toHaveBeenCalled();
  });

  it("keeps dismissal through content updates, remounts and other databases", () => {
    const saved = storage(); const close = vi.fn();
    const conflict = conditionConflict();
    const value = manager(saved);
    value.sync("dismissal", conflict, close);
    userDismiss(value, "dismissal", conflict, close);
    expect(close).toHaveBeenCalledOnce();
    expect([...saved.entries]).toEqual([["athria:adjustment-dismissed:dismissal", JSON.stringify([adjustmentNotification(conflict.assessment)!.key])]]);
    const refreshed = { ...conflict, idempotencyContext: "content-update", assessment: { ...conflict.assessment, inputSnapshotHash: "changed", currentPlanRevision: 2 } };
    value.sync("dismissal", refreshed, close);
    expect(render()).not.toContain("toast-persistent");
    manager(saved).sync("dismissal", refreshed, close);
    expect(render()).not.toContain("toast-persistent");
    value.sync("different", conflict, close);
    expect(render()).toContain("toast-persistent");
    expect(saved.entries.size).toBe(1);
  });

  it("re-surfaces once per severity level and stays silent within a level", () => {
    const saved = storage(); const close = vi.fn();
    const soft = conditionConflict({ reviewStatus: "watch", hardOverrides: [], reasons: [{ reasonCode: "PROFILE_TRAINING_RHYTHM_CONFLICT", severity: "soft", evidenceRefs: [], affectedScope: "none" }] });
    const value = manager(saved);
    value.sync("escalation", soft, close);
    userDismiss(value, "escalation", soft, close);
    value.sync("escalation", { ...soft, idempotencyContext: "same-level-again" }, close);
    expect(render()).not.toContain("toast-persistent");
    const warned = { ...soft, idempotencyContext: "warned", assessment: { ...soft.assessment, reviewStatus: "review_recommended" as const } };
    value.sync("escalation", warned, close);
    expect(render()).toContain("toast-warning");
    userDismiss(value, "escalation", warned, close);
    const hard = conditionConflict();
    value.sync("escalation", hard, close);
    expect(render()).toContain("toast-error");
    expect(render()).toContain("conflicts with your weekly training rhythm");
    userDismiss(value, "escalation", hard, close);
    value.sync("escalation", { ...hard, idempotencyContext: "hard-again" }, close);
    expect(render()).not.toContain("toast-persistent");
  });

  it("leaves weekly reviews to the week-scoped record", () => {
    const saved = storage(); const close = vi.fn();
    const value = manager(saved);
    value.sync("weekly", reminder, close);
    userDismiss(value, "weekly", reminder, close);
    expect(saved.entries.size).toBe(0);
    value.sync("weekly", { ...reminder, idempotencyContext: "next-week" }, close);
    expect(render()).toContain("toast-persistent");
  });

  it("tolerates unavailable or corrupt storage", () => {
    const broken = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); } };
    const close = vi.fn();
    const conflict = conditionConflict();
    const value = manager(broken);
    value.sync("broken", conflict, close);
    userDismiss(value, "broken", conflict, close);
    expect(close).toHaveBeenCalledOnce();
    value.sync("broken", conflict, close);
    expect(render()).toContain("toast-persistent");
  });
});
