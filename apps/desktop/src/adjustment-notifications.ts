import { tr } from "./i18n";
import { dismissToast, notify, type ToastKind } from "./toasts";
import { adjustmentReasonMessage, type AdjustmentAssessment, type AdjustmentReminder } from "./view-models";

const severityRank = { hard: 0, strong: 1, soft: 2, info: 3 } as const;
const noticeCopy = {
  watch: "Weekly check:",
  review_recommended: "Ask your agent to review the plan:",
  review_required: "Plan review required — ask your agent:",
} as const;
const weeklyPrefix = "Last week's review:";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const storageKey = (databaseUuid: string) => `athria:adjustment-dismissed:${databaseUuid}`;

export function adjustmentToastKey(databaseUuid: string, messageKey: string): string {
  return `adjustment:${databaseUuid}:${messageKey}`;
}

export function adjustmentNotification(value: AdjustmentAssessment): { message: string; kind: ToastKind; weekly: boolean; key: string } | null {
  const reason = [...value.reasons].sort((left, right) => severityRank[left.severity] - severityRank[right.severity])[0];
  if (!reason || value.reviewStatus === "keep") return null;
  const conditionChanged = reason.reasonCode.startsWith("PROFILE_") || ["GOAL_PLAN_INTENT_DRIFT", "RACE_TARGET_PLAN_INTENT_DRIFT", "PREFERENCE_CHANGED", "MESOCYCLE_DURATION_PREFERENCE_CHANGED"].includes(reason.reasonCode);
  const prefix = conditionChanged ? "Plan conditions changed:" : value.trigger === "weekly_review" ? weeklyPrefix : noticeCopy[value.reviewStatus];
  const suggestion = reason.reasonCode === "PROFILE_TRAINING_RHYTHM_CONFLICT" ? ` ${tr("Ask your AI assistant to adjust the plan.")}` : "";
  const kind = value.reviewStatus === "review_required" ? "error" : value.reviewStatus === "review_recommended" ? "warning" : "info";
  return {
    message: `${tr(prefix)} ${adjustmentReasonMessage(reason, value.trigger === "weekly_review")}${suggestion}`,
    kind,
    weekly: prefix === weeklyPrefix,
    key: JSON.stringify([prefix, reason.reasonCode, reason.affectedDomain ?? "", kind]),
  };
}

/** Identity of what the user read; volatile hashes and language must not change it. */
function readDismissed(storage: StorageLike | null, databaseUuid: string): Set<string> {
  try {
    const saved = JSON.parse(storage?.getItem(storageKey(databaseUuid)) ?? "null");
    return new Set(Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : []);
  } catch { return new Set(); }
}

function writeDismissed(storage: StorageLike | null, databaseUuid: string, messageKey: string): void {
  const dismissed = readDismissed(storage, databaseUuid);
  dismissed.add(messageKey);
  try { storage?.setItem(storageKey(databaseUuid), JSON.stringify([...dismissed])); } catch { /* Storage can be disabled. */ }
}

/** One app-level slot; pending refreshes retain the current reminder. */
export function createAdjustmentNotifications(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage) {
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
      const notification = reminder.showReminder ? adjustmentNotification(reminder.assessment) : null;
      if (!notification || (!notification.weekly && readDismissed(storage, databaseUuid).has(notification.key))) { clear(); return; }
      const toastKey = adjustmentToastKey(databaseUuid, notification.key);
      if (activeKey !== toastKey) clear();
      activeKey = toastKey;
      toastId = notify(notification.message, notification.kind, {
        persistent: true, key: toastKey,
        onDismiss: () => {
          if (!notification.weekly) writeDismissed(storage, databaseUuid, notification.key);
          onDismiss();
        },
      });
    },
  };
}
