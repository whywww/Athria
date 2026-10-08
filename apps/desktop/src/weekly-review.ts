import { addDays, weekdayIndex } from "./plan/view";
import type { AdjustmentReminder } from "./view-models";

type ReviewRecord = { week: string; reminder: AdjustmentReminder; dismissed?: boolean };
type ReviewStorage = Pick<Storage, "getItem" | "setItem">;
const storageKey = (databaseUuid: string) => `athria:weekly-review:${databaseUuid}`;
const pending = new Map<string, Promise<AdjustmentReminder>>();
export const reviewWeek = (today: string) => addDays(today, -weekdayIndex(today));

function readRecord(storage: ReviewStorage, databaseUuid: string): ReviewRecord | null {
  try {
    const value = JSON.parse(storage.getItem(storageKey(databaseUuid)) ?? "null") as ReviewRecord | null;
    return value && typeof value.week === "string" && value.reminder?.assessment && typeof value.reminder.showReminder === "boolean" ? value : null;
  } catch { return null; }
}

/** Persist only successful reviews; a failed request is retried on the next opening. */
export async function loadScheduledReview(storage: ReviewStorage, databaseUuid: string, today: string, request: (reviewedWeek: string | null) => Promise<AdjustmentReminder>): Promise<AdjustmentReminder> {
  const key = `${databaseUuid}:${reviewWeek(today)}`;
  const active = pending.get(key);
  if (active) return active;
  const work = loadReview(storage, databaseUuid, today, request);
  pending.set(key, work);
  try { return await work; }
  finally { pending.delete(key); }
}

async function loadReview(storage: ReviewStorage, databaseUuid: string, today: string, request: (reviewedWeek: string | null) => Promise<AdjustmentReminder>): Promise<AdjustmentReminder> {
  const week = reviewWeek(today);
  const saved = readRecord(storage, databaseUuid);
  const reviewed = saved?.week === week;
  const fresh = await request(reviewed ? week : null);
  if (fresh.assessment.trigger === "weekly_review") {
    storage.setItem(storageKey(databaseUuid), JSON.stringify({ week, reminder: fresh } satisfies ReviewRecord));
    return fresh;
  }
  // Keep the initial weekly result visible until dismissed or the plan/Profile changes.
  if (reviewed && !fresh.showReminder && saved.reminder.assessment.currentPlanRevision === fresh.assessment.currentPlanRevision && saved.reminder.assessment.profileHash === fresh.assessment.profileHash) {
    return { ...saved.reminder, showReminder: saved.reminder.showReminder && !saved.dismissed };
  }
  return fresh;
}

export function dismissWeeklyReview(storage: ReviewStorage, databaseUuid: string, reminder: AdjustmentReminder): void {
  const saved = readRecord(storage, databaseUuid);
  if (saved?.reminder.idempotencyContext === reminder.idempotencyContext) {
    storage.setItem(storageKey(databaseUuid), JSON.stringify({ ...saved, dismissed: true }));
  }
}
