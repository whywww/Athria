import { tr } from "./i18n";
import { dismissToast, notify, type ToastKind } from "./toasts";
import { adjustmentReasonMessage, type AdjustmentAssessment, type AdjustmentReminder } from "./view-models";

const severityRank = { hard: 0, strong: 1, soft: 2, info: 3 } as const;
const noticeCopy = {
  watch: "Weekly check:",
  review_recommended: "Ask your agent to review the plan:",
  review_required: "Plan review required — ask your agent:",
} as const;
const dismissed = new Set<string>();

export function adjustmentNotification(value: AdjustmentAssessment): { message: string; kind: ToastKind } | null {
  const reason = [...value.reasons].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0];
  if (!reason || value.reviewStatus === "keep") return null;
  const conditionChanged = reason.reasonCode.startsWith("PROFILE_") || ["GOAL_PLAN_INTENT_DRIFT", "RACE_TARGET_PLAN_INTENT_DRIFT", "PREFERENCE_CHANGED", "MESOCYCLE_DURATION_PREFERENCE_CHANGED"].includes(reason.reasonCode);
  const prefix = conditionChanged ? "Plan conditions changed:" : value.trigger === "weekly_review" ? "Last week's review:" : noticeCopy[value.reviewStatus];
  const suggestion = reason.reasonCode === "PROFILE_TRAINING_RHYTHM_CONFLICT" ? ` ${tr("Ask your AI assistant to adjust the plan.")}` : "";
  return {
    message: `${tr(prefix)} ${adjustmentReasonMessage(reason, value.trigger === "weekly_review")}${suggestion}`,
    kind: value.reviewStatus === "review_required" ? "error" : value.reviewStatus === "review_recommended" ? "warning" : "info",
  };
}

/** One app-level slot; pending refreshes retain the current reminder. */
export function createAdjustmentNotifications() {
  let database: string | undefined;
  let activeKey: string | undefined;
  let toastId: number | undefined;
  const clear = () => {
    if (toastId !== undefined) dismissToast(toastId);
    toastId = undefined;
    activeKey = undefined;
  };
  return {
    clear,
    sync(databaseUuid: string | undefined, reminder: AdjustmentReminder | undefined, onDismiss: () => void) {
      if (database !== databaseUuid) { clear(); database = databaseUuid; }
      if (!databaseUuid || !reminder) return;
      const key = JSON.stringify([databaseUuid, reminder.idempotencyContext]);
      const notification = reminder.showReminder ? adjustmentNotification(reminder.assessment) : null;
      if (!notification || dismissed.has(key)) { clear(); return; }
      if (activeKey !== key) clear();
      activeKey = key;
      toastId = notify(notification.message, notification.kind, {
        persistent: true, key: `adjustment:${key}`,
        onDismiss: () => { dismissed.add(key); onDismiss(); },
      });
    },
  };
}
